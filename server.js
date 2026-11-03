import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { createDropshipRouter } from './dropship.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const LEGACY_SALT = 'brightcart_secure_salt_v1_2026';
const memoryUsers = new Map();
const memoryOrders = [];
const loginFailures = new Map();

// Middlewares
app.use(helmet());
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean)
  : '*';
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// MongoDB Schemas & Models
const productSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  category: { type: String, required: true },
  price: { type: Number, required: true },
  originalPrice: Number,
  rating: { type: Number, default: 4.5 },
  reviews: { type: Number, default: 0 },
  stock: { type: Number, default: 10 },
  image: String,
  description: String,
  featured: { type: Boolean, default: false },
  tag: String,
  sku: String,
  cost: Number,
  status: { type: String, enum: ['Active', 'Draft', 'Out of Stock'], default: 'Active' },
  supplier: String,
  supplierDetails: mongoose.Schema.Types.Mixed,
  variants: [mongoose.Schema.Types.Mixed],
  verifiedFacts: [String],
  policyReviewed: { type: Boolean, default: false },
  inventoryVerified: { type: Boolean, default: false },
  researchId: String,
  publishedAt: Date,
}, { timestamps: true });

const orderSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  customer: { type: String, required: true },
  email: String,
  phone: String,
  country: String,
  date: String,
  items: Array,
  address: String,
  city: String,
  state: String,
  paymentMethod: String,
  subtotal: Number,
  shipping: Number,
  tax: Number,
  total: { type: Number, required: true },
  status: { type: String, default: 'Pending' },
  supplier: String,
  tracking: String,
  paymentStatus: { type: String, enum: ['unpaid', 'pending_verification', 'paid', 'cancelled', 'refunded'], default: 'unpaid' },
  paymentReference: String,
  paymentVerification: String,
  paymentVerifiedBy: String,
  paymentVerifiedAt: Date,
  supplierPurchaseStatus: { type: String, default: 'not_started' },
  supplierPurchaseId: String,
  supplierSpend: Number,
}, { timestamps: true });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  role: { type: String, default: 'customer' },
  status: { type: String, default: 'Active' },
  phone: String,
  country: String,
}, { timestamps: true });

const Product = mongoose.model('Product', productSchema);
const Order = mongoose.model('Order', orderSchema);
const User = mongoose.model('User', userSchema);

// Initial Products Data
const INITIAL_PRODUCTS = [
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
  { id: 11, name: 'MagShield Wireless Pad', category: 'phone-accessories', price: 39, originalPrice: 59, rating: 4.5, reviews: 367, stock: 120, image: '/charger.jpg', description: '15W MagSafe-compatible wireless charging pad with LED status indicator and anti-slip base.', featured: false, tag: 'Wireless' },
  { id: 12, name: 'ArmorCase Titan Series', category: 'phone-accessories', price: 29, originalPrice: 45, rating: 4.6, reviews: 612, stock: 300, image: '/case.jpg', description: 'Military-grade drop protection, raised bezels, magsafe compatible, matte finish.', featured: false, tag: 'Protection' },
  { id: 13, name: 'ClearView Screen Shield', category: 'phone-accessories', price: 19, originalPrice: 29, rating: 4.4, reviews: 934, stock: 500, image: '/case.jpg', description: 'Tempered glass screen protector, 9H hardness, anti-fingerprint coating, easy alignment kit.', featured: false, tag: 'Pack of 2' },
  { id: 14, name: 'SoundBar Mini BT Speaker', category: 'phone-accessories', price: 79, originalPrice: 109, rating: 4.6, reviews: 278, stock: 85, image: '/speaker.jpg', description: '360° surround sound, IPX7 waterproof, 20hr battery, RGB ambient light effects.', featured: false, tag: 'Waterproof' },
  { id: 15, name: 'FlexMount Car Holder', category: 'phone-accessories', price: 25, originalPrice: 39, rating: 4.5, reviews: 445, stock: 180, image: '/case.jpg', description: 'Universal dashboard/vent mount, one-hand operation, 360° rotation, fits 4-7" phones.', featured: false, tag: 'Universal' },
  { id: 16, name: 'PowerBank Ultra 20000', category: 'phone-accessories', price: 59, originalPrice: 85, rating: 4.7, reviews: 389, stock: 95, image: '/charger.jpg', description: '20000mAh, 22.5W fast charge, USB-C + 2x USB-A ports, digital battery display.', featured: false, tag: '3 Ports' },
  { id: 17, name: 'NeckBand Pro Sport', category: 'phone-accessories', price: 45, originalPrice: 65, rating: 4.3, reviews: 201, stock: 70, image: '/earbuds.jpg', description: 'Magnetic earbuds, IPX5, 10hr battery, deep bass, inline mic for calls.', featured: false, tag: 'Sport' },
  { id: 18, name: 'SmartWatch Sync Band', category: 'phone-accessories', price: 99, originalPrice: 139, rating: 4.6, reviews: 316, stock: 55, image: '/smartwatch.jpg', description: 'Heart rate, SpO2, sleep tracking, 7-day battery, AMOLED always-on display.', featured: false, tag: 'Health' },
  { id: 19, name: 'UltraHub Pro 12-in-1', category: 'laptop-accessories', price: 89, originalPrice: 129, rating: 4.8, reviews: 487, stock: 110, image: '/hub.jpg', description: 'USB-C hub: 4K HDMI, 100W PD, 4xUSB-A, SD/MicroSD, Ethernet, 3.5mm audio.', featured: true, tag: 'Best Hub' },
  { id: 20, name: 'MechKey TKL Keyboard', category: 'laptop-accessories', price: 129, originalPrice: 179, rating: 4.7, reviews: 298, stock: 65, image: '/keyboard.jpg', description: 'Tenkeyless mechanical keyboard, Cherry MX switches, RGB backlit, aluminium frame.', featured: false, tag: 'Mechanical' },
  { id: 21, name: 'ErgoGlide Pro Mouse', category: 'laptop-accessories', price: 69, originalPrice: 99, rating: 4.6, reviews: 421, stock: 130, image: '/mouse.jpg', description: 'Ergonomic wireless mouse, 4000 DPI, silent clicks, 90-day battery, multi-device.', featured: false, tag: 'Ergonomic' },
  { id: 22, name: 'LapStand Aluminium Pro', category: 'laptop-accessories', price: 55, originalPrice: 79, rating: 4.7, reviews: 356, stock: 88, image: '/hub.jpg', description: 'Adjustable aluminium laptop stand, 15° to 50° tilt, fits 10-17" laptops, foldable.', featured: false, tag: 'Adjustable' },
  { id: 23, name: 'CoolPad Dual Fan X5', category: 'laptop-accessories', price: 39, originalPrice: 55, rating: 4.4, reviews: 213, stock: 75, image: '/fan.jpg', description: 'Dual 140mm fans, adjustable height, USB-powered, ultra-quiet <25dB operation.', featured: false, tag: 'Cooling' },
  { id: 24, name: 'PrivacyGuard Filter 15"', category: 'laptop-accessories', price: 49, originalPrice: 69, rating: 4.3, reviews: 167, stock: 60, image: '/monitor.jpg', description: '15.6" laptop privacy screen filter, blocks 60° side view, anti-glare coating.', featured: false, tag: 'Privacy' },
  { id: 25, name: 'LapBag Pro Backpack', category: 'laptop-accessories', price: 79, originalPrice: 109, rating: 4.8, reviews: 534, stock: 95, image: '/hub.jpg', description: '30L waterproof backpack, fits 17" laptop, USB charging port, anti-theft zipper.', featured: true, tag: 'Waterproof' },
  { id: 26, name: 'WristRest Gel Pad Set', category: 'laptop-accessories', price: 22, originalPrice: 34, rating: 4.5, reviews: 289, stock: 200, image: '/mouse.jpg', description: 'Memory foam wrist rest set for keyboard + mouse, non-slip base, soft fabric cover.', featured: false, tag: 'Comfort' },
  { id: 27, name: 'PortableMonitor 15.6"', category: 'laptop-accessories', price: 199, originalPrice: 269, rating: 4.7, reviews: 143, stock: 30, image: '/monitor.jpg', description: '15.6" 1080p portable monitor, USB-C + mini HDMI, 60Hz, 300 nit, with case.', featured: false, tag: 'Portable' },
  { id: 28, name: 'CleanKit Pro 7-in-1', category: 'laptop-accessories', price: 18, originalPrice: 28, rating: 4.4, reviews: 678, stock: 400, image: '/keyboard.jpg', description: 'Laptop cleaning kit: microfiber cloth, screen spray, air blower, brushes, keyboard cover.', featured: false, tag: 'Essential' },
  { id: 29, name: 'SmartPlug 4-Port Tower', category: 'electrical', price: 45, originalPrice: 65, rating: 4.6, reviews: 387, stock: 120, image: '/speaker.jpg', description: '4 AC outlets + 4 USB ports, surge protection, individual switches, 2500W capacity.', featured: false, tag: 'Surge Guard' },
  { id: 30, name: 'BrightLight LED Strip Kit', category: 'electrical', price: 35, originalPrice: 55, rating: 4.5, reviews: 512, stock: 200, image: '/speaker.jpg', description: '5m RGB LED strip, app control, music sync, 16M colors, self-adhesive backing.', featured: false, tag: 'RGB' },
  { id: 31, name: 'DeskFan Quiet 12"', category: 'electrical', price: 55, originalPrice: 79, rating: 4.4, reviews: 234, stock: 70, image: '/fan.jpg', description: '3-speed settings, 50dB ultra-quiet, 12" blade, 8hr timer, USB powered option.', featured: false, tag: 'Quiet' },
  { id: 32, name: 'UPS Guardian 1000VA', category: 'electrical', price: 149, originalPrice: 199, rating: 4.7, reviews: 156, stock: 35, image: '/speaker.jpg', description: '1000VA/600W UPS, 6 outlets, AVR, LCD display, protects against power outages.', featured: false, tag: 'Power Guard' },
  { id: 33, name: 'AirPurifier Mini Desk', category: 'electrical', price: 89, originalPrice: 119, rating: 4.5, reviews: 198, stock: 50, image: '/fan.jpg', description: 'HEPA + activated carbon filter, 3 speeds, night mode, 99.97% particle removal.', featured: false, tag: 'HEPA' },
  { id: 34, name: 'WirelessCharger Station 3-in-1', category: 'electrical', price: 69, originalPrice: 99, rating: 4.6, reviews: 301, stock: 80, image: '/charger.jpg', description: 'Charges phone + earbuds + watch simultaneously, 15W max, slim design, LED indicator.', featured: false, tag: '3-in-1' },
];

const memoryProducts = [...INITIAL_PRODUCTS];

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) return reject(error);
      resolve(`scrypt$${salt.toString('hex')}$${derived.toString('hex')}`);
    });
  });
}

function safeHashMatch(left, right) {
  try {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt$')) {
    const [, saltHex, expectedHex] = stored.split('$');
    if (!saltHex || !expectedHex) return false;
    return new Promise(resolve => {
      crypto.scrypt(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
        resolve(!error && safeHashMatch(derived.toString('hex'), expectedHex));
      });
    });
  }

  // Upgrade old records after a successful login; this branch is migration-only.
  const legacy = crypto.createHash('sha256').update(password + LEGACY_SALT).digest('hex');
  return safeHashMatch(legacy, stored);
}

function publicUser(user) {
  return {
    id: String(user._id || user.id),
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    phone: user.phone || '',
    country: user.country || '',
  };
}

function signSession(user) {
  if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be configured with at least 32 characters.');
  const token = jwt.sign({ sub: String(user._id || user.id) }, JWT_SECRET, { expiresIn: '8h' });
  return { token, expiresAt: Date.now() + 8 * 60 * 60 * 1000 };
}

async function bootstrapSuperAdmin() {
  const email = String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD || '';
  if (!email || password.length < 12) {
    console.warn('⚠️ Super admin bootstrap skipped. Set SUPER_ADMIN_EMAIL and a 12+ character SUPER_ADMIN_PASSWORD.');
    return;
  }
  const passwordHash = await hashPassword(password);
  const userData = { name: 'Super Admin', email, role: 'super_admin', passwordHash, status: 'Active' };
  if (mongoose.connection.readyState === 1) {
    await User.findOneAndUpdate({ email }, { $set: userData }, { upsert: true, new: true, setDefaultsOnInsert: true });
  } else {
    const old = memoryUsers.get(email);
    memoryUsers.set(email, { ...userData, id: old?.id || crypto.randomUUID() });
  }
  console.log(`✅ Super admin configured for ${email}.`);
}

async function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (mongoose.connection.readyState === 1) return User.findOne({ email: normalized });
  return memoryUsers.get(normalized) || null;
}

async function findUserById(id) {
  if (mongoose.connection.readyState === 1) {
    if (!mongoose.isValidObjectId(id)) return null;
    return User.findById(id);
  }
  return [...memoryUsers.values()].find(user => String(user.id) === String(id)) || null;
}

function saveUser(user) {
  if (mongoose.connection.readyState === 1) return user.save();
  memoryUsers.set(String(user.email).toLowerCase(), user);
  return user;
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ success: false, error: 'Sign in required.' });
  if (!JWT_SECRET || JWT_SECRET.length < 32) return res.status(503).json({ success: false, error: 'Authentication is unavailable until JWT_SECRET is configured.' });
  let claims;
  try { claims = jwt.verify(match[1], JWT_SECRET); }
  catch { return res.status(401).json({ success: false, error: 'Session is invalid or expired. Sign in again.' }); }
  findUserById(claims.sub).then(user => {
    if (!user || user.status !== 'Active') return res.status(401).json({ success: false, error: 'Account is unavailable. Sign in again.' });
    req.user = user;
    next();
  }).catch(next);
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ success: false, error: 'Your account role cannot perform this action.' });
    next();
  };
}

function loginAttemptKey(req, email) {
  return `${req.ip || 'unknown'}:${String(email || '').trim().toLowerCase()}`;
}

function getLoginLock(key) {
  const item = loginFailures.get(key);
  if (!item) return null;
  if (item.lockedUntil > Date.now()) return Math.ceil((item.lockedUntil - Date.now()) / 1000);
  if (item.lockedUntil) {
    item.lockedUntil = 0;
    item.attempts = 0;
  }
  return null;
}

function recordLoginFailure(key) {
  const item = loginFailures.get(key) || { attempts: 0, lockedUntil: 0, lockouts: 0 };
  item.attempts += 1;
  if (item.attempts >= 5) {
    item.lockouts += 1;
    item.lockedUntil = Date.now() + Math.min(30_000 * (2 ** (item.lockouts - 1)), 30 * 60_000);
    item.attempts = 0;
  }
  loginFailures.set(key, item);
  return getLoginLock(key);
}

// Database Connection & Auto-Seed
async function connectDB() {
  if (!MONGODB_URI) {
    console.warn('⚠️ MONGODB_URI not provided. Running with in-memory store.');
    await bootstrapSuperAdmin();
    return;
  }
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB Atlas successfully.');

    // Auto-seed initial catalog if empty
    const productCount = await Product.countDocuments();
    if (productCount === 0) {
      await Product.insertMany(INITIAL_PRODUCTS);
      console.log('🌱 Seeded 34 default products into MongoDB.');
    }

    await bootstrapSuperAdmin();
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
  }
}

async function getAllProducts() {
  if (mongoose.connection.readyState === 1) return Product.find().lean();
  return memoryProducts;
}

async function saveProduct(data, existingId = null) {
  const id = existingId == null ? (Number(data.id) || Date.now()) : Number(existingId);
  const next = { ...data, id };
  if (mongoose.connection.readyState === 1) {
    if (existingId != null) return Product.findOneAndUpdate({ id }, { $set: next }, { new: true, runValidators: true });
    return Product.create(next);
  }
  const index = memoryProducts.findIndex(product => Number(product.id) === id);
  if (index >= 0) memoryProducts[index] = { ...memoryProducts[index], ...next };
  else memoryProducts.unshift(next);
  return index >= 0 ? memoryProducts[index] : next;
}

async function findProduct(sku, name, id) {
  if (id != null && Number.isFinite(id)) {
    if (mongoose.connection.readyState === 1) return Product.findOne({ id }).lean();
    return memoryProducts.find(product => Number(product.id) === id) || null;
  }
  const normalizedName = String(name || '').trim().toLowerCase();
  const normalizedSku = String(sku || '').trim().toLowerCase();
  if (!normalizedName && !normalizedSku) return null;
  const products = await getAllProducts();
  return products.find(product =>
    (normalizedSku && String(product.sku || '').toLowerCase() === normalizedSku) ||
    (normalizedName && String(product.name || '').trim().toLowerCase() === normalizedName)
  ) || null;
}

async function getAllOrders() {
  if (mongoose.connection.readyState === 1) return Order.find().sort({ createdAt: -1 }).lean();
  return memoryOrders;
}

async function findOrder(id) {
  const normalized = String(id);
  if (mongoose.connection.readyState === 1) return Order.findOne({ id: normalized });
  return memoryOrders.find(order => String(order.id) === normalized) || null;
}

async function saveOrder(order) {
  if (mongoose.connection.readyState === 1) {
    const found = await Order.findOne({ id: String(order.id) });
    if (!found) return Order.create(order);
    Object.assign(found, order);
    return found.save();
  }
  const index = memoryOrders.findIndex(existing => String(existing.id) === String(order.id));
  if (index < 0) memoryOrders.unshift(order);
  else memoryOrders[index] = order;
  return order;
}

// API Routes
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    name: 'BrightCart API',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'memory-only',
    authenticationConfigured: Boolean(JWT_SECRET && JWT_SECRET.length >= 32),
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/auth/register', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || name.length > 100 || password.length < 10) {
    return res.status(400).json({ success: false, error: 'Enter a valid email and name, and use a password of at least 10 characters.' });
  }
  if (!JWT_SECRET || JWT_SECRET.length < 32) return res.status(503).json({ success: false, error: 'Authentication is not configured. Set a strong JWT_SECRET on the server.' });
  try {
    if (await findUserByEmail(email)) return res.status(409).json({ success: false, error: 'An account with this email already exists.' });
    const userData = {
      name,
      email,
      passwordHash: await hashPassword(password),
      role: 'customer',
      status: 'Active',
      phone: String(req.body.phone || '').trim(),
      country: String(req.body.country || '').trim(),
    };
    let user;
    if (mongoose.connection.readyState === 1) user = await User.create(userData);
    else {
      user = { ...userData, id: crypto.randomUUID() };
      memoryUsers.set(email, user);
    }
    const session = signSession(user);
    res.status(201).json({ success: true, ...session, user: publicUser(user) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password are required.' });
  if (!JWT_SECRET || JWT_SECRET.length < 32) return res.status(503).json({ success: false, error: 'Authentication is not configured. Set a strong JWT_SECRET on the server.' });
  const attemptKey = loginAttemptKey(req, email);
  const waitSeconds = getLoginLock(attemptKey);
  if (waitSeconds) return res.status(429).json({ success: false, error: `Too many failed attempts. Try again in ${waitSeconds} seconds.`, retryAfter: waitSeconds });
  try {
    const user = await findUserByEmail(email);
    const legacySuperAdmin = user?.role === 'super_admin' && !String(user.passwordHash || '').startsWith('scrypt$');
    const bootstrappedEmail = String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
    const valid = user && user.status === 'Active' && !(legacySuperAdmin && bootstrappedEmail !== email) && await verifyPassword(password, user.passwordHash);
    if (!valid) {
      const retryAfter = recordLoginFailure(attemptKey);
      if (retryAfter) return res.status(429).json({ success: false, error: `Too many failed attempts. Try again in ${retryAfter} seconds.`, retryAfter });
      return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    }
    loginFailures.delete(attemptKey);
    if (!String(user.passwordHash).startsWith('scrypt$')) {
      user.passwordHash = await hashPassword(password);
      await saveUser(user);
    }
    const session = signSession(user);
    res.json({ success: true, ...session, user: publicUser(user) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ success: true, user: publicUser(req.user) });
});

// The storefront sees only live products. Legacy catalog records without a status remain visible.
app.get('/api/products', async (_req, res) => {
  try {
    const products = await getAllProducts();
    const items = products.filter(product => product.status !== 'Draft' && product.status !== 'Out of Stock')
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map(product => {
        const { cost, supplier, supplierDetails, verifiedFacts, policyReviewed, inventoryVerified, researchId, ...publicProduct } = product.toObject ? product.toObject() : product;
        return publicProduct;
      });
    res.json({ success: true, count: items.length, data: items });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const adminRoles = requireRoles('super_admin', 'admin', 'moderator');
const editorRoles = requireRoles('super_admin', 'admin');

app.get('/api/admin/products', authenticate, editorRoles, async (_req, res) => {
  try { res.json({ success: true, data: (await getAllProducts()).sort((a, b) => Number(b.id) - Number(a.id)) }); }
  catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/admin/products', authenticate, editorRoles, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const category = String(req.body.category || '').trim();
    const price = Number(req.body.price);
    if (!name || !category || !Number.isFinite(price) || price <= 0) return res.status(400).json({ success: false, error: 'Product name, category, and a positive price are required.' });
    const data = { ...req.body, name, category, price, id: Date.now(), status: ['Draft', 'Out of Stock'].includes(req.body.status) ? req.body.status : 'Active' };
    const created = await saveProduct(data);
    res.status(201).json({ success: true, data: created });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.patch('/api/admin/products/:id', authenticate, editorRoles, async (req, res) => {
  try {
    const current = await findProduct(null, null, Number(req.params.id));
    if (!current) return res.status(404).json({ success: false, error: 'Product not found.' });
    const patch = { ...req.body };
    delete patch.id;
    delete patch._id;
    if (patch.status && !['Active', 'Draft', 'Out of Stock'].includes(patch.status)) return res.status(400).json({ success: false, error: 'Invalid product status.' });
    const saved = await saveProduct({ ...current, ...patch }, Number(req.params.id));
    res.json({ success: true, data: saved });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.delete('/api/admin/products/:id', authenticate, editorRoles, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (mongoose.connection.readyState === 1) await Product.deleteOne({ id });
    else {
      const index = memoryProducts.findIndex(product => Number(product.id) === id);
      if (index >= 0) memoryProducts.splice(index, 1);
    }
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

async function createOrder(req, res) {
  try {
    const customer = String(req.body.customer || req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const incomingItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (!customer || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || incomingItems.length === 0) {
      return res.status(400).json({ success: false, error: 'Customer name, valid email, and at least one product are required.' });
    }
    const catalog = await getAllProducts();
    const items = [];
    for (const incoming of incomingItems) {
      const productId = incoming.product?.id ?? incoming.productId;
      const product = catalog.find(item => String(item.id) === String(productId) && item.status !== 'Draft' && item.status !== 'Out of Stock');
      const qty = Number(incoming.qty || 1);
      if (!product || !Number.isInteger(qty) || qty < 1 || qty > 99) return res.status(400).json({ success: false, error: 'A product is unavailable or has an invalid quantity. Refresh the cart and try again.' });
      const { cost, supplier, supplierDetails, verifiedFacts, policyReviewed, inventoryVerified, ...safeProduct } = product.toObject ? product.toObject() : product;
      const supplierUnitCost = supplierDetails?.unitCost ?? cost;
      const supplierShippingCost = Number(supplierDetails?.shippingCost || 0);
      const supplierCost = supplierUnitCost !== null && supplierUnitCost !== undefined && supplierUnitCost !== '' && Number.isFinite(Number(supplierUnitCost))
        ? Number(supplierUnitCost) + (Number.isFinite(supplierShippingCost) ? supplierShippingCost : 0)
        : null;
      items.push({ product: safeProduct, qty, supplierCost, supplierName: product.supplier || null });
    }
    const subtotal = items.reduce((sum, item) => sum + Number(item.product.price) * item.qty, 0);
    const shipping = subtotal > 50 ? 0 : 4.99;
    const tax = subtotal * 0.08;
    const paystack = String(req.body.paymentMethod || '').toLowerCase().includes('paystack');
    const order = {
      id: `ORD-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
      customer,
      email,
      phone: String(req.body.phone || '').trim(),
      country: String(req.body.country || '').trim(),
      address: String(req.body.address || '').trim(),
      city: String(req.body.city || '').trim(),
      state: String(req.body.state || '').trim(),
      date: new Date().toISOString(),
      items,
      subtotal,
      shipping,
      tax,
      total: subtotal + shipping + tax,
      status: paystack ? 'Pending payment verification' : 'Pending',
      paymentStatus: paystack ? 'pending_verification' : 'unpaid',
      paymentReference: paystack ? String(req.body.paymentRef || '').trim() : undefined,
      paymentVerification: paystack ? 'client_callback_unverified' : undefined,
      paymentMethod: String(req.body.paymentMethod || ''),
      supplierPurchaseStatus: 'not_started',
    };
    const created = await saveOrder(order);
    res.status(201).json({ success: true, data: created, paymentStatus: created.paymentStatus });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
}

app.post('/api/orders', createOrder);
app.get('/api/admin/orders', authenticate, adminRoles, async (_req, res) => {
  try { res.json({ success: true, data: await getAllOrders() }); }
  catch (error) { res.status(500).json({ success: false, error: error.message }); }
});
app.get('/api/orders', authenticate, adminRoles, async (_req, res) => {
  try { res.json({ success: true, data: await getAllOrders() }); }
  catch (error) { res.status(500).json({ success: false, error: error.message }); }
});
app.get('/api/account/orders', authenticate, async (req, res) => {
  try {
    const orders = (await getAllOrders()).filter(order => String(order.email || '').toLowerCase() === String(req.user.email).toLowerCase());
    res.json({ success: true, data: orders.map(order => ({ ...order, items: (order.items || []).map(item => ({ ...item, supplierCost: undefined, supplierName: undefined })) })) });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.patch('/api/admin/orders/:id', authenticate, adminRoles, async (req, res) => {
  try {
    const order = await findOrder(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });
    if (req.body.status && ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled', 'Canceled', 'Refunded'].includes(req.body.status)) order.status = req.body.status;
    await saveOrder(order);
    res.json({ success: true, data: order });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/admin/users', authenticate, requireRoles('super_admin'), async (_req, res) => {
  try {
    const users = mongoose.connection.readyState === 1
      ? await User.find().select('-passwordHash').sort({ createdAt: -1 }).lean()
      : [...memoryUsers.values()];
    res.json({ success: true, data: users.map(publicUser) });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/admin/users', authenticate, requireRoles('super_admin'), async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = ['admin', 'moderator'].includes(req.body.role) ? req.body.role : 'moderator';
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) return res.status(400).json({ success: false, error: 'Name, valid email, and 10+ character password are required.' });
  if (await findUserByEmail(email)) return res.status(409).json({ success: false, error: 'An account with this email already exists.' });
  try {
    const userData = { name, email, passwordHash: await hashPassword(password), role, status: 'Active' };
    const user = mongoose.connection.readyState === 1 ? await User.create(userData) : { ...userData, id: crypto.randomUUID() };
    if (mongoose.connection.readyState !== 1) memoryUsers.set(email, user);
    res.status(201).json({ success: true, data: publicUser(user) });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.patch('/api/admin/users/:id', authenticate, requireRoles('super_admin'), async (req, res) => {
  try {
    const user = mongoose.connection.readyState === 1
      ? await User.findById(req.params.id)
      : [...memoryUsers.values()].find(item => String(item.id) === String(req.params.id));
    if (!user || user.role === 'super_admin') return res.status(404).json({ success: false, error: 'Managed team member not found.' });
    if (['Active', 'Disabled'].includes(req.body.status)) user.status = req.body.status;
    if (['admin', 'moderator'].includes(req.body.role)) user.role = req.body.role;
    if (typeof req.body.password === 'string' && req.body.password.length >= 10) user.passwordHash = await hashPassword(req.body.password);
    if (mongoose.connection.readyState === 1) await user.save();
    else memoryUsers.set(String(user.email).toLowerCase(), user);
    res.json({ success: true, data: publicUser(user) });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.delete('/api/admin/users/:id', authenticate, requireRoles('super_admin'), async (req, res) => {
  try {
    if (mongoose.connection.readyState === 1) await User.deleteOne({ _id: req.params.id, role: { $ne: 'super_admin' } });
    else {
      const entry = [...memoryUsers.entries()].find(([, user]) => String(user.id) === String(req.params.id) && user.role !== 'super_admin');
      if (entry) memoryUsers.delete(entry[0]);
    }
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.use('/api/dropship', createDropshipRouter({
  authenticate,
  requireAdmin: adminRoles,
  requirePublisher: editorRoles,
  getAllProducts,
  getAllOrders,
  saveProduct,
  findProduct,
  saveOrder,
  findOrder,
}));

app.listen(PORT, async () => {
  console.log(`🚀 BrightCart Backend API running on port ${PORT}`);
  await connectDB();
});
