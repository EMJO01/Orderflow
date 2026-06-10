const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');

const connections = {};
const qrCodes = {};

// ── CONVERSATION MEMORY ───────────────────────────────────────────────────────
// Stores last N messages per customer per vendor
// Format: { [vendorId]: { [customerJid]: [ {role, content}, ... ] } }
const conversationHistory = {};
const MAX_HISTORY = 10; // keep last 10 messages

// ── RE-ENGAGEMENT TRACKER ─────────────────────────────────────────────────────
// Tracks last message time per customer per vendor
// Format: { [vendorId]: { [customerJid]: { lastTime, timer, nudged } } }
const reEngagementTrackers = {};
const RE_ENGAGE_DELAY_MS = 30 * 60 * 1000; // 30 minutes

function getHistory(vendorId, from) {
  if (!conversationHistory[vendorId]) conversationHistory[vendorId] = {};
  if (!conversationHistory[vendorId][from]) conversationHistory[vendorId][from] = [];
  return conversationHistory[vendorId][from];
}

function addToHistory(vendorId, from, role, content) {
  const history = getHistory(vendorId, from);
  history.push({ role, content });
  // Keep only last MAX_HISTORY messages
  if (history.length > MAX_HISTORY) {
    conversationHistory[vendorId][from] = history.slice(-MAX_HISTORY);
  }
}

function clearReEngageTimer(vendorId, from) {
  if (reEngagementTrackers[vendorId]?.[from]?.timer) {
    clearTimeout(reEngagementTrackers[vendorId][from].timer);
  }
}

function scheduleReEngage(vendorId, from, sock, vendorName, products, country, botInstructions) {
  clearReEngageTimer(vendorId, from);

  if (!reEngagementTrackers[vendorId]) reEngagementTrackers[vendorId] = {};
  reEngagementTrackers[vendorId][from] = {
    lastTime: Date.now(),
    nudged: false,
    timer: setTimeout(async () => {
      try {
        const tracker = reEngagementTrackers[vendorId]?.[from];
        if (!tracker || tracker.nudged) return;
        tracker.nudged = true;

        const history = getHistory(vendorId, from);
        if (!history.length) return;

        // Only re-engage if last message was from customer (not bot)
        const lastMsg = history[history.length - 1];
        if (lastMsg.role === 'assistant') return;

        const { generateReEngageReply } = require('./ai');
        const nudge = await generateReEngageReply(vendorName, products, country, botInstructions);
        await sock.sendMessage(from, { text: nudge });
        console.log(`[${vendorName}] Re-engagement sent to ${from}`);

        // Add to history
        addToHistory(vendorId, from, 'assistant', nudge);
      } catch (err) {
        console.error(`[${vendorName}] Re-engage error:`, err.message);
      }
    }, RE_ENGAGE_DELAY_MS)
  };
}

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

      // 1. Fetch vendor details
      const { data: vendor } = await supabase
        .from('vendors')
        .select('country, bot_instructions')
        .eq('id', vendorId)
        .single();

      // 2. Fetch this vendor's active products
      let query = supabase.from('products').select('*').eq('active', true);
      if (vendorId !== 'owner') query = query.eq('vendor_id', vendorId);
      const { data: products } = await query;

      const country = vendor?.country || 'Nigeria';
      const botInstructions = vendor?.bot_instructions || '';

      // 3. Add customer message to history
      addToHistory(vendorId, from, 'user', text);

      // 4. Get full conversation history for context
      const history = getHistory(vendorId, from);

      // 5. Generate reply with full history
      const reply = await generateReply(
        history,
        products || [],
        vendorName,
        country,
        botInstructions
      );

      // 6. Send reply
      await sock.sendMessage(from, { text: reply });
      console.log(`[${vendorName}] Replied: ${reply}`);

      // 7. Add bot reply to history
      addToHistory(vendorId, from, 'assistant', reply);

      // 8. Schedule re-engagement if customer goes quiet
      scheduleReEngage(vendorId, from, sock, vendorName, products || [], country, botInstructions);

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