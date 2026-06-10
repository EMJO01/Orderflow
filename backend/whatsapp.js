const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { useSupabaseAuthState } = require('./auth-supabase');

const connections = {};
const qrCodes = {};
const conversationHistory = {};
const MAX_HISTORY = 10;
const reEngagementTrackers = {};
const RE_ENGAGE_DELAY_MS = 30 * 60 * 1000;

function getHistory(vendorId, from) {
  if (!conversationHistory[vendorId]) conversationHistory[vendorId] = {};
  if (!conversationHistory[vendorId][from]) conversationHistory[vendorId][from] = [];
  return conversationHistory[vendorId][from];
}

function addToHistory(vendorId, from, role, content) {
  const history = getHistory(vendorId, from);
  history.push({ role, content });
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
        const lastMsg = history[history.length - 1];
        if (lastMsg.role === 'assistant') return;
        const { generateReEngageReply } = require('./ai');
        const nudge = await generateReEngageReply(vendorName, products, country, botInstructions);
        await sock.sendMessage(from, { text: nudge });
        console.log(`[${vendorName}] Re-engagement sent to ${from}`);
        addToHistory(vendorId, from, 'assistant', nudge);
      } catch (err) {
        console.error(`[${vendorName}] Re-engage error:`, err.message);
      }
    }, RE_ENGAGE_DELAY_MS)
  };
}

async function clearSession(vendorId) {
  try {
    const supabase = require('./db');
    await supabase.from('whatsapp_sessions').delete().eq('vendor_id', String(vendorId));
    console.log(`[Auth] Cleared session for vendor ${vendorId}`);
  } catch (e) {
    console.error(`[Auth] Could not clear session:`, e.message);
  }
}

async function connectVendor(vendorId, vendorName) {
  if (connections[vendorId]?.isReady) {
    console.log(`✅ Vendor ${vendorName} already connected`);
    return;
  }

  if (connections[vendorId]?.sock) {
    try { connections[vendorId].sock.end(); } catch(e) {}
    delete connections[vendorId];
  }

  const { state, saveCreds } = await useSupabaseAuthState(vendorId);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 2000
  });

  connections[vendorId] = { sock, isReady: false };

  // Save creds every time they update
  sock.ev.on('creds.update', async () => {
    console.log(`[Auth] creds.update fired for vendor ${vendorId} — saving...`);
    await saveCreds();
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(`QR ready for vendor: ${vendorName}`);
      qrCodes[vendorId] = qr;
    }

    if (connection === 'open') {
      console.log(`✅ ${vendorName} WhatsApp connected!`);
      connections[vendorId].isReady = true;
      qrCodes[vendorId] = null;

      // Save session immediately on successful connection
      await saveCreds();

      if (vendorId !== 'owner') {
        const supabase = require('./db');
        await supabase.from('vendors').update({ whatsapp_connected: true }).eq('id', vendorId);
      }
    }

    if (connection === 'close') {
      connections[vendorId].isReady = false;
      const statusCode    = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`${vendorName} disconnected. Code: ${statusCode}. Reconnecting: ${shouldReconnect}`);

      if (vendorId !== 'owner') {
        const supabase = require('./db');
        await supabase.from('vendors').update({ whatsapp_connected: false }).eq('id', vendorId);
      }

      // 515 = restart required after pairing — save BEFORE reconnecting
      if (statusCode === 515) {
        console.log(`[${vendorName}] Code 515 restart — saving session before reconnect`);
        await saveCreds();
      }

      // Logged out — clear session so next connect starts fresh with new QR
      if (statusCode === DisconnectReason.loggedOut) {
        console.log(`[${vendorName}] Logged out — clearing saved session`);
        await clearSession(vendorId);
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
      const { generateReply, extractOrder, cleanReply } = require('./ai');

      const { data: vendor } = await supabase
        .from('vendors')
        .select('country, bot_instructions, whatsapp_number')
        .eq('id', vendorId)
        .single();

      let query = supabase.from('products').select('*').eq('active', true);
      if (vendorId !== 'owner') query = query.eq('vendor_id', vendorId);
      const { data: products } = await query;

      const country         = vendor?.country         || 'Nigeria';
      const botInstructions = vendor?.bot_instructions || '';

      addToHistory(vendorId, from, 'user', text);

      const history  = getHistory(vendorId, from);
      const rawReply = await generateReply(history, products || [], vendorName, country, botInstructions);

      const orderData   = extractOrder(rawReply);
      const replyToSend = cleanReply(rawReply);

      if (replyToSend) {
        await sock.sendMessage(from, { text: replyToSend });
        console.log(`[${vendorName}] Replied: ${replyToSend}`);
      }

      addToHistory(vendorId, from, 'assistant', replyToSend || rawReply);

      if (orderData) {
        console.log(`[${vendorName}] Order detected:`, orderData);
        await supabase.from('orders').insert([{
          vendor_id:        vendorId === 'owner' ? null : parseInt(vendorId),
          customer_phone:   from.replace('@s.whatsapp.net', '').replace('@lid', ''),
          customer_name:    orderData.name    || 'Unknown',
          items:            orderData.items   || '',
          total_price:      orderData.total   || 0,
          delivery_address: orderData.address || '',
          status:           'pending'
        }]);

        if (vendor?.whatsapp_number && connections[vendorId]?.isReady) {
          const vendorJid = vendor.whatsapp_number.replace(/\D/g, '') + '@s.whatsapp.net';
          const notification =
`🛍️ *New Order Alert!*

👤 Customer: ${orderData.name    || 'Unknown'}
📦 Items: ${orderData.items      || 'N/A'}
💰 Total: ${orderData.total      || 0}
📍 Address: ${orderData.address  || 'N/A'}
📞 Phone: ${from.replace('@s.whatsapp.net', '').replace('@lid', '')}

Reply to the customer directly to confirm delivery details.`;
          try {
            await sock.sendMessage(vendorJid, { text: notification });
            console.log(`[${vendorName}] Vendor notified of new order`);
          } catch (notifyErr) {
            console.error(`[${vendorName}] Could not notify vendor:`, notifyErr.message);
          }
        }
      }

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