const express = require('express');
const router = express.Router();
const supabase = require('./db');
const { generateReply } = require('./ai');
const { sendWhatsApp } = require('./whatsapp');

router.get('/', (req, res) => {
  const VERIFY_TOKEN = 'rady123';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

router.post('/', async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return res.sendStatus(200);

    const from = message.from;
    const text = message.text.body;
    console.log(`Message from ${from}: ${text}`);

    const { data: products } = await supabase
      .from('products')
      .select('*')
      .eq('active', true);

    const reply = await generateReply(text, products || []);
    await sendWhatsApp(from, reply);
    console.log(`Replied: ${reply}`);
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.sendStatus(200);
  }
});

module.exports = router;