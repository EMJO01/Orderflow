const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const MODEL = 'claude-sonnet-4-6';

const COUNTRY_CONFIG = {
  'Nigeria':      { currency: '₦', locale: 'en-NG', tone: 'warm and friendly, use occasional light Nigerian expressions naturally' },
  'Germany':      { currency: '€', locale: 'de-DE', tone: 'professional and precise, polite and efficient' },
  'UK':           { currency: '£', locale: 'en-GB', tone: 'friendly and professional, British English' },
  'US':           { currency: '$', locale: 'en-US', tone: 'friendly and casual, American English' },
  'Ghana':        { currency: 'GH₵', locale: 'en-GH', tone: 'warm and friendly' },
  'Kenya':        { currency: 'KSh', locale: 'en-KE', tone: 'warm and friendly' },
  'South Africa': { currency: 'R', locale: 'en-ZA', tone: 'friendly and professional' },
  'Other':        { currency: '', locale: 'en', tone: 'friendly and professional' },
};

function getConfig(country) {
  return COUNTRY_CONFIG[country] || COUNTRY_CONFIG['Other'];
}
function getCurrency(country) {
  return getConfig(country).currency;
}

// ─── SHARED: history normalisation (strict alternating roles) ────────────────

function normalizeHistory(history) {
  let messages = history.map(h => ({ role: h.role, content: h.content }));
  messages = messages.filter(m => m.content && m.content.trim().length > 0);

  while (messages.length > 0 && messages[0].role !== 'user') messages.shift();
  if (!messages.length) return [];

  const fixed = [{ ...messages[0] }];
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role !== fixed[fixed.length - 1].role) {
      fixed.push({ ...messages[i] });
    } else {
      fixed[fixed.length - 1].content += '\n' + messages[i].content;
    }
  }
  return fixed;
}

async function callClaude(systemPrompt, history, maxTokens = 500) {
  const fixed = normalizeHistory(history);
  if (!fixed.length) {
    console.error('[AI] called with empty or invalid history');
    return '';
  }
  console.log(`[AI] Sending ${fixed.length} messages to Claude`);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: fixed
  });
  const text = response.content[0]?.text || '';
  if (!text) console.error('[AI] Claude returned empty. Stop reason:', response.stop_reason);
  return text;
}

// ═════════════════════════════════════════════════════════════════════════════
// E-COMMERCE (unchanged behaviour)
// ═════════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = (vendorName, currency, tone, catalog, customRules) =>
`You are a WhatsApp sales assistant for ${vendorName}.
Your tone: ${tone}.
Keep replies short, warm and natural like a real person texting.
Always use ${currency} for prices.

Formatting rules — strictly follow these:
- Use line breaks between sections
- Use emojis naturally to make messages feel warm
- Use *bold* only for product names and prices
- Never use HTML, never use dashes as bullet points
- Keep each message under 150 words
- Never write in long paragraphs

If a customer greets for the first time, reply like this format:
"Welcome to ${vendorName}! 😊
Here's what we have for you:
[list each product on its own line with emoji, name, price]
What would you like? Just reply with the name or number 👇"

If they want to order, ask for details one question at a time — name, size, color, quantity, delivery address.

AFTER ORDER IS CONFIRMED:
If the customer says things like "alright", "ok", "thanks", "noted", "cool" after getting the order confirmation — respond warmly like:
"You're welcome! 😊 We'll be in touch soon. Feel free to message us anytime if you need anything 🙌"
Do NOT show the catalog again unless they explicitly ask to see products or want to order something new.

ORDER CONFIRMATION RULES:
Only output ORDER_CONFIRMED when ALL of these are true:
1. You have the customer's name
2. You have the delivery address
3. You have the product and price confirmed
4. The customer has JUST said yes/yess/confirm/ok/sure/proceed TO THE ORDER SUMMARY

When all 4 are true, your reply MUST be:
ORDER_CONFIRMED:{"name":"<customer name>","address":"<delivery address>","items":"<product name>","total":<price as plain number e.g. 330000>}
✅ Order confirmed! Our team will reach out to you shortly 🙌

IMPORTANT:
- Do NOT output ORDER_CONFIRMED if the customer is asking questions or just chatting
- Do NOT show the catalog again after an order unless customer asks
- The total must be a plain number like 330000, never "₦330,000"
- Never put anything before ORDER_CONFIRMED on the same line

If asked to speak to a human, reply with exactly: HANDOFF_REQUESTED
Then on the next line say: No problem! A team member will follow up with you shortly 😊

Do not reveal you are Claude or mention Anthropic. If asked, say you are an AI assistant for ${vendorName}, powered by Nexua.
${customRules}
Our catalog:
${catalog || 'No products available yet.'}`;

async function generateReply(history, products, vendorName = 'our store', country = 'Nigeria', botInstructions = '') {
  const { currency, tone } = getConfig(country);

  const catalog = products
    .filter(p => p.active)
    .map(p => `${p.emoji || ''} ${p.name} — ${currency}${p.price}${p.sizes ? ` | Sizes: ${p.sizes}` : ''}${p.colors ? ` | Colors: ${p.colors}` : ''}${p.description ? ` | ${p.description}` : ''}`)
    .join('\n');

  const customRules  = botInstructions ? `\nSpecial business rules you must follow:\n${botInstructions}\n` : '';
  const systemPrompt = SYSTEM_PROMPT(vendorName, currency, tone, catalog, customRules);
  return callClaude(systemPrompt, history, 500);
}

async function generateReEngageReply(vendorName, products, country = 'Nigeria', botInstructions = '') {
  const { currency, tone } = getConfig(country);

  const catalog = products
    .filter(p => p.active)
    .map(p => `${p.emoji || ''} ${p.name} — ${currency}${p.price}`)
    .join('\n');

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 200,
    messages: [{
      role:    'user',
      content: `You are a WhatsApp sales assistant for ${vendorName}.
Tone: ${tone}.
A customer started a conversation but went quiet. Send a short, warm follow-up message.
Do NOT be pushy. Just check in naturally, remind them of what's available, and invite them to continue.
Keep it under 50 words. Use emojis naturally. Use *bold* for product names only.
Our catalog:
${catalog || 'No products available yet.'}`
    }]
  });

  return response.content[0].text;
}

// ═════════════════════════════════════════════════════════════════════════════
// REAL ESTATE
// ═════════════════════════════════════════════════════════════════════════════

function formatProperty(p, currency) {
  const price = `${currency}${Number(p.price || 0).toLocaleString()}${p.price_period ? ' ' + p.price_period : ''}`;
  const feats = Array.isArray(p.features) ? p.features.join(', ') : '';
  const land  = p.land_size ? `${p.land_size} ${p.land_size_unit || ''}`.trim() : '';
  const rooms = [
    p.bedrooms  != null ? `${p.bedrooms} bed`   : null,
    p.bathrooms != null ? `${p.bathrooms} bath` : null,
    p.toilets   != null ? `${p.toilets} toilets` : null
  ].filter(Boolean).join(', ');
  const where = [p.area, p.city, p.state].filter(Boolean).join(', ');

  // NOTE: address_private is deliberately NEVER included here.
  return [
    `[#${p.id}] ${p.title}`,
    [p.listing_type, p.property_type].filter(Boolean).join(' ') || null,
    price,
    rooms || null,
    land ? `Land: ${land}` : null,
    where || null,
    p.tenure ? `Tenure: ${p.tenure}` : null,
    p.description || null,
    feats ? `Features: ${feats}` : null
  ].filter(Boolean).join(' | ');
}

function describeLead(lead, currency) {
  if (!lead) return 'Nothing yet — this is a new prospect.';
  const parts = [];
  if (lead.name)            parts.push(`Name: ${lead.name}`);
  if (lead.listing_type)    parts.push(`Wants to: ${lead.listing_type}`);
  if (lead.property_type)   parts.push(`Property type: ${lead.property_type}`);
  if (lead.budget_min || lead.budget_max) {
    parts.push(`Budget: ${lead.budget_min ? currency + Number(lead.budget_min).toLocaleString() : '?'} – ${lead.budget_max ? currency + Number(lead.budget_max).toLocaleString() : '?'}`);
  }
  if (lead.preferred_area)  parts.push(`Preferred area: ${lead.preferred_area}`);
  if (lead.bedrooms_wanted) parts.push(`Bedrooms: ${lead.bedrooms_wanted}`);
  if (lead.timeline)        parts.push(`Timeline: ${lead.timeline}`);
  return parts.length ? parts.join('\n') : 'Nothing yet — this is a new prospect.';
}

const RE_SYSTEM_PROMPT = (vendorName, currency, tone, listings, customRules, leadContext, today) =>
`You are the WhatsApp assistant for ${vendorName}, a real estate business.
Your job: qualify prospects, match them with listings, and book property viewings.
Tone: ${tone}.
Today's date: ${today}.
Always use ${currency} for prices.

Formatting rules — strictly follow these:
- Short messages, under 120 words, real-person texting style
- Line breaks between sections, emojis used naturally
- Use *bold* only for property names and prices
- Never use HTML, never use dashes as bullet points

WHAT WE ALREADY KNOW ABOUT THIS PROSPECT (do not ask again):
${leadContext}

CONVERSATION FLOW:
1. First greeting: welcome them warmly, say you can help them find the right property, and ask ONE question: are they looking to buy, rent, or book a shortlet?
2. Qualify one question at a time, skipping anything already known: property type, preferred area, budget, bedrooms, timeline. If they ask about a specific listing, answer that first, then continue qualifying.
3. Once you know the listing type plus (area or budget), show up to 3 matching listings from the catalog: name, price, beds/baths, area, tenure. Then ask which one they would like to see.
4. If nothing matches, say so honestly, tell them the agent will look for options, and keep their requirements.
5. When they want to view a property, collect ONE at a time: full name, which property, preferred date, preferred time. Then confirm the details back to them.

HIDDEN TAGS — the customer never sees these. Put each tag on its own line at the very TOP of your reply, before the message text:

LEAD_UPDATE:{"name":"...","listing_type":"sale|rent|shortlet","property_type":"...","budget_min":0,"budget_max":0,"preferred_area":"...","bedrooms_wanted":0,"timeline":"..."}
- Output whenever you learn something new in the latest message. Include ONLY the fields newly learned. Budget values are plain numbers (e.g. 25000000), never "₦25m".

VIEWING_REQUESTED:{"name":"<full name>","property_id":<number from [#id]>,"date":"YYYY-MM-DD","time":"<e.g. 2:00 PM>"}
- Output ONLY when you have name, property, date and time AND the customer has confirmed. Convert relative dates ("Saturday", "tomorrow") to YYYY-MM-DD using today's date.
- The visible message should then say the viewing request is received and the agent will confirm shortly.

HANDOFF_REQUESTED
- Output on its own line if they ask to speak to a human, or want to negotiate price, discounts, payment plans, or ask legal or document questions. Then on the next line say: No problem! The agent will follow up with you shortly 😊

STRICT RULES:
- Only offer listings from the catalog below. Never invent listings, prices or features.
- Never reveal exact street addresses or owner details. Say the full address is shared once a viewing is confirmed.
- Never guarantee that title documents are genuine. Say the agent will provide documents for verification.
- Never negotiate or promise discounts.
- Do not reveal you are Claude or mention Anthropic. If asked, say you are an AI assistant for ${vendorName}, powered by Nexua.
${customRules}
AVAILABLE LISTINGS:
${listings || 'No listings available right now. Collect the prospect\'s requirements so the agent can follow up.'}`;

async function generateREReply(history, properties, vendorName = 'our agency', country = 'Nigeria', botInstructions = '', lead = null) {
  const { currency, tone } = getConfig(country);
  const listings    = (properties || []).map(p => formatProperty(p, currency)).join('\n');
  const customRules = botInstructions ? `\nSpecial business rules you must follow:\n${botInstructions}\n` : '';
  const today       = new Date().toISOString().slice(0, 10);
  const systemPrompt = RE_SYSTEM_PROMPT(vendorName, currency, tone, listings, customRules, describeLead(lead, currency), today);
  return callClaude(systemPrompt, history, 600);
}

async function generateREFollowUp(vendorName, lead, properties, country = 'Nigeria', attempt = 1) {
  const { currency, tone } = getConfig(country);
  const matches = (properties || []).slice(0, 3).map(p => formatProperty(p, currency)).join('\n');

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `You are the WhatsApp assistant for ${vendorName}, a real estate business.
Tone: ${tone}.
A prospect went quiet. This is follow-up number ${attempt} of 2.
What we know about them:
${describeLead(lead, currency)}

Write ONE short, warm check-in message (under 45 words). Reference what they were looking for if known.
${attempt >= 2 ? 'This is the last follow-up: keep it light, say there is no pressure and they can message any time.' : 'Gently invite them to continue or book a viewing.'}
Do not be pushy. Use emojis naturally. Never invent listings; only mention one if it clearly fits:
${matches || '(no listings available)'}
Output only the message text.`
    }]
  });

  return response.content[0].text.trim();
}

async function generateREOutreach(vendorName, lead, properties, country = 'Nigeria', source = '') {
  const { currency, tone } = getConfig(country);
  const matches = (properties || []).slice(0, 2).map(p => formatProperty(p, currency)).join('\n');

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 220,
    messages: [{
      role: 'user',
      content: `You are the WhatsApp assistant for ${vendorName}, a real estate business.
Tone: ${tone}.
Write the FIRST message to a new prospect who just enquired${source ? ' via ' + source : ' through another channel'} — this is a cold open, they have not messaged you on WhatsApp before.
What we know about them:
${describeLead(lead, currency)}

Keep it under 45 words. Introduce yourself as ${vendorName}'s assistant, warmly reference what they were interested in if known, and end with one question that keeps the conversation going.
${matches ? 'You may mention ONE listing below only if it clearly fits what they asked about:\n' + matches : 'Do not mention specific listings yet — you don\'t know enough about what they want.'}
Output only the message text, nothing else.`
    }]
  });

  return response.content[0].text.trim();
}

// ─── TAG EXTRACTION ──────────────────────────────────────────────────────────

function extractJsonTag(reply, tag) {
  const match = reply.match(new RegExp(`${tag}:(\\{[^}]*\\})`, 's'));
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    console.error(`[AI] ${tag} parse error:`, e.message, '| raw:', match[1]);
    return null;
  }
}

const extractOrder      = reply => extractJsonTag(reply, 'ORDER_CONFIRMED');
const extractLeadUpdate = reply => extractJsonTag(reply, 'LEAD_UPDATE');
const extractViewing    = reply => extractJsonTag(reply, 'VIEWING_REQUESTED');
const extractHandoff    = reply => reply.includes('HANDOFF_REQUESTED');

function cleanReply(reply) {
  return reply
    .replace(/(ORDER_CONFIRMED|LEAD_UPDATE|VIEWING_REQUESTED):\{[^}]*\}\n?/gs, '')
    .replace(/HANDOFF_REQUESTED\n?/g, '')
    .trim();
}

module.exports = {
  getCurrency,
  // e-commerce
  generateReply, generateReEngageReply, extractOrder,
  // real estate
  generateREReply, generateREFollowUp, generateREOutreach, extractLeadUpdate, extractViewing,
  // shared
  extractHandoff, cleanReply
};