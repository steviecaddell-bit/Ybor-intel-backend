const express = require('express');require('dotenv').config();
const cors = require('cors');
const cron = require('node-cron');
const { Expo } = require('expo-server-sdk');

const app = express();
const expo = new Expo();
app.use(cors());
app.use(express.json());

let pushTokens = [];

app.post('/register-token', (req, res) => {
  const { token } = req.body;
  if (Expo.isExpoPushToken(token) && !pushTokens.includes(token)) {
    pushTokens.push(token);
    console.log('Token registered:', token);
  }
  res.json({ ok: true });
});

app.post('/scan-events', async (req, res) => {
  try {
    const data = await scanYborEvents();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Scan failed' });
  }
});

async function scanYborEvents() {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `You are a bar traffic intelligence assistant for a bartender in Ybor City, Tampa FL. Today is ${today}. Search for events tonight in Ybor City and return ONLY valid JSON, no markdown, no explanation:
{
  "shift_verdict": "one sentence overall outlook for bar business tonight",
  "events": [
    {
      "name": "event name",
      "time": "time",
      "location": "venue or area",
      "crowd_score": 85,
      "traffic_level": "high",
      "reasoning": "why this affects bar traffic"
    }
  ]
}
traffic_level must be exactly "high", "medium", or "low". crowd_score is 0-100. Rank by crowd_score descending. Return ONLY the JSON object.`,
      messages: [{ role: 'user', content: `What events are happening in Ybor City tonight, ${today}? Give me the bar traffic prediction JSON.` }]
    })
  });

  const raw = await response.text();
console.log('Anthropic raw response:', raw);

let result;
try {
  result = JSON.parse(raw);
} catch (err) {
  throw new Error('Anthropic returned non-JSON: ' + raw);
}

if (!response.ok) {
  throw new Error(`Anthropic API error ${response.status}: ${raw}`);
}

if (!Array.isArray(result.content)) {
  throw new Error('Anthropic response missing content array: ' + raw);
}

console.log('API response type:', result.type);
console.log('Content blocks:', result.content.map(b => b.type));

const textBlock = result.content.find(b => b.type === 'text');
if (!textBlock || !textBlock.text) {
  throw new Error('No text block in response: ' + raw);
}

const clean = textBlock.text.replace(/```json|```/g, '').trim();
return JSON.parse(clean);
}

async function sendShiftAlert() {
  if (pushTokens.length === 0) {
    console.log('No tokens registered yet.');
    return;
  }
  try {
    const data = await scanYborEvents();
    const highEvents = data.events.filter(e => e.traffic_level === 'high');
    const body = highEvents.length > 0
      ? `Tonight: ${highEvents[0].name} — expect a busy shift`
      : data.shift_verdict;

    const messages = pushTokens.map(token => ({
      to: token,
      sound: 'default',
      title: 'Ybor Intel — Shift Alert',
      body,
      data: { scan: data }
    }));

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
    console.log('Shift alert sent.');
  } catch (err) {
    console.error('Push failed:', err);
  }
}

// Fires at 3pm daily — adjust the hour to match his schedule
cron.schedule('0 15 * * *', () => {
  console.log('Running scheduled shift alert...');
  sendShiftAlert();
});

app.listen(3000, () => console.log('Ybor Intel backend running on port 3000'));
