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

app.use('/webhook', require('./webhook'));

app.get('/', (req, res) => res.json({ message: 'Rady server running!' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));