const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { useSupabaseAuthState } = require('./auth-supabase');
const supabase = require('./db');
const ai = require('./ai');

const reconnectTries = {};
const connections = {};
const qrCodes = {};
const conversationHistory = {};
const MAX_HISTORY = 10;

// E-commerce re-engagement (in-memory — known limitation, resets on restart)
const reEngagementTrackers = {};
const RE_ENGAGE_DELAY_MS = 30 * 60 * 1000;
const orderConfirmedState = {};

// Conversations logged once per customer per server session
const loggedConversations = {};

// Real estate follow-ups (persistent — driven by leads.next_followup_at)
const FOLLOWUP_FIRST_HOURS  = 24;
const FOLLOWUP_REPEAT_HOURS = 48;
const FOLLOWUP_MAX          = 2;
const FOLLOWUP_CHECK_MS     = 5 * 60 * 1000;

const VENDOR_FIELDS =
  'country, bot_instructions, whatsapp_number, business_name, product_type, plan, subscription_status, trial_ends_at';

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const hoursFromNow = h => new Date(Date.now() + h * 3600 * 1000).toISOString();
const phoneFromJid = jid => jid.replace('@s.whatsapp.net', '').replace('@lid', '');

// trial_ends_at doubles as "paid until" once a plan is activated.
// Null date = no limit (existing vendors created before billing).
function isSubscriptionExpired(vendor) {
  if (!vendor) return false;
  if (['expired', 'cancelled'].includes(vendor.subscription_status)) return true;
  return !!(vendor.trial_ends_at && new Date(vendor.trial_ends_at) < new Date());
}

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

async function logConversation(vendorId, from) {
  if (vendorId === 'owner') return;
  const convKey = `${vendorId}:${from}`;
  if (loggedConversations[convKey]) return;
  loggedConversations[convKey] = true;
  await supabase.from('conversations').insert([{
    vendor_id:      parseInt(vendorId),
    customer_phone: phoneFromJid(from)
  }]);
}

async function notifyVendorWhatsApp(vendorId, vendor, text) {
  const conn = connections[vendorId];
  if (!vendor?.whatsapp_number || !conn?.isReady) return;
  const jid = vendor.whatsapp_number.replace(/\D/g, '') + '@s.whatsapp.net';
  try {
    await conn.sock.sendMessage(jid, { text });
  } catch (err) {
    console.error(`[Vendor ${vendorId}] Could not notify vendor:`, err.message);
  }
}

// ─── E-COMMERCE RE-ENGAGEMENT (in-memory) ────────────────────────────────────

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
        const nudge = await ai.generateReEngageReply(vendorName, products, country, botInstructions);
        await sock.sendMessage(from, { text: nudge });
        console.log(`[${vendorName}] Re-engagement sent to ${from}`);
        addToHistory(vendorId, from, 'assistant', nudge);
      } catch (err) {
        console.error(`[${vendorName}] Re-engage error:`, err.message);
      }
    }, RE_ENGAGE_DELAY_MS)
  };
}

// ─── SESSION ─────────────────────────────────────────────────────────────────

async function clearSession(vendorId) {
  try {
    await supabase.from('whatsapp_sessions').delete().eq('vendor_id', String(vendorId));
    console.log(`[Auth] Cleared session for vendor ${vendorId}`);
  } catch (e) {
    console.error(`[Auth] Could not clear session:`, e.message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// E-COMMERCE HANDLER
// ═════════════════════════════════════════════════════════════════════════════

async function handleEcommerce({ sock, vendorId, vendorName, from, text, vendor }) {
  let query = supabase.from('products').select('*').eq('active', true);
  if (vendorId !== 'owner') query = query.eq('vendor_id', vendorId);
  const { data: products } = await query;

  const country         = vendor?.country          || 'Nigeria';
  const botInstructions = vendor?.bot_instructions || '';

  await logConversation(vendorId, from);
  addToHistory(vendorId, from, 'user', text);

  const history  = getHistory(vendorId, from);
  const rawReply = await ai.generateReply(history, products || [], vendorName, country, botInstructions);
  console.log(`[${vendorName}] Raw reply: ${rawReply}`);

  const orderData     = ai.extractOrder(rawReply);
  const handoffNeeded = ai.extractHandoff(rawReply);
  const cleanedText   = ai.cleanReply(rawReply);
  const finalReply    = cleanedText || '✅ Order confirmed! Our team will reach out to you shortly 🙌';

  await sock.sendMessage(from, { text: finalReply });
  console.log(`[${vendorName}] Replied: ${finalReply}`);
  addToHistory(vendorId, from, 'assistant', finalReply);

  const customerPhone = phoneFromJid(from);
  const vendorIdVal   = vendorId === 'owner' ? null : parseInt(vendorId);

  if (orderData) {
    if (!orderConfirmedState[vendorId]) orderConfirmedState[vendorId] = {};
    orderConfirmedState[vendorId][from] = true;
    console.log(`[${vendorName}] Order detected:`, orderData);

    const { error: orderError } = await supabase.from('orders').insert([{
      vendor_id:        vendorIdVal,
      customer_phone:   customerPhone,
      customer_name:    orderData.name    || 'Unknown',
      items:            orderData.items   || '',
      total_price:      orderData.total   || 0,
      delivery_address: orderData.address || '',
      status:           'pending'
    }]);
    if (orderError) console.error(`[${vendorName}] Order insert error:`, orderError.message);
    else console.log(`[${vendorName}] Order saved to Supabase ✅`);

    await supabase.from('notifications').insert([{
      vendor_id: vendorIdVal,
      type:      'order',
      message:   `New order from ${orderData.name || 'Unknown'} — ${orderData.items} — ₦${Number(orderData.total || 0).toLocaleString()}`,
      phone:     customerPhone,
      read:      false
    }]);

    await notifyVendorWhatsApp(vendorId, vendor,
`🛍️ *New Order Alert!*

👤 Customer: ${orderData.name    || 'Unknown'}
📦 Items: ${orderData.items      || 'N/A'}
💰 Total: ₦${Number(orderData.total || 0).toLocaleString()}
📍 Address: ${orderData.address  || 'N/A'}
📞 Phone: ${customerPhone}

Reply to the customer directly to confirm delivery details.`);
  }

  if (handoffNeeded) {
    console.log(`[${vendorName}] Handoff requested by ${from}`);
    await supabase.from('notifications').insert([{
      vendor_id: vendorIdVal,
      type:      'handoff',
      message:   `Customer ${customerPhone} wants to speak to a human`,
      phone:     customerPhone,
      read:      false
    }]);
    await notifyVendorWhatsApp(vendorId, vendor,
      `🙋 *Customer Wants to Talk!*\n\nA customer is asking to speak with a human.\n📞 Their number: ${customerPhone}\n\nReply to them directly on WhatsApp.`);
  }

  scheduleReEngage(vendorId, from, sock, vendorName, products || [], country, botInstructions);
}

// ═════════════════════════════════════════════════════════════════════════════
// REAL ESTATE HANDLER
// ═════════════════════════════════════════════════════════════════════════════

const LEAD_TEXT_FIELDS = ['name', 'listing_type', 'property_type', 'preferred_area', 'timeline'];
const LEAD_NUM_FIELDS  = ['budget_min', 'budget_max', 'bedrooms_wanted'];

function buildLeadPatch(update) {
  const patch = {};
  for (const f of LEAD_TEXT_FIELDS) {
    if (update[f] !== undefined && update[f] !== null && String(update[f]).trim() !== '') {
      patch[f] = String(update[f]).trim();
    }
  }
  for (const f of LEAD_NUM_FIELDS) {
    const n = Number(update[f]);
    if (update[f] !== undefined && update[f] !== null && !isNaN(n) && n > 0) patch[f] = n;
  }
  return patch;
}

async function fetchAvailableProperties(vendorIdInt) {
  const { data } = await supabase
    .from('properties')
    .select('*')
    .eq('vendor_id', vendorIdInt)
    .eq('active', true)
    .eq('status', 'available')
    .order('created_at', { ascending: false })
    .limit(50);
  return data || [];
}

// Sends the first WhatsApp message to a lead that came in from outside WhatsApp
// (a website form, Zapier, etc. via POST /leads/import). Seeds conversation
// history so a reply from the lead flows straight into handleRealEstate as normal.
async function sendInitialOutreach(vendorId, lead, { customMessage, source } = {}) {
  const conn = connections[vendorId];
  if (!conn?.isReady) return { success: false, error: 'WhatsApp not connected for this vendor' };

  const { data: vendor } = await supabase.from('vendors').select(VENDOR_FIELDS).eq('id', vendorId).single();
  if (!vendor) return { success: false, error: 'Vendor not found' };
  if (isSubscriptionExpired(vendor)) return { success: false, error: 'Subscription expired' };

  const jid = lead.jid || `${lead.phone}@s.whatsapp.net`;
  const properties = await fetchAvailableProperties(parseInt(vendorId));

  let message;
  try {
    message = (customMessage && customMessage.trim())
      ? customMessage.trim()
      : await ai.generateREOutreach(vendor.business_name, lead, properties, vendor.country || 'Nigeria', source);
  } catch (err) {
    return { success: false, error: `Could not generate message: ${err.message}` };
  }

  try {
    await conn.sock.sendMessage(jid, { text: message });
  } catch (err) {
    return { success: false, error: `Could not send message: ${err.message}` };
  }

  addToHistory(vendorId, jid, 'assistant', message);

  await supabase.from('leads').update({
    jid,
    last_contact_at:  new Date().toISOString(),
    followup_count:   0,
    next_followup_at: hoursFromNow(FOLLOWUP_FIRST_HOURS) // nudges automatically if they don't reply
  }).eq('id', lead.id);

  console.log(`[${vendor.business_name}] Outreach sent to imported lead ${lead.phone}`);
  return { success: true, message };
}

async function handleRealEstate({ sock, vendorId, vendorName, from, text, vendor }) {
  const vid             = parseInt(vendorId);
  const phone           = phoneFromJid(from);
  const country         = vendor?.country          || 'Nigeria';
  const botInstructions = vendor?.bot_instructions || '';
  const nowIso          = new Date().toISOString();

  await logConversation(vendorId, from);

  // ── Find or create the lead ────────────────────────────────────────────────
  let { data: lead } = await supabase
    .from('leads').select('*').eq('vendor_id', vid).eq('phone', phone).maybeSingle();

  if (!lead) {
    const { data: created, error } = await supabase.from('leads').insert([{
      vendor_id:        vid,
      phone,
      jid:              from,
      stage:            'new',
      last_contact_at:  nowIso,
      next_followup_at: hoursFromNow(FOLLOWUP_FIRST_HOURS),
      followup_count:   0
    }]).select().single();
    if (error) console.error(`[${vendorName}] Lead insert error:`, error.message);
    lead = created;

    await supabase.from('notifications').insert([{
      vendor_id: vid, type: 'lead', message: `New lead: ${phone}`, phone, read: false
    }]);
  } else {
    // Prospect replied: reset follow-up cycle
    const patch = { jid: from, last_contact_at: nowIso, followup_count: 0 };
    if (['new', 'contacted'].includes(lead.stage)) patch.next_followup_at = hoursFromNow(FOLLOWUP_FIRST_HOURS);
    await supabase.from('leads').update(patch).eq('id', lead.id);
    lead = { ...lead, ...patch };
  }

  const properties = await fetchAvailableProperties(vid);

  addToHistory(vendorId, from, 'user', text);
  const history  = getHistory(vendorId, from);
  const rawReply = await ai.generateREReply(history, properties, vendorName, country, botInstructions, lead);
  console.log(`[${vendorName}] RE raw reply: ${rawReply}`);

  const leadUpdate    = ai.extractLeadUpdate(rawReply);
  const viewingData   = ai.extractViewing(rawReply);
  const handoffNeeded = ai.extractHandoff(rawReply);
  const cleanedText   = ai.cleanReply(rawReply);

  const finalReply = cleanedText ||
    (viewingData ? '✅ Viewing request received! The agent will confirm your slot shortly 🙌' : 'Thanks for your message! 😊');

  await sock.sendMessage(from, { text: finalReply });
  console.log(`[${vendorName}] Replied: ${finalReply}`);
  addToHistory(vendorId, from, 'assistant', finalReply);

  if (!lead) return; // insert failed earlier — nothing more to persist

  // ── Qualification data ─────────────────────────────────────────────────────
  if (leadUpdate) {
    const patch = buildLeadPatch(leadUpdate);
    if (Object.keys(patch).length) {
      const { error } = await supabase.from('leads').update(patch).eq('id', lead.id);
      if (error) console.error(`[${vendorName}] Lead update error:`, error.message);
      else lead = { ...lead, ...patch };
    }
  }

  // ── Viewing request ────────────────────────────────────────────────────────
  if (viewingData) {
    const dateOk   = /^\d{4}-\d{2}-\d{2}$/.test(String(viewingData.date || ''));
    const propId   = parseInt(viewingData.property_id) || null;
    const property = propId ? properties.find(p => p.id === propId) : null;

    const { error: vErr } = await supabase.from('viewings').insert([{
      vendor_id:      vid,
      lead_id:        lead.id,
      property_id:    property ? property.id : null,
      requested_date: dateOk ? viewingData.date : null,
      requested_time: viewingData.time || null,
      status:         'requested',
      notes:          !dateOk && viewingData.date ? `Requested date: ${viewingData.date}` : null
    }]);
    if (vErr) console.error(`[${vendorName}] Viewing insert error:`, vErr.message);
    else console.log(`[${vendorName}] Viewing request saved ✅`);

    const leadPatch = {};
    if (viewingData.name && !lead.name) leadPatch.name = String(viewingData.name).trim();
    if (['new', 'contacted'].includes(lead.stage)) {
      leadPatch.stage = 'viewing_scheduled';
      leadPatch.next_followup_at = null;
    }
    if (Object.keys(leadPatch).length) {
      await supabase.from('leads').update(leadPatch).eq('id', lead.id);
      lead = { ...lead, ...leadPatch };
    }

    const displayName = viewingData.name || lead.name || 'Unknown';
    const propTitle   = property?.title || 'Property not specified';

    await supabase.from('notifications').insert([{
      vendor_id: vid,
      type:      'viewing',
      message:   `Viewing request from ${displayName} — ${propTitle} — ${viewingData.date || ''} ${viewingData.time || ''}`.trim(),
      phone,
      read:      false
    }]);

    const cur = ai.getCurrency(country);
    await notifyVendorWhatsApp(vendorId, vendor,
`🏠 *New Viewing Request!*

👤 Name: ${displayName}
🏡 Property: ${propTitle}
📅 When: ${viewingData.date || 'N/A'} ${viewingData.time || ''}
💰 Budget: ${lead.budget_max ? cur + Number(lead.budget_max).toLocaleString() : 'Not given'}
📞 Phone: ${phone}

Open your dashboard to confirm the viewing.`);
  }

  // ── Human handoff ──────────────────────────────────────────────────────────
  if (handoffNeeded) {
    console.log(`[${vendorName}] Handoff requested by ${from}`);
    await supabase.from('leads').update({ next_followup_at: null }).eq('id', lead.id);
    await supabase.from('notifications').insert([{
      vendor_id: vid,
      type:      'handoff',
      message:   `Prospect ${lead.name || phone} wants to speak to the agent`,
      phone,
      read:      false
    }]);
    await notifyVendorWhatsApp(vendorId, vendor,
      `🙋 *Prospect Wants to Talk!*\n\n${lead.name || 'A prospect'} is asking to speak with you.\n📞 ${phone}\n\nReply to them directly on WhatsApp.`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// REAL ESTATE FOLLOW-UP WORKER (persistent, survives restarts)
// ═════════════════════════════════════════════════════════════════════════════

let followUpRunning = false;

async function runFollowUps() {
  if (followUpRunning) return;
  followUpRunning = true;
  try {
    const { data: due, error } = await supabase
      .from('leads')
      .select('*')
      .lte('next_followup_at', new Date().toISOString())
      .in('stage', ['new', 'contacted'])
      .limit(20);

    if (error) { console.error('[FollowUp] Query error:', error.message); return; }

    for (const lead of due || []) {
      const vendorId = String(lead.vendor_id);
      const conn     = connections[vendorId];
      if (!conn?.isReady) continue; // retry next cycle once vendor is connected

      const { data: vendor } = await supabase
        .from('vendors').select(VENDOR_FIELDS).eq('id', lead.vendor_id).single();

      if (!vendor || vendor.product_type !== 'real_estate' || isSubscriptionExpired(vendor)) {
        await supabase.from('leads').update({ next_followup_at: null }).eq('id', lead.id);
        continue;
      }

      try {
        const properties = await fetchAvailableProperties(lead.vendor_id);
        const attempt    = (lead.followup_count || 0) + 1;
        const message    = await ai.generateREFollowUp(
          vendor.business_name, lead, properties, vendor.country || 'Nigeria', attempt
        );
        const jid = lead.jid || `${lead.phone}@s.whatsapp.net`;

        await conn.sock.sendMessage(jid, { text: message });
        addToHistory(vendorId, jid, 'assistant', message);
        console.log(`[${vendor.business_name}] Follow-up ${attempt} sent to ${lead.phone}`);

        await supabase.from('leads').update({
          followup_count:   attempt,
          next_followup_at: attempt < FOLLOWUP_MAX ? hoursFromNow(FOLLOWUP_REPEAT_HOURS) : null
        }).eq('id', lead.id);
      } catch (err) {
        console.error(`[FollowUp] Failed for lead ${lead.id}:`, err.message);
        // push retry out an hour so one bad lead can't loop every 5 minutes
        await supabase.from('leads').update({ next_followup_at: hoursFromNow(1) }).eq('id', lead.id);
      }
    }
  } catch (err) {
    console.error('[FollowUp] Worker error:', err.message);
  } finally {
    followUpRunning = false;
  }
}

function startFollowUpWorker() {
  console.log('[FollowUp] Worker started (every 5 min)');
  setInterval(runFollowUps, FOLLOWUP_CHECK_MS);
  setTimeout(runFollowUps, 60 * 1000); // first pass 1 min after boot, lets sessions reconnect
}

// ═════════════════════════════════════════════════════════════════════════════
// CONNECTION
// ═════════════════════════════════════════════════════════════════════════════

async function connectVendor(vendorId, vendorName) {
  if (connections[vendorId]?.isReady) {
    console.log(`✅ Vendor ${vendorName} already connected`);
    return;
  }

  if (connections[vendorId]?.sock) {
    try { connections[vendorId].sock.end(); } catch (e) {}
    delete connections[vendorId];
  }

  const { state, saveCreds } = await useSupabaseAuthState(vendorId);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
    console.log(`[WA] Using WhatsApp Web version ${version.join('.')}`);
  } catch (e) {
    console.log('[WA] Could not fetch latest WhatsApp version, using library default');
  }

  const sock = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    printQRInTerminal: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 2000
  });

  connections[vendorId] = { sock, isReady: false };

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
      reconnectTries[vendorId] = 0;
      qrCodes[vendorId] = null;
      await saveCreds();
      if (vendorId !== 'owner') {
        await supabase.from('vendors').update({ whatsapp_connected: true }).eq('id', vendorId);
      }
    }

    if (connection === 'close') {
      connections[vendorId].isReady = false;
      const statusCode      = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`${vendorName} disconnected. Code: ${statusCode}. Reconnecting: ${shouldReconnect}`);

      if (vendorId !== 'owner') {
        await supabase.from('vendors').update({ whatsapp_connected: false }).eq('id', vendorId);
      }

      if (statusCode === 515) {
        console.log(`[${vendorName}] Code 515 restart — saving session before reconnect`);
        await saveCreds();
      }

      if (statusCode === DisconnectReason.loggedOut) {
        console.log(`[${vendorName}] Logged out — clearing saved session`);
        await clearSession(vendorId);
      }

      if (shouldReconnect) {
        const tries = (reconnectTries[vendorId] = (reconnectTries[vendorId] || 0) + 1);
        if (tries > 8) {
          console.log(`[${vendorName}] Giving up after ${tries - 1} failed reconnects. Click Connect WhatsApp to try again.`);
          reconnectTries[vendorId] = 0;
          return;
        }
        const delay = Math.min(3000 * 2 ** (tries - 1), 60000);
        setTimeout(() => connectVendor(vendorId, vendorName), delay);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    if (!from) return;
    if (from === 'status@broadcast') return;
    if (from.endsWith('@newsletter')) return;
    if (from.endsWith('@broadcast')) return;

    const text = msg.message?.conversation ||
                 msg.message?.extendedTextMessage?.text || '';
    if (!text) return;

    console.log(`[${vendorName}] Message from ${from}: ${text}`);

    try {
      const { data: vendor } = await supabase
        .from('vendors').select(VENDOR_FIELDS).eq('id', vendorId).single();

      // Trial / subscription over → bot goes quiet (dashboard stays accessible)
      if (isSubscriptionExpired(vendor)) {
        console.log(`[${vendorName}] Subscription expired — bot paused`);
        return;
      }

      const ctx = { sock, vendorId, vendorName, from, text, vendor };
      if (vendor?.product_type === 'real_estate') await handleRealEstate(ctx);
      else                                        await handleEcommerce(ctx);

    } catch (err) {
      console.error(`[${vendorName}] Reply error:`, err.message, err.stack);
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

module.exports = { connectVendor, getQR, sendWhatsApp, startFollowUpWorker, clearSession, reconnectTries, sendInitialOutreach };