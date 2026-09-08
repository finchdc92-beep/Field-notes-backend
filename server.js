require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Explicit, permissive CORS config (rather than relying on cors()'s bare
// defaults) plus an explicit OPTIONS handler for every route, so preflight
// requests can never silently fail before reaching a real route.
const corsOptions = {
  origin: true, // reflect the request's Origin header — allow any site to call this API
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '15mb' })); // photos are base64, need headroom

// Logs every incoming request so Render's logs show definitively whether a
// request ever arrived here at all — useful for telling "never reached the
// server" apart from "reached it and failed."
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in your .env file — the /identify endpoint will fail without it.');
}

// Admin-level Supabase access, used only for the watering-reminder cron
// check — this bypasses row-level security entirely, so it never touches
// user input directly and is never exposed to the frontend.
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:finchdc92@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Best-effort weather check via Open-Meteo (free, no API key needed) — used
// to push a watering reminder out a day or two if it's rained recently.
// This is a simple rule of thumb, not real soil-moisture modeling.
async function recentRainfallMm(lat, lng) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=precipitation_sum&past_days=2&forecast_days=1&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const sums = (data.daily && data.daily.precipitation_sum) || [];
    return sums.reduce((a, b) => a + (b || 0), 0);
  } catch (err) {
    return null;
  }
}

// The app sends: { image_base64, media_type, prompt }
// This is the only place the real API key ever touches the network.
app.post('/identify', async (req, res) => {
  try {
    const { image_base64, media_type, prompt } = req.body;
    if (!image_base64 || !prompt) {
      return res.status(400).json({ error: 'image_base64 and prompt are required' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1600,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image_base64 } },
              { type: 'text', text: prompt }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(502).json({ error: 'Identification service failed. Please try again.' });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

const nodemailer = require('nodemailer');

app.get('/health', (req, res) => res.json({ ok: true }));

// Frontend calls this after the person grants notification permission, to
// save their subscription so the cron check can find them later.
app.post('/push-subscribe', async (req, res) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Push notifications are not configured on the server yet.' });
    const { user_id, subscription } = req.body;
    if (!user_id || !subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'user_id and subscription are required' });
    }
    const { error } = await supabaseAdmin.from('push_subscriptions').upsert({
      user_id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth
    }, { onConflict: 'endpoint' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('push-subscribe error:', err);
    res.status(500).json({ error: 'Could not save that subscription.' });
  }
});

// The actual scheduled check — an external free cron service (see setup
// notes) pings this once an hour. It is NOT triggered by anything inside
// this server, since Render's free tier sleeps when idle and can't reliably
// wake itself up on a timer. Protected by a shared secret so randoms on the
// internet can't trigger it or spam your users.
app.get('/cron/check-watering', async (req, res) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Not configured.' });
    if (!process.env.CRON_SECRET || req.query.secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const nowUtcHour = new Date().getUTCHours();
    const todayStr = new Date().toISOString().slice(0, 10);

    const { data: schedules, error: schedErr } = await supabaseAdmin
      .from('watering_schedules')
      .select('*')
      .eq('active', true);
    if (schedErr) throw schedErr;

    let checked = 0, notified = 0;
    for (const s of (schedules || [])) {
      checked++;
      // Only fire once, at (roughly) the hour the person picked, and only once per day.
      if (s.reminder_hour !== nowUtcHour) continue;
      if (s.last_notified_date === todayStr) continue;

      const lastWatered = new Date(s.last_watered + 'T00:00:00Z');
      const daysSince = Math.floor((Date.now() - lastWatered.getTime()) / 86400000);
      let dueInDays = s.water_interval_days - daysSince;

      if (s.use_weather && typeof s.lat === 'number' && typeof s.lng === 'number') {
        const rainMm = await recentRainfallMm(s.lat, s.lng);
        // Meaningful recent rain (5mm+) buys the plant a couple of extra days.
        if (typeof rainMm === 'number' && rainMm >= 5) dueInDays += 2;
      }

      if (dueInDays > 0) continue; // not due yet

      const { data: subs, error: subErr } = await supabaseAdmin
        .from('push_subscriptions')
        .select('*')
        .eq('user_id', s.user_id);
      if (subErr || !subs || subs.length === 0) continue;

      const payload = JSON.stringify({
        title: '💧 Time to water',
        body: `${s.plant_name} is due for a drink.`,
        url: '/'
      });

      for (const sub of subs) {
        try {
          await webpush.sendNotification({
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth }
          }, payload);
        } catch (pushErr) {
          // A 410/404 means that device unsubscribed or the subscription
          // expired — clean it up so we stop trying it every hour.
          if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
            await supabaseAdmin.from('push_subscriptions').delete().eq('id', sub.id);
          }
        }
      }
      await supabaseAdmin.from('watering_schedules').update({ last_notified_date: todayStr }).eq('id', s.id);
      notified++;
    }

    res.json({ ok: true, checked, notified });
  } catch (err) {
    console.error('check-watering error:', err);
    res.status(500).json({ error: 'Cron check failed.' });
  }
});

// Contact Support — sends the message straight to your inbox via Gmail.
// The destination address lives only here, in an environment variable on
// Render, and is never sent to or visible from the app itself.
const contactTransporter = process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD }
    })
  : null;

app.post('/contact', async (req, res) => {
  try {
    const { category, message, fromUsername } = req.body;
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    if (!contactTransporter) {
      console.error('Contact form used but EMAIL_USER/EMAIL_APP_PASSWORD are not set.');
      return res.status(500).json({ error: 'Contact form is not configured yet.' });
    }
    await contactTransporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER,
      replyTo: process.env.EMAIL_USER,
      subject: `Field Notes — ${category || 'Message'} from ${fromUsername || 'a visitor'}`,
      text: `Category: ${category || '(not specified)'}\nFrom: ${fromUsername || '(not signed in)'}\n\n${message.trim()}`
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Contact form error:', err);
    res.status(500).json({ error: 'Could not send that right now. Please try again.' });
  }
});

// Text-only lookup for the search feature — same idea as /identify, but
// there's no photo. Used when someone searches for a plant/pest/disease/
// rodent that isn't in the app's built-in library, so the AI can look it
// up from its own knowledge instead.
app.post('/lookup', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1600,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(502).json({ error: 'Lookup service failed. Please try again.' });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Content moderation for forum posts/comments. Sends the text to Claude for
// classification and returns { flagged: true/false }. Blocks sexual content
// (the app's own requirement), hate speech, threats, and targeted harassment,
// but explicitly allows casual trash-talk/ribbing between users — this is a
// gardening community for real people, not a zero-tolerance forum.
// Catches obfuscated slurs/hate speech before it even reaches the AI check —
// people trying to sneak past a filter often swap letters for lookalike
// symbols/numbers (e.g. "1" for "i", "@" for "a") or add stray punctuation.
// This collapses that back down to plain letters first, so the disguise
// doesn't work.
function normalizeForModeration(text) {
  return text
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/6/g, 'g')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/!/g, 'i')
    .replace(/\|/g, 'i')
    .replace(/[^a-z]/g, ''); // strip spaces, punctuation, symbols, repeated-char breaks
}

// Root forms of slurs/hate terms to catch even when disguised with symbol
// substitution. Kept intentionally short and root-based (not exhaustive) —
// the normalization step above does most of the work by removing the
// disguise, so this just needs the plain underlying word.
const BLOCKED_TERM_ROOTS = [
  'nigger', 'nigga', 'chink', 'spic', 'kike', 'gook', 'wetback', 'beaner',
  'faggot', 'fag', 'tranny', 'retard', 'retarded', 'cripple',
  'cunt'
];

function containsBlockedTerm(text) {
  const normalized = normalizeForModeration(text);
  return BLOCKED_TERM_ROOTS.some(term => normalized.includes(term));
}

app.post('/moderate', async (req, res) => {
  try {
    const { text } = req.body;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }

    // Fast, reliable pre-check — if it trips this, block immediately
    // without even spending an AI call on it.
    if (containsBlockedTerm(text)) {
      return res.json({ flagged: true });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 20,
        messages: [{
          role: 'user',
          content: `You are a content moderation filter for a gardening app's community forum. Decide if the following user-submitted text should be BLOCKED.

Block it if it contains: sexual content or sexual solicitation; hate speech or slurs targeting a protected group; genuine threats of violence; repeated or severe bullying clearly meant to actually hurt someone; spam or scam links; or content clearly unrelated/inappropriate for a gardening community.

Do NOT block: normal gardening talk, even if blunt or informal; mild trash-talk, ribbing, or joking insults between users. This is a casual community, not a zero-tolerance forum, so give the benefit of the doubt on short, single-word, or low-context messages. For example, ALLOW messages like "Loser!", "You're lame", "dummy", "idiot", "lol you're the worst" — these read as casual ribbing between people who know each other, not as harassment, even with no other context attached. Only BLOCK this kind of language if it's clearly severe, targets a protected characteristic, or is part of a genuinely threatening or sustained pattern.

Respond with ONLY the single word "BLOCK" or "ALLOW" — nothing else.

Text to review:
"""
${text.slice(0, 2000)}
"""`
        }]
      })
    });
    if (!response.ok) {
      // If moderation itself fails, fail closed (block) rather than let unchecked content through.
      return res.json({ flagged: true, reason: 'moderation_unavailable' });
    }
    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const verdict = (textBlock && textBlock.text || '').trim().toUpperCase();
    res.json({ flagged: verdict.startsWith('BLOCK') });
  } catch (err) {
    console.error('Moderation error:', err);
    res.json({ flagged: true, reason: 'moderation_error' });
  }
});

// Image moderation for forum post photos. Uses Claude's vision to screen for
// nudity/sexual content before an uploaded photo is ever stored or shown in
// the feed. Fails closed (blocks) if the check itself can't complete.
app.post('/moderate-image', async (req, res) => {
  try {
    const { image_base64, media_type } = req.body;
    if (!image_base64) {
      return res.status(400).json({ error: 'image_base64 is required' });
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 20,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image_base64 } },
            {
              type: 'text',
              text: `You are a content moderation filter for a gardening app's community photo feed. Decide if this image should be BLOCKED. Block it if it contains nudity, sexual content, or sexually suggestive imagery of any kind. Do NOT block normal photos of plants, gardens, pests, yards, food, or people fully clothed in ordinary settings, even if unrelated to gardening. Respond with ONLY the single word "BLOCK" or "ALLOW" — nothing else.`
            }
          ]
        }]
      })
    });
    if (!response.ok) {
      return res.json({ flagged: true, reason: 'moderation_unavailable' });
    }
    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const verdict = (textBlock && textBlock.text || '').trim().toUpperCase();
    res.json({ flagged: verdict.startsWith('BLOCK') });
  } catch (err) {
    console.error('Image moderation error:', err);
    res.json({ flagged: true, reason: 'moderation_error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Field Notes backend running on port ${PORT}`))
