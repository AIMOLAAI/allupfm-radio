require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const clients = new Set();

app.post('/incoming-call', (req, res) => {
  const twilio = require('twilio');
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({ url: `wss://${process.env.SERVER_DOMAIN}/media-stream`, track: 'both_tracks' });
  res.type('text/xml');
  res.send(twiml.toString());
});

app.get('/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Connection': 'keep-alive' });
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/status', (req, res) => {
  res.json({ status: 'ALLUP FM Running', listeners: clients.size });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (ws) => {
  const novaWs = new WebSocket(
    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.ELEVENLABS_AGENT_ID}`,
    { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
  );

  novaWs.on('open', () => {
    novaWs.send(JSON.stringify({
      type: 'conversation_initiation_client_data',
      conversation_config_override: {
        agent: {
          first_message: 'أهلاً! أنا نوفا على راديو ALLUP FM! أنتم على الهواء مباشرة!',
          language: 'ar'
        },
        asr: { user_input_audio_format: 'ulaw_8000' },
        tts: { agent_output_audio_format: 'ulaw_8000' }
      }
    }));
  });

  novaWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'audio' && msg.audio_event?.audio_base_64) {
        const buf = Buffer.from(msg.audio_event.audio_base_64, 'base64');
        clients.forEach(c => { try { c.write(buf); } catch(e) { clients.delete(c); } });
      }
    } catch(e) {}
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.event === 'media' && novaWs.readyState === WebSocket.OPEN) {
        novaWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
      }
    } catch(e) {}
  });

  ws.on('close', () => novaWs.close());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ALLUP FM on port ${PORT}`));
