const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let currentQR = null;
let connectionStatus = 'disconnected'; // disconnected | qr | connecting | connected
let sock = null;

// ===== FAQ Auto-Reply =====
async function findFaqReply(companyId, messageText) {
  try {
    const { rows } = await pool.query(
      'SELECT keyword, answer FROM "WhatsappFaq" WHERE "accountId" = $1 ORDER BY "createdAt" ASC',
      [companyId]
    );
    const lowerText = (messageText || '').toLowerCase();
    for (const row of rows) {
      if (row.keyword && lowerText.includes(row.keyword.toLowerCase())) {
        return row.answer;
      }
    }
    return null;
  } catch (e) {
    console.error('FAQ lookup error:', e);
    return null;
  }
}

// ===== Company sessions storage =====
// companyId -> { sock, status, qr, autoReply, companyName }
const sessions = {};

async function startSession(companyId, companyName = 'الشركة', autoReply = true) {
  if (sessions[companyId]?.status === 'connected') return;

  const { state, saveCreds } = await useMultiFileAuthState(`./auth_${companyId}`);

  const socket = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Tijara CRM', 'Chrome', '1.0'],
  });

  sessions[companyId] = {
    sock: socket,
    status: 'connecting',
    qr: null,
    autoReply,
    companyName,
  };

  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrDataUrl = await qrcode.toDataURL(qr);
      sessions[companyId].qr = qrDataUrl;
      sessions[companyId].status = 'qr';
      console.log(`[${companyId}] QR ready`);
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;

      sessions[companyId].status = 'disconnected';
      sessions[companyId].qr = null;

      if (shouldReconnect) {
        console.log(`[${companyId}] Reconnecting...`);
        setTimeout(() => startSession(companyId, companyName, autoReply), 3000);
      }
    }

    if (connection === 'open') {
      sessions[companyId].status = 'connected';
      sessions[companyId].qr = null;
      console.log(`[${companyId}] Connected!`);
    }
  });

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      if (!msg || msg.key.fromMe) continue;

      const text = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || '';

      if (!text || !sessions[companyId]?.autoReply) continue;

      const jid = msg.key.remoteJid;

      (async () => {
        try {
          console.log(`[${companyId}] Message from ${jid}: ${text}`);
          const reply = await findFaqReply(companyId, text);
          if (reply) {
            await socket.sendMessage(jid, { text: reply });
            console.log(`[${companyId}] Replied to ${jid}: ${reply}`);
          }
        } catch (err) {
          console.error(`[${companyId}] Error:`, err.message);
        }
      })();
    }
  });
}

// ===== API Routes =====

// Connect / get QR
app.post('/api/connect', async (req, res) => {
  const { companyId, companyName, autoReply } = req.body;
  if (!companyId) return res.status(400).json({ error: 'companyId required' });

  await startSession(companyId, companyName || 'الشركة', autoReply !== false);
  res.json({ status: sessions[companyId]?.status || 'connecting' });
});

// Get QR code
app.get('/api/qr/:companyId', (req, res) => {
  const { companyId } = req.params;
  const session = sessions[companyId];

  if (!session) return res.json({ status: 'not_started', qr: null });

  res.json({
    status: session.status,
    qr: session.qr,
  });
});

// Disconnect
app.post('/api/disconnect', async (req, res) => {
  const { companyId } = req.body;
  const session = sessions[companyId];

  if (session?.sock) {
    await session.sock.logout();
    delete sessions[companyId];
  }

  res.json({ success: true });
});

// Send message manually
app.post('/api/send', async (req, res) => {
  const { companyId, phone, message } = req.body;
  const session = sessions[companyId];

  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Not connected' });
  }

  const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
  await session.sock.sendMessage(jid, { text: message });
  res.json({ success: true });
});

// Toggle auto-reply
app.post('/api/toggle-reply', (req, res) => {
  const { companyId, autoReply } = req.body;
  if (sessions[companyId]) {
    sessions[companyId].autoReply = autoReply;
  }
  res.json({ success: true });
});

// QR Page — HTML page to scan
app.get('/qr-page/:companyId', (req, res) => {
  const { companyId } = req.params;
  const session = sessions[companyId];

  if (!session) {
    startSession(companyId, 'tijara', true);
    return res.send(`<html><head><meta http-equiv="refresh" content="3"></head><body style="font-family:sans-serif;text-align:center;margin-top:100px"><h2>جاري بدء الاتصال...</h2><p>الصفحة ستتحدث تلقائياً</p></body></html>`);
  }

  if (session.status === 'connected') {
    return res.send('<h2 style="color:green;font-family:sans-serif;text-align:center;margin-top:100px">✅ WhatsApp متصل!</h2>');
  }

  if (!session.qr) {
    return res.send(`
      <html><head><meta http-equiv="refresh" content="2"></head>
      <body style="font-family:sans-serif;text-align:center;margin-top:100px">
        <h2>جاري توليد QR Code...</h2>
        <p>الصفحة ستتحدث تلقائياً</p>
      </body></html>
    `);
  }

  res.send(`
    <html>
    <head>
      <meta http-equiv="refresh" content="30">
      <style>
        body { font-family: sans-serif; text-align: center; background: #f0f0f0; padding: 40px; }
        .card { background: white; border-radius: 16px; padding: 32px; display: inline-block; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
        h2 { color: #25D366; }
        p { color: #666; }
        img { border: 4px solid #25D366; border-radius: 8px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>📱 WhatsApp CRM — Tijara</h2>
        <p>افتح WhatsApp → النقاط الثلاث → الأجهزة المرتبطة → ربط جهاز</p>
        <img src="${session.qr}" width="300" height="300">
        <p style="font-size:12px;color:#999">QR Code يتجدد كل 30 ثانية</p>
      </div>
    </body>
    </html>
  `);
});

// Health check (keep alive)
app.get('/health', (req, res) => res.json({ status: 'ok', sessions: Object.keys(sessions).length }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`WhatsApp server running on port ${PORT}`));
