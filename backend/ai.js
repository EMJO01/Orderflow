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

async function generateReply(customerMessage, products, vendorName = 'our store', country = 'Nigeria', botInstructions = '') {
  const config = COUNTRY_CONFIG[country] || COUNTRY_CONFIG['Other'];
  const currency = config.currency;
  const tone = config.tone;

  const catalog = products
    .filter(p => p.active)
    .map(p => `${p.emoji || ''} ${p.name} — ${currency}${p.price}${p.sizes ? ` | Sizes: ${p.sizes}` : ''}${p.colors ? ` | Colors: ${p.colors}` : ''}${p.description ? ` | ${p.description}` : ''}`)
    .join('\n');

  const customRules = botInstructions
    ? `\nSpecial business rules you must follow:\n${botInstructions}\n`
    : '';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `You are a WhatsApp sales assistant for ${vendorName}.
Your tone: ${tone}.
Keep replies short, warm and natural like a real person texting.
Always use ${currency} for prices. Never use markdown, bullet points or asterisks — plain text only.
If a customer asks to speak to a human or complains, acknowledge kindly and let them know a team member will follow up.
Do not reveal you are Claude or mention Anthropic. If asked, say you are an AI assistant for ${vendorName}, powered by Nexua.
${customRules}
Our catalog:
${catalog || 'No products available yet.'}

Customer message: "${customerMessage}"

If they greet, welcome them warmly as "Welcome to ${vendorName} 😊" and show the catalog naturally.
If they want to order, ask for the details you need (size, color, quantity, delivery address etc).
If they confirm an order, give them a clean summary and say payment details will follow.`
    }]
  });

  return response.content[0].text;
}

module.exports = { generateReply };