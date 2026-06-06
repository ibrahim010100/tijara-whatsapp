const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Store clients per companyId
const waClients = {};
const waStatus = {};
const conversations = {};

function getOrCreateClient(companyId, socket) {
  if (waClients[companyId]) return waClients[companyId];

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: companyId }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  });

  waStatus[companyId] = 'loading';

  client.on('qr', async (qr) => {
    waStatus[companyId] = 'qr';
    const qrDataUrl = await qrcode.toDataURL(qr);
    io.to(companyId).emit('qr', qrDataUrl);
  });

  client.on('ready', () => {
    waStatus[companyId] = 'ready';
    io.to(companyId).emit('ready', { phone: client.info?.wid?.user });
    console.log(`[${companyId}] WhatsApp ready`);
  });

  client.on('authenticated', () => {
    waStatus[companyId] = 'authenticated';
    io.to(companyId).emit('authenticated');
  });

  client.on('auth_failure', () => {
    waStatus[companyId] = 'auth_failure';
    io.to(companyId).emit('auth_failure');
    delete waClients[companyId];
  });

  client.on('disconnected', () => {
    waStatus[companyId] = 'disconnected';
    io.to(companyId).emit('disconnected');
    delete waClients[companyId];
  });

  client.on('message', async (msg) => {
    if (msg.fromMe) return;
    const contact = await msg.getContact();
    const chat = await msg.getChat();
    const message = {
      id: msg.id.id,
      from: msg.from,
      name: contact.pushname || contact.number,
      body: msg.body,
      timestamp: msg.timestamp,
      fromMe: false,
      chatId: chat.id._serialized,
    };
    if (!conversations[companyId]) conversations[companyId] = {};
    if (!conversations[companyId][chat.id._serialized]) {
      conversations[companyId][chat.id._serialized] = {
        id: chat.id._serialized,
        name: contact.pushname || contact.number,
        phone: contact.number,
        messages: [],
        lastMessage: '',
        lastTime: 0,
        unread: 0,
      };
    }
    conversations[companyId][chat.id._serialized].messages.push(message);
    conversations[companyId][chat.id._serialized].lastMessage = msg.body;
    conversations[companyId][chat.id._serialized].lastTime = msg.timestamp;
    conversations[companyId][chat.id._serialized].unread++;
    io.to(companyId).emit('message', message);
    io.to(companyId).emit('conversations', Object.values(conversations[companyId]));
  });

  client.initialize();
  waClients[companyId] = client;
  return client;
}

// Socket.io
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('join', (companyId) => {
    socket.join(companyId);
    socket.companyId = companyId;
    console.log(`[${companyId}] joined`);

    // Send current status
    const status = waStatus[companyId] || 'disconnected';
    socket.emit('status', status);

    if (status === 'ready') {
      socket.emit('conversations', Object.values(conversations[companyId] || {}));
    }
  });

  socket.on('connect_whatsapp', (companyId) => {
    getOrCreateClient(companyId, socket);
    socket.emit('status', 'loading');
  });

  socket.on('send_message', async ({ companyId, chatId, message }) => {
    const client = waClients[companyId];
    if (!client || waStatus[companyId] !== 'ready') return;
    try {
      await client.sendMessage(chatId, message);
      const msg = {
        id: Date.now().toString(),
        from: 'me',
        body: message,
        timestamp: Math.floor(Date.now() / 1000),
        fromMe: true,
        chatId,
      };
      if (conversations[companyId] && conversations[companyId][chatId]) {
        conversations[companyId][chatId].messages.push(msg);
        conversations[companyId][chatId].lastMessage = message;
        conversations[companyId][chatId].lastTime = msg.timestamp;
      }
      io.to(companyId).emit('message_sent', msg);
      io.to(companyId).emit('conversations', Object.values(conversations[companyId] || {}));
    } catch (e) {
      console.error('Send error:', e);
    }
  });

  socket.on('get_conversations', async (companyId) => {
    const client = waClients[companyId];
    if (!client || waStatus[companyId] !== 'ready') return;
    try {
      const chats = await client.getChats();
      const convs = [];
      for (const chat of chats.slice(0, 30)) {
        const messages = await chat.fetchMessages({ limit: 1 });
        const last = messages[messages.length - 1];
        convs.push({
          id: chat.id._serialized,
          name: chat.name,
          phone: chat.id.user,
          lastMessage: last?.body || '',
          lastTime: last?.timestamp || 0,
          unread: chat.unreadCount,
          messages: [],
        });
      }
      conversations[companyId] = {};
      convs.forEach(c => conversations[companyId][c.id] = c);
      socket.emit('conversations', convs);
    } catch (e) {
      console.error('Get chats error:', e);
    }
  });

  socket.on('get_messages', async ({ companyId, chatId }) => {
    const client = waClients[companyId];
    if (!client || waStatus[companyId] !== 'ready') return;
    try {
      const chat = await client.getChatById(chatId);
      const msgs = await chat.fetchMessages({ limit: 50 });
      const messages = msgs.map(m => ({
        id: m.id.id,
        body: m.body,
        fromMe: m.fromMe,
        timestamp: m.timestamp,
        chatId,
      }));
      if (conversations[companyId] && conversations[companyId][chatId]) {
        conversations[companyId][chatId].messages = messages;
        conversations[companyId][chatId].unread = 0;
      }
      socket.emit('messages', { chatId, messages });
      // Mark as read
      await chat.sendSeen();
    } catch (e) {
      console.error('Get messages error:', e);
    }
  });

  socket.on('logout_whatsapp', async (companyId) => {
    const client = waClients[companyId];
    if (client) {
      await client.logout();
      delete waClients[companyId];
      delete conversations[companyId];
    }
    waStatus[companyId] = 'disconnected';
    io.to(companyId).emit('status', 'disconnected');
  });
});

// REST API
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/status/:companyId', (req, res) => {
  res.json({ status: waStatus[req.params.companyId] || 'disconnected' });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Tijara WhatsApp Server running on port ${PORT}`);
});
