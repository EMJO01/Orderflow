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

// ─── WHATSAPP ─────────────────────────────────────────────────────────────────

// Step 1: trigger connection — returns instantly
app.post('/vendors/:id/connect', async (req, res) => {
  const vendorId = req.params.id;
  const { data: vendor, error } = await supabase.from('vendors').select('*').eq('id', vendorId).single();
  if (error || !vendor) return res.status(404).json({ error: 'Vendor not found' });
  if (!vendor.active) return res.status(403).json({ error: 'Vendor not approved' });
  connectVendor(vendorId, vendor.business_name); // fire and forget
  res.json({ success: true });
});

// Step 2: poll this for QR — returns JSON, never redirects, never times out
app.get('/vendors/:id/qr-image', (req, res) => {
  const qr = getQR(req.params.id);
  if (qr) {
    return res.json({
      status: 'ready',
      url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`
    });
  }
  res.status(202).json({ status: 'not_ready' });
});

app.get('/vendors/:id/status', async (req, res) => {
  const { data: vendor } = await supabase.from('vendors').select('whatsapp_connected, business_name').eq('id', req.params.id).single();
  res.json(vendor || { whatsapp_connected: false });
});

app.post('/vendors/:id/disconnect', async (req, res) => {
  const { error } = await supabase.from('vendors').update({ whatsapp_connected: false }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── ORDERS ──────────────────────────────────────────────────────────────────

app.get('/orders', async (req, res) => {
  const { vendor_id } = req.query;
  let query = supabase.from('orders').select('*').order('created_at', { ascending: false });
  if (vendor_id) query = query.eq('vendor_id', vendor_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/orders/stats', async (req, res) => {
  const { vendor_id } = req.query;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let query = supabase.from('orders').select('*').gte('created_at', today.toISOString());
  if (vendor_id) query = query.eq('vendor_id', vendor_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const orders_today = data.length;
  const revenue_today = data.reduce((sum, o) => sum + (parseFloat(o.total_price) || 0), 0);
  res.json({ orders_today, revenue_today });
});

app.put('/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  const { error } = await supabase.from('orders').update({ status }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── LEGACY QR ────────────────────────────────────────────────────────────────

app.get('/qr', (req, res) => {
  const qr = getQR('owner');
  if (qr) {
    res.send(`<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#000">
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}" />
      </body></html>`);
  } else {
    res.send('QR not ready yet — wait 10 seconds and refresh');
  }
});

app.use('/webhook', require('./webhook'));
app.get('/', (req, res) => res.json({ message: 'Nexua OrderFlow server running!' }));

// Add this BEFORE app.listen
async function reconnectActiveVendors() {
  try {
    const { data: vendors } = await supabase
      .from('vendors')
      .select('id, business_name')
      .eq('active', true);

    if (!vendors?.length) return;
    console.log(`Auto-reconnecting ${vendors.length} active vendor(s)...`);
    for (const vendor of vendors) {
      connectVendor(String(vendor.id), vendor.business_name);
    }
  } catch (e) {
    console.error('Auto-reconnect error:', e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Nexua OrderFlow server running on port ${PORT}`);
  reconnectActiveVendors(); // ← replaces the old connectVendor('owner', 'Nexua Owner')
});