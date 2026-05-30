const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');

let sock = null;
let isReady = false;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(__dirname, 'auth_info')
  );

  sock = makeWASocket({ 
    auth: state, 
    printQRInTerminal: true,
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('QR CODE READY — scan from WhatsApp');
      global.latestQR = qr;
    }
    if (connection === 'open') {
      console.log('✅ WhatsApp connected!');
      isReady = true;
    }
    if (connection === 'close') {
      isReady = false;
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) connectToWhatsApp();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    if (!from || from === 'status@broadcast') return;

    const text = msg.message?.conversation ||
                 msg.message?.extendedTextMessage?.text || '';

    if (!text) return;

    console.log(`Message from ${from}: ${text}`);

    try {
      const supabase = require('./db');
      const { generateReply } = require('./ai');

      const { data: products } = await supabase
        .from('products')
        .select('*')
        .eq('active', true);

      const reply = await generateReply(text, products || []);
      await sock.sendMessage(from, { text: reply });
      console.log(`Replied: ${reply}`);
    } catch (err) {
      console.error('Reply error:', err.message);
    }
  });
}

async function sendWhatsApp(to, message) {
  if (!sock || !isReady) throw new Error('WhatsApp not connected yet');
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: message });
}

module.exports = { connectToWhatsApp, sendWhatsApp };