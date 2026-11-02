import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 5000;
const SALT = 'brightcart_secure_salt_v1_2026';
const SUPER_ADMIN_HASH = 'a8f09f09d505f641026da7912329dd4f847bde674134d960b3c884b5690190ae';

// Middlewares
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(morgan('dev'));

// In-memory persistent database store
let products = [
  { id: 1, name: 'BrightPhone Pro 15', category: 'phones', price: 899, originalPrice: 1099, rating: 4.8, reviews: 312, stock: 45, image: '/phone.jpg', description: 'Flagship smartphone with 6.7" AMOLED display, 200MP camera, and 5000mAh battery. Snapdragon 8 Gen 3 processor.', featured: true, tag: 'Best Seller' },
  { id: 2, name: 'NovaSpark Z12 Ultra', category: 'phones', price: 749, originalPrice: 899, rating: 4.6, reviews: 198, stock: 30, image: '/phone.jpg', description: 'Premium mid-range phone with 6.5" display, 108MP triple camera, and 4800mAh fast-charging battery.', featured: false, tag: 'New' },
  { id: 3, name: 'LunaX Flip Edition', category: 'phones', price: 1099, originalPrice: 1299, rating: 4.7, reviews: 87, stock: 15, image: '/phone.jpg', description: 'Foldable smartphone with 7.2" inner display, compact folded design, and premium build quality.', featured: true, tag: 'Premium' },
  { id: 4, name: 'SwiftEdge 5G Lite', category: 'phones', price: 299, originalPrice: 399, rating: 4.3, reviews: 456, stock: 100, image: '/phone.jpg', description: 'Affordable 5G phone with 6.4" display, 48MP camera, and all-day battery life.', featured: false, tag: 'Value Pick' },
  { id: 5, name: 'TitanV Rugged Phone', category: 'phones', price: 549, originalPrice: 649, rating: 4.5, reviews: 134, stock: 28, image: '/phone.jpg', description: 'Military-grade rugged smartphone with IP68 rating, thermal camera, and massive 6000mAh battery.', featured: false, tag: 'Rugged' },
  { id: 6, name: 'PureLight Camera Phone', category: 'phones', price: 679, originalPrice: 799, rating: 4.9, reviews: 203, stock: 22, image: '/phone.jpg', description: 'Camera-first smartphone with 1-inch sensor, periscope zoom lens, and AI photography features.', featured: false, tag: 'Top Rated' },
  { id: 7, name: 'BrightPhone SE Mini', category: 'phones', price: 399, originalPrice: 479, rating: 4.4, reviews: 289, stock: 60, image: '/phone.jpg', description: 'Compact 5.4" display, powerful A17 chip, stellar camera in a smaller form factor.', featured: false, tag: 'Compact' },
  { id: 8, name: 'GalaxyRise 8 Pro', category: 'phones', price: 829, originalPrice: 999, rating: 4.7, reviews: 167, stock: 35, image: '/phone.jpg', description: 'Stunning curved display, S-Pen included, 45W super-fast charging, DeX desktop mode.', featured: false, tag: 'S-Pen' },
  { id: 9, name: 'ProBuds X3 Wireless Earbuds', category: 'phone-accessories', price: 129, originalPrice: 179, rating: 4.7, reviews: 521, stock: 150, image: '/earbuds.jpg', description: 'Active Noise Cancellation, 8hr playtime + 24hr case, IPX5 water resistant, hi-fi audio.', featured: true, tag: 'Top Seller' },
  { id: 10, name: 'TurboCharge 65W GaN Charger', category: 'phone-accessories', price: 49, originalPrice: 69, rating: 4.8, reviews: 843, stock: 200, image: '/charger.jpg', description: 'GaN technology 65W USB-C charger, charges laptop + phone simultaneously, foldable prongs.', featured: true, tag: 'Essential' },
  { id: 19, name: 'UltraHub Pro 12-in-1', category: 'laptop-accessories', price: 89, originalPrice: 129, rating: 4.8, reviews: 487, stock: 110, image: '/hub.jpg', description: 'USB-C hub: 4K HDMI, 100W PD, 4xUSB-A, SD/MicroSD, Ethernet, 3.5mm audio.', featured: true, tag: 'Best Hub' },
  { id: 20, name: 'MechKey TKL Keyboard', category: 'laptop-accessories', price: 129, originalPrice: 179, rating: 4.7, reviews: 298, stock: 65, image: '/keyboard.jpg', description: 'Tenkeyless mechanical keyboard, Cherry MX switches, RGB backlit, aluminium frame.', featured: false, tag: 'Mechanical' },
  { id: 30, name: 'BrightLight LED Strip Kit', category: 'electrical', price: 35, originalPrice: 55, rating: 4.5, reviews: 512, stock: 200, image: '/speaker.jpg', description: '5m RGB LED strip, app control, music sync, 16M colors, self-adhesive backing.', featured: false, tag: 'RGB' },
];

let orders = [
  { id: 'ORD-8821', customer: 'Alice Johnson', email: 'alice@mail.com', date: 'Nov 1, 2026', items: [{ product: { name: 'BrightPhone Pro 15', price: 899 }, qty: 1 }], total: 899, status: 'Delivered', supplier: 'AliExpress', tracking: 'DHL-928374652' },
  { id: 'ORD-8820', customer: 'Bob Smith', email: 'bob@mail.com', date: 'Nov 1, 2026', items: [{ product: { name: 'ProBuds X3', price: 129 }, qty: 2 }], total: 258, status: 'Shipped', supplier: 'CJ Dropshipping', tracking: 'USPS-87263541' },
];

let adminUsers = [
  { id: 'sa-1', name: 'Super Admin', email: 'boafokyei3@gmail.com', role: 'super_admin', status: 'Active', addedAt: '2026-01-01', passwordHash: SUPER_ADMIN_HASH }
];

// Helper: Hash password
function hashPassword(plaintext) {
  return crypto.createHash('sha256').update(plaintext + SALT).digest('hex');
}

// Routes: Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: 'BrightCart API', timestamp: new Date().toISOString() });
});

// Routes: Products
app.get('/api/products', (req, res) => {
  res.json({ success: true, count: products.length, data: products });
});

app.get('/api/products/:id', (req, res) => {
  const prod = products.find(p => p.id === parseInt(req.params.id, 10));
  if (!prod) return res.status(404).json({ success: false, error: 'Product not found' });
  res.json({ success: true, data: prod });
});

app.post('/api/products', (req, res) => {
  const newProduct = { id: Date.now(), ...req.body };
  products.unshift(newProduct);
  res.status(201).json({ success: true, data: newProduct });
});

// Routes: Orders
app.get('/api/orders', (req, res) => {
  res.json({ success: true, count: orders.length, data: orders });
});

app.post('/api/orders', (req, res) => {
  const newOrder = {
    id: `ORD-${Date.now().toString().slice(-4)}`,
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    status: 'Pending',
    ...req.body
  };
  orders.unshift(newOrder);
  res.status(201).json({ success: true, data: newOrder });
});

// Routes: Auth
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: 'Missing email or password' });

  const admin = adminUsers.find(a => a.email.toLowerCase() === email.toLowerCase());
  if (!admin) {
    return res.json({ success: true, user: { name: email.split('@')[0], email, role: 'customer' } });
  }

  const hash = hashPassword(password);
  if (hash === admin.passwordHash) {
    const token = crypto.randomBytes(32).toString('hex');
    const { passwordHash, ...safeAdmin } = admin;
    return res.json({ success: true, token, user: safeAdmin });
  }

  return res.status(401).json({ success: false, error: 'Invalid credentials' });
});

app.listen(PORT, () => {
  console.log(`BrightCart Backend API running on port ${PORT}`);
});
