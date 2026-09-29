const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const supabase = require('./db');
const { connectVendor, getQR, startFollowUpWorker } = require('./whatsapp');

// A WhatsApp connection error should never take the whole server down for every vendor.
// The error is logged so it shows up in Render Logs.
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

const app = express();

// Render sits behind a proxy. Without this, the login rate limiter sees every request as one IP.
app.set('trust proxy', 1);

// Only these sites can call the API from a browser. Add any other frontend domain here.
const allowedOrigins = [
  'https://eminnbot.netlify.app',
  'https://eminntech.com',        // only needed if a page on it calls this API
  'http://localhost:5500'         // local testing, remove when you no longer need it
];

app.use(cors({
  origin: (origin, cb) =>
    (!origin || allowedOrigins.includes(origin)) ? cb(null, true) : cb(new Error('Not allowed by CORS')),
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));
app.use(express.json());

if (!process.env.ADMIN_PASSWORD || !process.env.JWT_SECRET) {
  console.error('WARNING: ADMIN_PASSWORD or JWT_SECRET is not set. Admin login will fail.');
}

const TRIAL_DAYS = 3;

// ─── AUTH HELPERS ──────────────────────────────────────────────────────────────
// Vendor tokens are issued by /login. Admin tokens are issued by /admin/login.
const vendorLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

function readToken(req) {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    return jwt.verify(t, process.env.JWT_SECRET);
  } catch { return null; }
}

// Accepts a vendor token or an admin token
function auth(req, res, next) {
  const p = readToken(req);
  if (!p) return res.status(401).json({ error: 'Unauthorized' });
  if (p.role === 'admin') { req.isAdmin = true; return next(); }
  if (p.role === 'vendor' && p.vendor_id != null) { req.vendorId = String(p.vendor_id); return next(); }
  res.status(401).json({ error: 'Unauthorized' });
}

const forbid = res => res.status(403).json({ error: 'Forbidden' });
// A vendor may only touch their own data. Admin tokens skip these checks.
const ownParam = (req, res, next) => (req.isAdmin || String(req.params.id) === req.vendorId) ? next() : forbid(res);
const ownQuery = (req, res, next) => (req.isAdmin || String(req.query.vendor_id) === req.vendorId) ? next() : forbid(res);
const ownBody  = (req, res, next) => (req.isAdmin || String(req.body && req.body.vendor_id) === req.vendorId) ? next() : forbid(res);
const ownsRow = table => async (req, res, next) => {
  if (req.isAdmin) return next();
  const { data } = await supabase.from(table).select('vendor_id').eq('id', req.params.id).single();
  if (!data || String(data.vendor_id) !== req.vendorId) return forbid(res);
  next();
};


// ─── PRODUCTS (ecommerce) ──────────────────────────────────────────────────────

app.get('/products', async (req, res) => {
  const { vendor_id } = req.query;
  let query = supabase.from('products').select('*').order('id', { ascending: true });
  if (vendor_id) query = query.eq('vendor_id', vendor_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/products', auth, ownBody, async (req, res) => {
  const product = {
    name: req.body.name, price: req.body.price, category: req.body.category,
    description: req.body.desc || req.body.description || '',
    emoji: req.body.emoji, active: req.body.active,
    sizes: req.body.sizes || '', colors: req.body.colors || '',
    vendor_id: req.body.vendor_id || null
  };
  const { data, error } = await supabase.from('products').insert([product]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.put('/products/:id', auth, ownsRow('products'), async (req, res) => {
  const product = {
    name: req.body.name, price: req.body.price, category: req.body.category,
    description: req.body.desc || req.body.description || '',
    emoji: req.body.emoji, active: req.body.active,
    sizes: req.body.sizes || '', colors: req.body.colors || ''
  };
  const { error } = await supabase.from('products').update(product).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/products/:id', auth, ownsRow('products'), async (req, res) => {
  const { error } = await supabase.from('products').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── PROPERTIES (real estate) ──────────────────────────────────────────────────

app.get('/properties', auth, ownQuery, async (req, res) => {
  const { vendor_id } = req.query;
  let query = supabase.from('properties').select('*').order('created_at', { ascending: false });
  if (vendor_id) query = query.eq('vendor_id', vendor_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/properties', auth, ownBody, async (req, res) => {
  const b = req.body;
  const property = {
    vendor_id: b.vendor_id || null,
    title: b.title, listing_type: b.listing_type, property_type: b.property_type,
    price: b.price, price_period: b.price_period || null,
    bedrooms: b.bedrooms || null, bathrooms: b.bathrooms || null, toilets: b.toilets || null,
    land_size: b.land_size || null, land_size_unit: b.land_size_unit || null,
    area: b.area || '', city: b.city || '', state: b.state || '',
    address_private: b.address_private || '', tenure: b.tenure || '',
    description: b.description || '', features: b.features || [],
    images: b.images || [], status: b.status || 'available', active: b.active !== false
  };
  const { data, error } = await supabase.from('properties').insert([property]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.put('/properties/:id', auth, ownsRow('properties'), async (req, res) => {
  const b = req.body;
  const property = {
    title: b.title, listing_type: b.listing_type, property_type: b.property_type,
    price: b.price, price_period: b.price_period || null,
    bedrooms: b.bedrooms || null, bathrooms: b.bathrooms || null, toilets: b.toilets || null,
    land_size: b.land_size || null, land_size_unit: b.land_size_unit || null,
    area: b.area || '', city: b.city || '', state: b.state || '',
    address_private: b.address_private || '', tenure: b.tenure || '',
    description: b.description || '', features: b.features || [],
    images: b.images || [], status: b.status, active: b.active
  };
  const { error } = await supabase.from('properties').update(property).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/properties/:id', auth, ownsRow('properties'), async (req, res) => {
  const { error } = await supabase.from('properties').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── LEADS (real estate pipeline) ──────────────────────────────────────────────

app.get('/leads', auth, ownQuery, async (req, res) => {
  const { vendor_id, stage } = req.query;
  let query = supabase.from('leads').select('*').order('last_contact_at', { ascending: false });
  if (vendor_id) query = query.eq('vendor_id', vendor_id);
  if (stage)     query = query.eq('stage', stage);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/leads/:id', auth, ownsRow('leads'), async (req, res) => {
  const allowed = ['name','listing_type','property_type','budget_min','budget_max',
                    'preferred_area','bedrooms_wanted','timeline','notes','assigned_agent_id'];
  const patch = {};
  for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k];
  const { error } = await supabase.from('leads').update(patch).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.put('/leads/:id/stage', auth, ownsRow('leads'), async (req, res) => {
  const { stage } = req.body;
  const valid = ['new','contacted','viewing_scheduled','offer_made','closed_won','closed_lost'];
  if (!valid.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });
  const patch = { stage };
  if (['viewing_scheduled','offer_made','closed_won','closed_lost'].includes(stage)) {
    patch.next_followup_at = null;
  }
  const { error } = await supabase.from('leads').update(patch).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/leads/pipeline-summary', auth, ownQuery, async (req, res) => {
  const { vendor_id } = req.query;
  try {
    let q = supabase.from('leads').select('stage');
    if (vendor_id) q = q.eq('vendor_id', vendor_id);
    const { data } = await q;
    const counts = { new:0, contacted:0, viewing_scheduled:0, offer_made:0, closed_won:0, closed_lost:0 };
    (data || []).forEach(l => { if (counts[l.stage] !== undefined) counts[l.stage]++; });
    res.json(counts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── VIEWINGS (real estate) ─────────────────────────────────────────────────────

app.get('/viewings', auth, ownQuery, async (req, res) => {
  const { vendor_id, status } = req.query;
  let query = supabase.from('viewings').select('*, leads(name, phone), properties(title, area, city)')
    .order('created_at', { ascending: false });
  if (vendor_id) query = query.eq('vendor_id', vendor_id);
  if (status)    query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/viewings/:id/status', auth, ownsRow('viewings'), async (req, res) => {
  const { status } = req.body;
  const valid = ['requested','confirmed','completed','cancelled','no_show'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const { error } = await supabase.from('viewings').update({ status }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.put('/viewings/:id', auth, ownsRow('viewings'), async (req, res) => {
  const allowed = ['requested_date','requested_time','notes'];
  const patch = {};
  for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k];
  const { error } = await supabase.from('viewings').update(patch).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── AUTH (ecommerce) ───────────────────────────────────────────────────────────

app.post('/signup', async (req, res) => {
  const { name, business_name, email, whatsapp_number, business_type, about, password, country } = req.body;
  if (!password || String(password).length < 6) return res.json({ success: false, error: 'Password must be at least 6 characters' });
  const { data: existing } = await supabase.from('vendors').select('id').eq('email', email).single();
  if (existing) return res.json({ success: false, error: 'Email already registered' });
  const { data, error } = await supabase
    .from('vendors')
    .insert([{
      name, business_name, email, whatsapp_number, business_type, about, password: await bcrypt.hash(String(password), 10),
      active: false, country: country || 'Nigeria', product_type: 'ecommerce'
    }])
    .select();
  if (error) return res.json({ success: false, error: error.message });
  console.log(`New ecommerce signup: ${business_name} (${country || 'Nigeria'}) — ${email}`);
  res.json({ success: true });
});

// ─── AUTH (real estate) ─────────────────────────────────────────────────────────

app.post('/signup-re', async (req, res) => {
  const { name, business_name, email, whatsapp_number, about, password, country } = req.body;
  if (!password || String(password).length < 6) return res.json({ success: false, error: 'Password must be at least 6 characters' });
  const { data: existing } = await supabase.from('vendors').select('id').eq('email', email).single();
  if (existing) return res.json({ success: false, error: 'Email already registered' });

  const trial_ends_at = new Date(Date.now() + TRIAL_DAYS * 24 * 3600 * 1000).toISOString();

  const { data, error } = await supabase
    .from('vendors')
    .insert([{
      name, business_name, email, whatsapp_number,
      business_type: 'real_estate_agent', about, password: await bcrypt.hash(String(password), 10),
      active: false, country: country || 'Nigeria',
      product_type: 'real_estate', plan: 'trial',
      subscription_status: 'trialing', trial_ends_at
    }])
    .select();
  if (error) return res.json({ success: false, error: error.message });
  console.log(`New RE signup: ${business_name} (${country || 'Nigeria'}) — ${email}`);
  res.json({ success: true });
});

// ─── LOGIN (shared) ─────────────────────────────────────────────────────────────

app.post('/login', vendorLoginLimiter, async (req, res) => {
  const { email, password } = req.body;
  const { data: vendor } = await supabase.from('vendors').select('*').eq('email', email).single();
  if (!vendor || !password) return res.json({ success: false, error: 'Invalid email or password' });

  // Supports old plain text passwords and upgrades them to a hash on the first successful login
  const stored = vendor.password || '';
  const isHashed = stored.startsWith('$2');
  const ok = isHashed ? await bcrypt.compare(String(password), stored) : stored === password;
  if (!ok) return res.json({ success: false, error: 'Invalid email or password' });
  if (!isHashed) {
    const hash = await bcrypt.hash(String(password), 10);
    await supabase.from('vendors').update({ password: hash }).eq('id', vendor.id);
  }
  if (!vendor.active) return res.json({ success: false, error: 'Your account is pending approval. We will notify you within 48 hours.' });
  res.json({ success: true, vendor: {
    id: vendor.id, name: vendor.name, business_name: vendor.business_name,
    email: vendor.email, whatsapp_connected: vendor.whatsapp_connected,
    country: vendor.country || 'Nigeria', bot_instructions: vendor.bot_instructions || '',
    product_type: vendor.product_type || 'ecommerce',
    plan: vendor.plan || 'trial', subscription_status: vendor.subscription_status || 'trialing',
    trial_ends_at: vendor.trial_ends_at || null,
    token: jwt.sign({ role: 'vendor', vendor_id: vendor.id }, process.env.JWT_SECRET, { expiresIn: '30d' })
  }});
});

// ─── BOT TRAINING ───────────────────────────────────────────────────────────────

app.put('/vendors/:id/bot-instructions', auth, ownParam, async (req, res) => {
  const { bot_instructions } = req.body;
  const { error } = await supabase.from('vendors').update({ bot_instructions }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── ADMIN ──────────────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

// Open route: exchanges the admin password for a token
app.post('/admin/login', loginLimiter, (req, res) => {
  if (!process.env.ADMIN_PASSWORD || !process.env.JWT_SECRET)
    return res.status(500).json({ error: 'Server auth is not configured' });
  if (req.body.password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Incorrect password' });
  const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

function requireAdmin(req, res, next) {
  const p = readToken(req);
  if (!p || p.role !== 'admin') return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Everything below this line under /admin needs a valid token
app.use('/admin', requireAdmin);

app.get('/admin/vendors', async (req, res) => {
  const { product_type } = req.query;
  let query = supabase.from('vendors').select('*').order('created_at', { ascending: false });
  if (product_type) query = query.eq('product_type', product_type);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  // never send vendor passwords to the browser
  res.json(data.map(({ password, ...v }) => v));
});

app.put('/admin/vendors/:id', async (req, res) => {
  const { active } = req.body;
  const { error } = await supabase.from('vendors').update({ active }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Manual billing activation (bank transfer confirmed by admin)
app.put('/admin/vendors/:id/activate-plan', async (req, res) => {
  const { plan } = req.body; // 'pro' | 'enterprise'
  if (!['pro', 'enterprise'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
  const periodEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const { error } = await supabase.from('vendors').update({
    plan, subscription_status: 'active', trial_ends_at: periodEnd
  }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── WHATSAPP ───────────────────────────────────────────────────────────────────

app.post('/vendors/:id/connect', auth, ownParam, async (req, res) => {
  const vendorId = req.params.id;
  const { data: vendor, error } = await supabase.from('vendors').select('*').eq('id', vendorId).single();
  if (error || !vendor) return res.status(404).json({ error: 'Vendor not found' });
  if (!vendor.active) return res.status(403).json({ error: 'Vendor not approved' });
  connectVendor(vendorId, vendor.business_name);
  res.json({ success: true });
});

app.get('/vendors/:id/qr-image', auth, ownParam, (req, res) => {
  const qr = getQR(req.params.id);
  if (qr) {
    return res.json({
      status: 'ready',
      url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`
    });
  }
  res.status(202).json({ status: 'not_ready' });
});

app.get('/vendors/:id/status', auth, ownParam, async (req, res) => {
  const { data: vendor } = await supabase.from('vendors')
    .select('whatsapp_connected, business_name, product_type, plan, subscription_status, trial_ends_at')
    .eq('id', req.params.id).single();
  res.json(vendor || { whatsapp_connected: false });
});

app.post('/vendors/:id/disconnect', auth, ownParam, async (req, res) => {
  const { error } = await supabase.from('vendors').update({ whatsapp_connected: false }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── ORDERS (ecommerce) ─────────────────────────────────────────────────────────

app.get('/orders', auth, ownQuery, async (req, res) => {
  const { vendor_id } = req.query;
  let query = supabase.from('orders').select('*').order('created_at', { ascending: false });
  if (vendor_id) query = query.eq('vendor_id', vendor_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/orders/stats', auth, ownQuery, async (req, res) => {
  const { vendor_id } = req.query;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let query = supabase.from('orders').select('*').gte('created_at', today.toISOString());
  if (vendor_id) query = query.eq('vendor_id', vendor_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  const orders_today  = data.length;
  const revenue_today = data.reduce((sum, o) => sum + (parseFloat(o.total_price) || 0), 0);
  res.json({ orders_today, revenue_today });
});

app.put('/orders/:id/status', auth, ownsRow('orders'), async (req, res) => {
  const { status } = req.body;
  const { error } = await supabase.from('orders').update({ status }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── NOTIFICATIONS (shared) ──────────────────────────────────────────────────────

app.get('/notifications', auth, ownQuery, async (req, res) => {
  const { vendor_id } = req.query;
  let query = supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(20);
  if (vendor_id) query = query.eq('vendor_id', vendor_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// IMPORTANT: read-all must come BEFORE /:id/read
app.put('/notifications/read-all', auth, ownBody, async (req, res) => {
  const { vendor_id } = req.body;
  let query = supabase.from('notifications').update({ read: true });
  if (vendor_id) query = query.eq('vendor_id', vendor_id);
  const { error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.put('/notifications/:id/read', auth, ownsRow('notifications'), async (req, res) => {
  const { error } = await supabase.from('notifications').update({ read: true }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── ANALYTICS (ecommerce) ───────────────────────────────────────────────────────

app.get('/analytics/revenue', auth, ownQuery, async (req, res) => {
  const { vendor_id } = req.query;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
    days.push(d);
  }
  try {
    const results = [];
    for (const day of days) {
      const next = new Date(day); next.setDate(next.getDate() + 1);
      let q = supabase.from('orders').select('total_price')
        .gte('created_at', day.toISOString()).lt('created_at', next.toISOString())
        .neq('status','cancelled');
      if (vendor_id) q = q.eq('vendor_id', vendor_id);
      const { data } = await q;
      const revenue = (data||[]).reduce((sum,o) => sum+(parseFloat(o.total_price)||0),0);
      results.push({ date: day.toLocaleDateString('en-GB',{weekday:'short',day:'numeric'}), revenue });
    }
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/analytics/conversion', auth, ownQuery, async (req, res) => {
  const { vendor_id } = req.query;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
    days.push(d);
  }
  try {
    const results = [];
    for (const day of days) {
      const next = new Date(day); next.setDate(next.getDate() + 1);
      let cq = supabase.from('conversations').select('id',{count:'exact'})
        .gte('started_at',day.toISOString()).lt('started_at',next.toISOString());
      if (vendor_id) cq = cq.eq('vendor_id', vendor_id);
      let oq = supabase.from('orders').select('id',{count:'exact'})
        .gte('created_at',day.toISOString()).lt('created_at',next.toISOString());
      if (vendor_id) oq = oq.eq('vendor_id', vendor_id);
      const [{ count: convs },{ count: ords }] = await Promise.all([cq, oq]);
      results.push({ date: day.toLocaleDateString('en-GB',{weekday:'short',day:'numeric'}), conversations: convs||0, orders: ords||0 });
    }
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/analytics/top-products', auth, ownQuery, async (req, res) => {
  const { vendor_id } = req.query;
  try {
    let q = supabase.from('orders').select('items, total_price').neq('status','cancelled');
    if (vendor_id) q = q.eq('vendor_id', vendor_id);
    const { data } = await q;
    const counts = {}, revenue = {};
    (data||[]).forEach(o => {
      const name = (o.items||'Unknown').trim();
      counts[name]  = (counts[name]  || 0) + 1;
      revenue[name] = (revenue[name] || 0) + (parseFloat(o.total_price)||0);
    });
    const top = Object.entries(counts).map(([name,orders]) => ({ name, orders, revenue: revenue[name]||0 })).sort((a,b) => b.orders-a.orders).slice(0,5);
    res.json(top);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/analytics/order-status', auth, ownQuery, async (req, res) => {
  const { vendor_id } = req.query;
  try {
    let q = supabase.from('orders').select('status');
    if (vendor_id) q = q.eq('vendor_id', vendor_id);
    const { data } = await q;
    const counts = { pending:0, confirmed:0, delivered:0, cancelled:0 };
    (data||[]).forEach(o => { if (counts[o.status]!==undefined) counts[o.status]++; });
    res.json(counts);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/analytics/summary', auth, ownQuery, async (req, res) => {
  const { vendor_id } = req.query;
  try {
    let oq = supabase.from('orders').select('total_price, status').neq('status','cancelled');
    if (vendor_id) oq = oq.eq('vendor_id', vendor_id);
    let cq = supabase.from('conversations').select('id',{count:'exact'});
    if (vendor_id) cq = cq.eq('vendor_id', vendor_id);
    const [{ data: orders },{ count: totalConvs }] = await Promise.all([oq, cq]);
    const totalRevenue = (orders||[]).reduce((s,o) => s+(parseFloat(o.total_price)||0),0);
    const totalOrders  = (orders||[]).length;
    const convRate     = totalConvs > 0 ? ((totalOrders/totalConvs)*100).toFixed(1) : '0.0';
    res.json({ totalRevenue, totalOrders, totalConvs: totalConvs||0, convRate });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── ANALYTICS (real estate) ─────────────────────────────────────────────────────

app.get('/analytics-re/summary', auth, ownQuery, async (req, res) => {
  const { vendor_id } = req.query;
  try {
    let lq = supabase.from('leads').select('id, stage');
    if (vendor_id) lq = lq.eq('vendor_id', vendor_id);
    let vq = supabase.from('viewings').select('id, status');
    if (vendor_id) vq = vq.eq('vendor_id', vendor_id);
    let pq = supabase.from('properties').select('id').eq('status', 'available');
    if (vendor_id) pq = pq.eq('vendor_id', vendor_id);

    const [{ data: leads }, { data: viewings }, { data: properties }] = await Promise.all([lq, vq, pq]);

    const totalLeads       = (leads || []).length;
    const closedWon         = (leads || []).filter(l => l.stage === 'closed_won').length;
    const viewingsScheduled = (viewings || []).filter(v => v.status !== 'cancelled').length;
    const convRate          = totalLeads > 0 ? ((closedWon / totalLeads) * 100).toFixed(1) : '0.0';

    res.json({
      totalLeads, closedWon, viewingsScheduled,
      activeListings: (properties || []).length, convRate
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/analytics-re/leads-over-time', auth, ownQuery, async (req, res) => {
  const { vendor_id } = req.query;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
    days.push(d);
  }
  try {
    const results = [];
    for (const day of days) {
      const next = new Date(day); next.setDate(next.getDate() + 1);
      let q = supabase.from('leads').select('id',{count:'exact'})
        .gte('created_at', day.toISOString()).lt('created_at', next.toISOString());
      if (vendor_id) q = q.eq('vendor_id', vendor_id);
      const { count } = await q;
      results.push({ date: day.toLocaleDateString('en-GB',{weekday:'short',day:'numeric'}), leads: count || 0 });
    }
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────

app.use('/webhook', require('./webhook'));
app.get('/', (req, res) => res.json({ message: 'Nexua OrderFlow server running!' }));

async function reconnectActiveVendors() {
  try {
    const { data: vendors } = await supabase.from('vendors').select('id, business_name').eq('active', true);
    if (!vendors?.length) return;
    console.log(`Auto-reconnecting ${vendors.length} active vendor(s)...`);
    for (const vendor of vendors) connectVendor(String(vendor.id), vendor.business_name);
  } catch (e) {
    console.error('Auto-reconnect error:', e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Nexua OrderFlow server running on port ${PORT}`);
  reconnectActiveVendors();
  startFollowUpWorker();
});