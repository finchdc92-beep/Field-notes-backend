require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // photos are base64, need headroom

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

// Content moderation for forum posts/comments. Sends the text to Claude for
// classification and returns { flagged: true/false }. Blocks sexual content
// (the app's own requirement) and, as a safety net, other clearly abusive content.
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
          content: `You are a content moderation filter for a gardening app's community forum. Decide if the following user-submitted text should be BLOCKED. Block it if it contains sexual content, sexual solicitation, or content clearly unrelated/inappropriate for a gardening community (harassment, hate speech, spam links). Do NOT block normal gardening talk, even if blunt or informal. Respond with ONLY the single word "BLOCK" or "ALLOW" — nothing else.

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Field Notes backend running on port ${PORT}`));
