const express = require('express');
const cors = require('cors');
require('dotenv').config();
const supabase = require('./db');
const { connectVendor, getQR } = require('./whatsapp');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── PRODUCTS ────────────────────────────────────────────────────────────────

app.get('/products', async (req, res) => {
  const { vendor_id } = req.query;
  let query = supabase.from('products').select('*').order('id', { ascending: true });
  if (vendor_id) query = query.eq('vendor_id', vendor_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/products', async (req, res) => {
  const product = {
    name: req.body.name,
    price: req.body.price,
    category: req.body.category,
    description: req.body.desc || req.body.description || '',
    emoji: req.body.emoji,
    active: req.body.active,
    sizes: req.body.sizes || '',
    colors: req.body.colors || '',
    vendor_id: req.body.vendor_id || null
  };
  const { data, error } = await supabase.from('products').insert([product]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.put('/products/:id', async (req, res) => {
  const product = {
    name: req.body.name,
    price: req.body.price,
    category: req.body.category,
    description: req.body.desc || req.body.description || '',
    emoji: req.body.emoji,
    active: req.body.active,
    sizes: req.body.sizes || '',
    colors: req.body.colors || ''
  };
  const { error } = await supabase.from('products').update(product).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/products/:id', async (req, res) => {
  const { error } = await supabase.from('products').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────

app.post('/signup', async (req, res) => {
  const { name, business_name, email, whatsapp_number, business_type, about, password, country } = req.body;
  const { data: existing } = await supabase.from('vendors').select('id').eq('email', email).single();
  if (existing) return res.json({ success: false, error: 'Email already registered' });
  const { data, error } = await supabase
    .from('vendors')
    .insert([{ name, business_name, email, whatsapp_number, business_type, about, password, active: false, country: country || 'Nigeria' }])
    .select();
  if (error) return res.json({ success: false, error: error.message });
  console.log(`New signup: ${business_name} (${country || 'Nigeria'}) — ${email}`);
  res.json({ success: true });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: vendor, error } = await supabase
    .from('vendors').select('*').eq('email', email).eq('password', password).single();
  if (error || !vendor) return res.json({ success: false, error: 'Invalid email or password' });
  if (!vendor.active) return res.json({ success: false, error: 'Your account is pending approval. We will notify you within 48 hours.' });
  res.json({ success: true, vendor: {
    id: vendor.id,
    name: vendor.name,
    business_name: vendor.business_name,
    email: vendor.email,
    whatsapp_connected: vendor.whatsapp_connected,
    country: vendor.country || 'Nigeria',
    bot_instructions: vendor.bot_instructions || ''
  }});
});

// ─── BOT TRAINING ─────────────────────────────────────────────────────────────

app.put('/vendors/:id/bot-instructions', async (req, res) => {
  const { bot_instructions } = req.body;
  const { error } = await supabase.from('vendors').update({ bot_instructions }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── ADMIN ────────────────────────────────────────────────────────────────────

app.get('/admin/vendors', async (req, res) => {
  const { data, error } = await supabase.from('vendors').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/admin/vendors/:id', async (req, res) => {
  const { error } = await supabase.from('vendors').update({ active: req.body.active }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── WHATSAPP QR PER VENDOR ───────────────────────────────────────────────────

app.get('/vendors/:id/qr', async (req, res) => {
  const vendorId = req.params.id;
  const { data: vendor, error } = await supabase.from('vendors').select('*').eq('id', vendorId).single();
  if (error || !vendor) return res.status(404).send('Vendor not found');
  if (!vendor.active) return res.status(403).send('Vendor not approved yet');

  await connectVendor(vendorId, vendor.business_name);

  const checkQR = (attempts = 0) => {
    const qr = getQR(vendorId);
    if (qr) {
      return res.send(`
        <html>
        <head><meta http-equiv="refresh" content="30"></head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#000;color:white;font-family:sans-serif">
          <h2 style="margin-bottom:20px">${vendor.business_name}</h2>
          <p style="margin-bottom:20px;color:#aaa">Scan with WhatsApp to connect your bot</p>
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}" />
          <p style="margin-top:20px;color:#aaa;font-size:12px">Page refreshes every 30s</p>
        </body></html>
      `);
    }
    if (attempts < 15) {
      setTimeout(() => checkQR(attempts + 1), 1000);
    } else {
      res.send(`
        <html>
        <head><meta http-equiv="refresh" content="5"></head>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#000;color:white;font-family:sans-serif">
          <p>Connecting... please wait</p>
        </body></html>
      `);
    }
  };
  setTimeout(() => checkQR(), 1000);
});

app.get('/vendors/:id/qr-image', async (req, res) => {
  const vendorId = req.params.id;
  const { data: vendor, error } = await supabase.from('vendors').select('*').eq('id', vendorId).single();
  if (error || !vendor) return res.status(404).send('Not found');
  if (!vendor.active) return res.status(403).send('Not approved');

  await connectVendor(vendorId, vendor.business_name);

  const checkQR = (attempts = 0) => {
    const qr = getQR(vendorId);
    if (qr) {
      const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
      return res.redirect(qrImageUrl);
    }
    if (attempts < 15) {
      setTimeout(() => checkQR(attempts + 1), 1000);
    } else {
      res.status(504).send('QR not ready');
    }
  };
  setTimeout(() => checkQR(), 1000);
});

app.get('/vendors/:id/status', async (req, res) => {
  const { data: vendor } = await supabase.from('vendors').select('whatsapp_connected, business_name').eq('id', req.params.id).single();
  res.json(vendor || { whatsapp_connected: false });
});

// ─── LEGACY SINGLE QR ────────────────────────────────────────────────────────

app.get('/qr', (req, res) => {
  const qr = getQR('owner');
  if (qr) {
    res.send(`
      <html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#000">
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}" />
      </body></html>
    `);
  } else {
    res.send('QR not ready yet — wait 10 seconds and refresh');
  }
});

app.use('/webhook', require('./webhook'));
app.get('/', (req, res) => res.json({ message: 'Nexua OrderFlow server running!' }));

app.post('/vendors/:id/disconnect', async (req, res) => {
  const { error } = await supabase
    .from('vendors')
    .update({ whatsapp_connected: false })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Nexua OrderFlow server running on port ${PORT}`);
  connectVendor('owner', 'Nexua Owner');
});