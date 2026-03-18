require('dotenv').config();
const express = require('express');
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
  }
  res.json({ ok: true });
});

app.post('/scan-events', async (req, res) => {
  try {
    const data = await scanYborEvents();
    res.json(data);
  } catch (err) {
    console.error('Full error:', JSON.stringify(err, null, 2));
    res.status(500).json({ error: 'Scan failed', detail: err.message });
  }
});

async function scanYborEvents() {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: 'You are a bar traffic assistant for a bartender in Ybor City Tampa FL. Search for events tonight in Ybor City. Return ONLY a JSON object, no markdown, no explanation: {"shift_verdict":"one sentence outlook","events":[{"name":"event","time":"time","location":"venue","crowd_score":85,"traffic_level":"high","reasoning":"why this affects bar traffic"}]}',
      messages: [{ role: 'user', content: `What events are happening in Ybor City Tampa tonight ${today}? Return only JSON.` }]
    })
  });

  const result = await response.json();
  console.log('API response type:', result.type);
  console.log('Content blocks:', result.content?.map(b => b.type));

  const textBlock = result.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in response: ' + JSON.stringify(result.content));
  const clean = textBlock.text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

async function sendShiftAlert() {
  if (pushTokens.length === 0) return;
  const data = await scanYborEvents();
  const highEvents = data.events.filter(e => e.traffic_level === 'high');
  const body = highEvents.length > 0 ? `Tonight: ${highEvents[0].name} — expect a busy shift` : data.shift_verdict;
  const messages = pushTokens.map(token => ({ to: token, sound: 'default', title: 'Ybor Intel', body, data: { scan: data } }));
  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) { await expo.sendPushNotificationsAsync(chunk); }
}

cron.schedule('0 15 * * *', () => sendShiftAlert());
app.listen(3000, () => console.log('Ybor Intel backend running on port 3000'));
