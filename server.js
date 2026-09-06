require('dotenv').config();
const express = require('express');
const cors = require('cors');

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

app.get('/health', (req, res) => res.json({ ok: true }));

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
app.post('/moderate', async (req, res) => {
  try {
    const { text } = req.body;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
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
app.listen(PORT, () => console.log(`Field Notes backend running on port ${PORT}`));
