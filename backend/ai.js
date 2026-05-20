const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

async function generateReply(customerMessage, products) {
  const catalog = products
    .filter(p => p.active)
    .map(p => `${p.emoji} ${p.name} — ₦${p.price} | Sizes: ${p.sizes || 'One size'} | Colors: ${p.colors || 'See store'}`)
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `You are a friendly WhatsApp sales assistant for a fashion store selling hoodies, caps and clothing.
Keep replies short, warm and natural like a real person texting.
Always use ₦ for prices. Never use markdown, bullet points or asterisks — plain text only.

Our catalog:
${catalog}

Customer message: "${customerMessage}"

If they greet, welcome them and show the catalog naturally.
If they want to order, ask for their size, color and delivery address.
If they confirm an order, give them a clean summary and say payment is on delivery.`
    }]
  });

  return response.content[0].text;
}

module.exports = { generateReply };