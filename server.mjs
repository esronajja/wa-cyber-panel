import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, delay } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import P from 'pino';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

let sock = null;
let latestQR = null;
let isConnected = false;
let autoReplyConfig = { enabled: false, keyword: '', response: '' };

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  
  sock = makeWASocket({
    auth: state, logger: P({ level: 'silent' }), printQRInTerminal: false,
    browser: ["ESRON Panel", "Chrome", "2.0.0"]
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      latestQR = await QRCode.toDataURL(qr);
      isConnected = false;
      io.emit('qr', latestQR);
    }
    if (connection === 'close') {
      isConnected = false;
      io.emit('status', 'DISCONNECTED');
      if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) setTimeout(connectToWhatsApp, 3000);
    } else if (connection === 'open') {
      isConnected = true;
      latestQR = null;
      io.emit('status', 'CONNECTED');
      io.emit('log', '[SYSTEM] WhatsApp Premium Client Connected!');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const sender = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (text) {
      io.emit('log', `[INCOMING] ${sender.split('@')[0]}: ${text}`);
      if (autoReplyConfig.enabled && text.toLowerCase().includes(autoReplyConfig.keyword.toLowerCase())) {
        await sock.sendMessage(sender, { text: autoReplyConfig.response });
        io.emit('log', `[BOT] Auto-Replied to ${sender.split('@')[0]}`);
      }
    }
  });
}

app.get('/api/status', (req, res) => res.json({ connected: isConnected, qr: latestQR }));

app.post('/api/send', async (req, res) => {
  if (!isConnected || !sock) return res.status(503).json({ error: 'WA Offline' });
  const { target, message, mediaUrl } = req.body;
  try {
    const jid = target.includes('@') ? target : `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    if (mediaUrl) await sock.sendMessage(jid, { image: { url: mediaUrl }, caption: message || '' });
    else await sock.sendMessage(jid, { text: message });
    io.emit('log', `[OUTGOING] ${jid.split('@')[0]}: ${message || '[Media]'}`);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/broadcast', async (req, res) => {
  if (!isConnected || !sock) return res.status(503).json({ error: 'WA Offline' });
  const { targets, message, delayMs } = req.body;
  res.json({ success: true });
  io.emit('log', `[BROADCAST] Started to ${targets.length} targets...`);
  for (let i = 0; i < targets.length; i++) {
    try {
      await sock.sendMessage(`${targets[i].replace(/[^0-9]/g, '')}@s.whatsapp.net`, { text: message });
      io.emit('log', `[BROADCAST] [${i+1}/${targets.length}] OK: ${targets[i]}`);
    } catch (err) { io.emit('log', `[BROADCAST] [${i+1}/${targets.length}] FAIL: ${targets[i]}`); }
    await delay(delayMs || 3000);
  }
  io.emit('log', `[BROADCAST] Done.`);
});

app.post('/api/autoreply/config', (req, res) => {
  autoReplyConfig = req.body;
  io.emit('log', `[SYSTEM] Auto-Reply ${autoReplyConfig.enabled ? 'ON' : 'OFF'}`);
  res.json({ success: true });
});

app.get('/api/groups', async (req, res) => {
  if (!isConnected || !sock) return res.status(503).json({ error: 'WA Offline' });
  try {
    const groups = await sock.groupFetchAllParticipating();
    res.json({ groups: Object.values(groups).map(g => ({ id: g.id, subject: g.subject, participants: g.participants.length })) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/logout', async (req, res) => {
  if (sock) { await sock.logout(); isConnected = false; io.emit('status', 'DISCONNECTED'); }
  res.json({ success: true });
});

io.on('connection', (socket) => {
  socket.emit('status', isConnected ? 'CONNECTED' : 'DISCONNECTED');
  if (latestQR && !isConnected) socket.emit('qr', latestQR);
});

httpServer.listen(3000, '0.0.0.0', () => {
  console.log('PREMIUM PANEL RUNNING ON http://localhost:3000');
  connectToWhatsApp();
});
