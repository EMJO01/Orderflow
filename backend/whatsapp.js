const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');

const connections = {};
const qrCodes = {};

async function connectVendor(vendorId, vendorName) {
  if (connections[vendorId]?.isReady) {
    console.log(`✅ Vendor ${vendorName} already connected`);
    return;
  }

  const authFolder = path.join(__dirname, 'auth_info', String(vendorId));
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false
  });

  connections[vendorId] = { sock, isReady: false };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(`QR ready for vendor: ${vendorName}`);
      qrCodes[vendorId] = qr;
    }

    if (connection === 'open') {
      console.log(`✅ ${vendorName} WhatsApp connected!`);
      connections[vendorId].isReady = true;
      qrCodes[vendorId] = null;

      if (vendorId !== 'owner') {
        const supabase = require('./db');
        await supabase.from('vendors').update({ whatsapp_connected: true }).eq('id', vendorId);
      }
    }

    if (connection === 'close') {
      connections[vendorId].isReady = false;
      const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`${vendorName} disconnected. Reconnecting: ${shouldReconnect}`);

      if (vendorId !== 'owner') {
        const supabase = require('./db');
        await supabase.from('vendors').update({ whatsapp_connected: false }).eq('id', vendorId);
      }

      if (shouldReconnect) {
        setTimeout(() => connectVendor(vendorId, vendorName), 3000);
      }
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

    console.log(`[${vendorName}] Message from ${from}: ${text}`);

    try {
      const supabase = require('./db');
      const { generateReply } = require('./ai');

      // 1. Fetch vendor details FIRST
      const { data: vendor } = await supabase
        .from('vendors')
        .select('country, bot_instructions')
        .eq('id', vendorId)
        .single();

      // 2. Fetch this vendor's active products
      let query = supabase.from('products').select('*').eq('active', true);
      if (vendorId !== 'owner') query = query.eq('vendor_id', vendorId);
      const { data: products } = await query;

      // 3. Generate and send reply
      const reply = await generateReply(
        text,
        products || [],
        vendorName,
        vendor?.country || 'Nigeria',
        vendor?.bot_instructions || ''
      );

      await sock.sendMessage(from, { text: reply });
      console.log(`[${vendorName}] Replied: ${reply}`);
    } catch (err) {
      console.error(`[${vendorName}] Reply error:`, err.message);
    }
  });
}

function getQR(vendorId) {
  return qrCodes[vendorId] || null;
}

async function sendWhatsApp(vendorId, to, message) {
  const conn = connections[vendorId];
  if (!conn?.isReady) throw new Error(`Vendor ${vendorId} WhatsApp not connected`);
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
  await conn.sock.sendMessage(jid, { text: message });
}

module.exports = { connectVendor, getQR, sendWhatsApp };