const axios = require('axios');
require('dotenv').config();

async function sendWhatsApp(to, message) {
  const url = `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
  await axios.post(url, {
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: message }
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

module.exports = { sendWhatsApp };