require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const clients = new Set();

// ---- ffmpeg -> Zeno Icecast ----
// ياخذ صوت Nova (ulaw 8000) ويحوّله MP3 ويدفعه مباشرة لـ Zeno
let ffmpeg = null;

function startZenoStream() {
  const zenoUrl =
    `icecast://${process.env.ZENO_USERNAME}:${process.env.ZENO_PASSWORD}` +
    `@${process.env.ZENO_HOST}:${process.env.ZENO_PORT}${process.env.ZENO_MOUNT}`;

  ffmpeg = spawn(ffmpegPath, [
    '-f', 'mulaw',          // صيغة الدخل من Nova
    '-ar', '8000',          // معدل العينة
    '-ac', '1',             // قناة واحدة (mono)
    '-i', 'pipe:0',         // الدخل من stdin
    '-c:a', 'libmp3lame',   // ترميز MP3
    '-b:a', '128k',         // البت ريت
    '-ar', '44100',         // معدل عينة مناسب للراديو
    '-content_type', 'audio/mpeg',
    '-f', 'mp3',
    zenoUrl
  ]);

  ffmpeg.stderr.on('data', (d) => console.log('ffmpeg:', d.toString()));
  ffmpeg.on('close', (code) => {
    console.log(`ffmpeg انتهى (code ${code}) — إعادة تشغيل بعد 3 ثواني`);
    ffmpeg = null;
    setTimeout(startZenoStream, 3000); // إعادة تشغيل تلقائية لو وقف
  });
  ffmpeg.on('error', (e) => console.error('ffmpeg error:', e.message));

  console.log('بدأ بث Zeno عبر ffmpeg');
}

startZenoStream();

// ---- Twilio incoming call ----
app.post('/incoming-call', (req, res) => {
  const twilio = require('twilio');
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({ url: `wss://${process.env.SERVER_DOMAIN}/media-stream`, track: 'both_tracks' });
  res.type('text/xml');
  res.send(twiml.toString());
});

// ---- منفذ بث احتياطي عبر HTTP (اختياري) ----
app.get('/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Connection': 'keep-alive' });
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/status', (req, res) => {
  res.json({
    status: 'ALLUP FM Running',
    zeno: ffmpeg ? 'streaming' : 'down',
    listeners: clients.size
  });
});

// ---- WebSocket: Twilio <-> Nova ----
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

        // 1) ادفع صوت Nova لـ Zeno عبر ffmpeg
        if (ffmpeg && ffmpeg.stdin.writable) {
          try { ffmpeg.stdin.write(buf); } catch (e) {}
        }

        // 2) (اختياري) ادفعه لأي مستمع على /stream
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
