const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

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
  const config   = COUNTRY_CONFIG[country] || COUNTRY_CONFIG['Other'];
  const currency = config.currency;
  const tone     = config.tone;

  const catalog = products
    .filter(p => p.active)
    .map(p => `${p.emoji || ''} ${p.name} — ${currency}${p.price}${p.sizes ? ` | Sizes: ${p.sizes}` : ''}${p.colors ? ` | Colors: ${p.colors}` : ''}${p.description ? ` | ${p.description}` : ''}`)
    .join('\n');

  const customRules  = botInstructions ? `\nSpecial business rules you must follow:\n${botInstructions}\n` : '';
  const systemPrompt = SYSTEM_PROMPT(vendorName, currency, tone, catalog, customRules);

  let messages = history.map(h => ({ role: h.role, content: h.content }));
  messages = messages.filter(m => m.content && m.content.trim().length > 0);

  while (messages.length > 0 && messages[0].role !== 'user') messages.shift();
  if (!messages.length) {
    console.error('[AI] generateReply called with empty or invalid history');
    return '';
  }

  // Fix alternating roles
  const fixed = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role !== fixed[fixed.length - 1].role) {
      fixed.push(messages[i]);
    } else {
      fixed[fixed.length - 1].content += '\n' + messages[i].content;
    }
  }

  console.log(`[AI] Sending ${fixed.length} messages to Claude`);

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 500,
    system:     systemPrompt,
    messages:   fixed
  });

  const text = response.content[0]?.text || '';
  if (!text) console.error('[AI] Claude returned empty. Stop reason:', response.stop_reason);
  return text;
}

function extractOrder(reply) {
  const match = reply.match(/ORDER_CONFIRMED:(\{[^}]+\})/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    console.error('[AI] extractOrder parse error:', e.message, '| raw:', match[1]);
    return null;
  }
}

function extractHandoff(reply) {
  return reply.includes('HANDOFF_REQUESTED');
}

function cleanReply(reply) {
  return reply
    .replace(/ORDER_CONFIRMED:\{[^}]+\}\n?/s, '')
    .replace(/HANDOFF_REQUESTED\n?/, '')
    .trim();
}

async function generateReEngageReply(vendorName, products, country = 'Nigeria', botInstructions = '') {
  const config   = COUNTRY_CONFIG[country] || COUNTRY_CONFIG['Other'];
  const currency = config.currency;
  const tone     = config.tone;

  const catalog = products
    .filter(p => p.active)
    .map(p => `${p.emoji || ''} ${p.name} — ${currency}${p.price}`)
    .join('\n');

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
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

module.exports = { generateReply, extractOrder, extractHandoff, cleanReply, generateReEngageReply };