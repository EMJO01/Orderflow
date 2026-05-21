const express = require('express');
const cors = require('cors');
require('dotenv').config();
const supabase = require('./db');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/products', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('id', { ascending: true });
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
    colors: req.body.colors || ''
  };
  const { data, error } = await supabase
    .from('products')
    .insert([product])
    .select();
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
  const { error } = await supabase
    .from('products')
    .update(product)
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/products/:id', async (req, res) => {
  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Signup route
app.post('/signup', async (req, res) => {
  const { name, business_name, email, whatsapp_number, business_type, about, password } = req.body;

  const { data: existing } = await supabase
    .from('vendors')
    .select('id')
    .eq('email', email)
    .single();

  if (existing) return res.json({ success: false, error: 'Email already registered' });

  const { data, error } = await supabase
    .from('vendors')
    .insert([{ name, business_name, email, whatsapp_number, business_type, about, password, active: false }])
    .select();

  if (error) return res.json({ success: false, error: error.message });

  console.log(`New signup: ${business_name} — ${email} — ${whatsapp_number}`);
  res.json({ success: true });
});

// Login route
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const { data: vendor, error } = await supabase
    .from('vendors')
    .select('*')
    .eq('email', email)
    .eq('password', password)
    .single();

  if (error || !vendor) return res.json({ success: false, error: 'Invalid email or password' });
  if (!vendor.active) return res.json({ success: false, error: 'Your account is pending approval. We will notify you within 48 hours.' });

  res.json({ success: true, vendor: { id: vendor.id, name: vendor.name, business_name: vendor.business_name, email: vendor.email } });
});

// Admin — get all vendors
app.get('/admin/vendors', async (req, res) => {
  const { data, error } = await supabase
    .from('vendors')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Admin — approve or deactivate vendor
app.put('/admin/vendors/:id', async (req, res) => {
  const { error } = await supabase
    .from('vendors')
    .update({ active: req.body.active })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// WhatsApp webhook
app.use('/webhook', require('./webhook'));

app.get('/', (req, res) => res.json({ message: 'Rady server running!' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));