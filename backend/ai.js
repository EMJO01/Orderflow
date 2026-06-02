const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

async function generateReply(customerMessage, products, vendorName = 'our store') {
  const catalog = products
    .filter(p => p.active)
    .map(p => `${p.emoji || ''} ${p.name} — ₦${p.price}${p.sizes ? ` | Sizes: ${p.sizes}` : ''}${p.colors ? ` | Colors: ${p.colors}` : ''}${p.description ? ` | ${p.description}` : ''}`)
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `You are a friendly WhatsApp sales assistant for ${vendorName}.
Keep replies short, warm and natural like a real person texting.
Always use ₦ for prices. Never use markdown, bullet points or asterisks — plain text only.

Our catalog:
${catalog || 'No products available yet.'}

Customer message: "${customerMessage}"

If they greet, welcome them warmly and show the catalog naturally.
If they want to order, ask for the details you need (size, color, address etc).
If they confirm an order, give them a clean summary and say payment is on delivery.`
    }]
  });

  return response.content[0].text;
}

module.exports = { generateReply };