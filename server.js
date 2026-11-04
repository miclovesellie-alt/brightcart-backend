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
const DEFAULT_STORE_SETTINGS = {
  supportEmail: '',
  whatsappNumber: '',
  notificationEmail: '',
  socials: { instagram: '', facebook: '', tiktok: '', youtube: '', x: '' },
  notifications: { customerOrderConfirmation: true, adminNewOrder: true, customerOrderStatus: true },
};

// Middlewares
app.use(helmet());
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean)
  : '*';
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '1mb', verify: (req, _res, buffer) => { req.rawBody = buffer; } }));
app.use(morgan('dev'));

// MongoDB Schemas & Models
const productSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  category: { type: String, required: true },
  price: { type: Number, required: true },
  originalPrice: Number,
  inputCurrency: { type: String, default: 'USD' },
  rating: { type: Number, default: 0 },
  reviews: { type: Number, default: 0 },
  isSample: { type: Boolean, default: false },
  stock: { type: Number, default: 10 },
  image: String,
  images: { type: [String], default: [] },
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
  trackingUrl: String,
  paymentStatus: { type: String, enum: ['unpaid', 'pending_verification', 'paid', 'cancelled', 'refunded'], default: 'unpaid' },
  paymentReference: String,
  paymentCurrency: String,
  paymentAmount: Number,
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

const storeSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  supportEmail: { type: String, default: '' },
  whatsappNumber: { type: String, default: '' },
  notificationEmail: { type: String, default: '' },
  socials: {
    instagram: { type: String, default: '' },
    facebook: { type: String, default: '' },
    tiktok: { type: String, default: '' },
    youtube: { type: String, default: '' },
    x: { type: String, default: '' },
  },
  notifications: {
    customerOrderConfirmation: { type: Boolean, default: true },
    adminNewOrder: { type: Boolean, default: true },
    customerOrderStatus: { type: Boolean, default: true },
  },
}, { timestamps: true });

const Product = mongoose.model('Product', productSchema);
const Order = mongoose.model('Order', orderSchema);
const User = mongoose.model('User', userSchema);
const StoreSettings = mongoose.model('StoreSettings', storeSettingsSchema);
let memoryStoreSettings = JSON.parse(JSON.stringify(DEFAULT_STORE_SETTINGS));

// Initial Products Data
// IDs 1–34 belong to the original sample catalog. Keep them out of the live store.
const LEGACY_SAMPLE_PRODUCT_IDS = Array.from({ length: 34 }, (_, index) => index + 1);
const memoryProducts = [];

function isSampleProduct(product) {
  return product?.isSample === true
    || (LEGACY_SAMPLE_PRODUCT_IDS.includes(Number(product?.id)) && product?.isSample !== false);
}

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

// Database Connection & Catalog Cleanup
async function connectDB() {
  if (!MONGODB_URI) {
    console.warn('⚠️ MONGODB_URI not provided. Running with in-memory store.');
    await bootstrapSuperAdmin();
    return;
  }
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB Atlas successfully.');

    // Archive the original demo products without deleting their records.
    const archivedSamples = await Product.updateMany(
      { id: { $in: LEGACY_SAMPLE_PRODUCT_IDS }, isSample: { $exists: false } },
      { $set: { isSample: true, status: 'Draft', featured: false } },
    );
    if (archivedSamples.modifiedCount > 0) {
      console.log(`Archived ${archivedSamples.modifiedCount} sample catalog records as drafts.`);
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

async function findOrderByPaymentReference(reference) {
  const normalized = String(reference || '').trim();
  if (!normalized) return null;
  if (mongoose.connection.readyState === 1) return Order.findOne({ paymentReference: normalized });
  return memoryOrders.find(order => String(order.paymentReference || '') === normalized) || null;
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

function publicStoreSettings(settings = {}) {
  return {
    supportEmail: String(settings.supportEmail || ''),
    whatsappNumber: String(settings.whatsappNumber || ''),
    notificationEmail: String(settings.notificationEmail || ''),
    socials: { ...DEFAULT_STORE_SETTINGS.socials, ...(settings.socials || {}) },
    notifications: { ...DEFAULT_STORE_SETTINGS.notifications, ...(settings.notifications || {}) },
  };
}

async function getStoreSettings() {
  if (mongoose.connection.readyState === 1) {
    const settings = await StoreSettings.findOne({ key: 'main' }).lean();
    return publicStoreSettings(settings || DEFAULT_STORE_SETTINGS);
  }
  return publicStoreSettings(memoryStoreSettings);
}

async function saveStoreSettings(settings) {
  const next = publicStoreSettings(settings);
  if (mongoose.connection.readyState === 1) {
    return StoreSettings.findOneAndUpdate(
      { key: 'main' },
      { $set: next, $setOnInsert: { key: 'main' } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
  }
  memoryStoreSettings = next;
  return publicStoreSettings(memoryStoreSettings);
}

function optionalEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address or leave it blank.');
  return email;
}

function optionalSocialUrl(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.toString();
  } catch {
    throw new Error('Social links must be complete http or https URLs.');
  }
}

function optionalWhatsAppNumber(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  let digits = input.replace(/\D/g, '');
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    if (!['wa.me', 'api.whatsapp.com', 'web.whatsapp.com'].includes(url.hostname.toLowerCase())) {
      throw new Error('Enter a WhatsApp phone number or WhatsApp link.');
    }
    digits = (url.pathname.match(/\d+/g) || []).join('') || (url.searchParams.get('phone') || '').replace(/\D/g, '');
  }
  if (digits.length < 8 || digits.length > 15) throw new Error('Enter a WhatsApp number with its country code.');
  return digits;
}

function normalizeStoreSettingsInput(input = {}, current = DEFAULT_STORE_SETTINGS) {
  const existing = publicStoreSettings(current);
  const socials = { ...existing.socials };
  const notifications = { ...existing.notifications };
  const allowedSocials = Object.keys(socials);
  const allowedNotifications = Object.keys(notifications);
  if (input.socials && typeof input.socials === 'object') {
    for (const key of allowedSocials) if (key in input.socials) socials[key] = optionalSocialUrl(input.socials[key]);
  }
  if (input.notifications && typeof input.notifications === 'object') {
    for (const key of allowedNotifications) if (key in input.notifications) notifications[key] = Boolean(input.notifications[key]);
  }
  return {
    supportEmail: 'supportEmail' in input ? optionalEmail(input.supportEmail) : existing.supportEmail,
    notificationEmail: 'notificationEmail' in input ? optionalEmail(input.notificationEmail) : existing.notificationEmail,
    whatsappNumber: 'whatsappNumber' in input ? optionalWhatsAppNumber(input.whatsappNumber) : existing.whatsappNumber,
    socials,
    notifications,
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function emailProviderStatus() {
  return {
    configured: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
    sender: process.env.EMAIL_FROM ? String(process.env.EMAIL_FROM).trim() : '',
    provider: 'Resend',
  };
}

async function sendTransactionalEmail({ to, subject, text, html }) {
  const status = emailProviderStatus();
  if (!status.configured || !to) return false;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: status.sender, to: [to], subject, text, html }),
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return true;
}

const PAYSTACK_CURRENCIES = new Set(['GHS', 'NGN', 'USD', 'ZAR', 'KES']);
let paystackRatesCache = { fetchedAt: 0, rates: null };

async function getPaystackRate(currency) {
  if (currency === 'USD') return 1;
  if (!PAYSTACK_CURRENCIES.has(currency)) return null;
  if (!paystackRatesCache.rates || Date.now() - paystackRatesCache.fetchedAt > 60 * 60 * 1000) {
    const response = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Exchange rate service returned ${response.status}.`);
    const payload = await response.json();
    if (payload.result !== 'success' || !payload.rates) throw new Error('Exchange rate service did not return current rates.');
    paystackRatesCache = { fetchedAt: Date.now(), rates: payload.rates };
  }
  const rate = Number(paystackRatesCache.rates[currency]);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

async function checkPaystackPayment(order) {
  const secret = String(process.env.PAYSTACK_SECRET_KEY || '').trim();
  if (!secret) return { verified: false, error: 'Server-side Paystack verification is not configured.' };
  if (!order?.paymentReference) return { verified: false, error: 'This order has no Paystack reference.' };
  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(order.paymentReference)}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(12000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== true || !payload.data) {
    return { verified: false, error: payload.message || `Paystack verification returned ${response.status}.` };
  }

  const transaction = payload.data;
  const expectedCurrency = String(order.paymentCurrency || '').toUpperCase();
  const currency = expectedCurrency || String(transaction.currency || '').toUpperCase();
  if (!PAYSTACK_CURRENCIES.has(currency)) return { verified: false, error: 'The payment currency is missing or unsupported.' };
  if (String(transaction.reference || '') !== String(order.paymentReference)) return { verified: false, error: 'The Paystack reference does not match this order.' };
  if (String(transaction.status || '').toLowerCase() !== 'success') return { verified: false, error: `Paystack reports this payment as ${transaction.status || 'unconfirmed'}.` };
  if (String(transaction.currency || '').toUpperCase() !== currency) return { verified: false, error: 'The Paystack transaction currency does not match the order.' };
  const transactionEmail = String(transaction.customer?.email || '').trim().toLowerCase();
  if (transactionEmail && transactionEmail !== String(order.email || '').trim().toLowerCase()) return { verified: false, error: 'The Paystack payer email does not match the order.' };

  let rate;
  try { rate = await getPaystackRate(currency); }
  catch (error) { return { verified: false, error: `Could not confirm the currency conversion: ${error.message}` }; }
  if (!rate) return { verified: false, error: 'Could not determine the expected payment amount for this currency.' };
  const expectedAmount = Math.round(Number(order.total || 0) * rate * 100);
  if (!Number.isFinite(expectedAmount) || Number(transaction.amount) !== expectedAmount) {
    return { verified: false, error: 'The amount paid does not match the current order total.' };
  }
  if (!order.paymentCurrency) order.paymentCurrency = currency;
  return { verified: true, amount: transaction.amount, currency };
}

async function markOrderPaymentVerified(order, source, notifyStatusChange = true) {
  if (order.paymentStatus === 'paid') return order;
  const previousStatus = order.status;
  order.paymentStatus = 'paid';
  order.paymentVerification = `paystack_${source}`;
  order.paymentVerifiedAt = new Date();
  if (order.status === 'Pending payment verification') order.status = 'Pending';
  const saved = await saveOrder(order);
  if (notifyStatusChange && previousStatus !== saved.status) {
    void notifyOrderStatusChanged(saved).catch(error => console.error('Could not prepare order status email:', error.message));
  }
  return saved;
}

async function notifyOrderCreated(order) {
  const settings = await getStoreSettings();
  const notifications = settings.notifications;
  const itemsText = (order.items || []).map(item => `${item.qty} × ${item.product?.name || 'Product'}`).join('\n');
  const itemsHtml = (order.items || []).map(item => `<li>${escapeHtml(item.qty)} × ${escapeHtml(item.product?.name || 'Product')}</li>`).join('');
  const total = Number(order.total || 0).toFixed(2);
  const customerTasks = notifications.customerOrderConfirmation
    ? [sendTransactionalEmail({
      to: order.email,
      subject: `Shoppercart order ${order.id} received`,
      text: `Hi ${order.customer},\n\nWe received your order ${order.id}.\n${itemsText}\nTotal: ${total}\nStatus: ${order.status}\n\nThank you for shopping with Shoppercart.`,
      html: `<p>Hi ${escapeHtml(order.customer)},</p><p>We received your order <strong>${escapeHtml(order.id)}</strong>.</p><ul>${itemsHtml}</ul><p>Total: <strong>${escapeHtml(total)}</strong></p><p>Status: ${escapeHtml(order.status)}</p><p>Thank you for shopping with Shoppercart.</p>`,
    })]
    : [];
  const adminTasks = notifications.adminNewOrder && settings.notificationEmail
    ? [sendTransactionalEmail({
      to: settings.notificationEmail,
      subject: `New Shoppercart order ${order.id}`,
      text: `${order.customer} placed an order.\nCustomer: ${order.email}\n${itemsText}\nTotal: ${total}`,
      html: `<p><strong>${escapeHtml(order.customer)}</strong> placed order ${escapeHtml(order.id)}.</p><p>Customer: ${escapeHtml(order.email)}</p><ul>${itemsHtml}</ul><p>Total: <strong>${escapeHtml(total)}</strong></p>`,
    })]
    : [];
  const results = await Promise.allSettled([...customerTasks, ...adminTasks]);
  results.filter(result => result.status === 'rejected').forEach(result => console.error('Order notification email failed:', result.reason?.message));
}

async function notifyOrderStatusChanged(order) {
  const settings = await getStoreSettings();
  if (!settings.notifications.customerOrderStatus) return;
  try {
    await sendTransactionalEmail({
      to: order.email,
      subject: `Shoppercart order ${order.id} update`,
      text: `Hi ${order.customer},\n\nYour order ${order.id} is now ${order.status}.${order.tracking ? `\nTracking number: ${order.tracking}` : ''}${order.trackingUrl ? `\nTrack your shipment: ${order.trackingUrl}` : ''}\n\nThank you for shopping with us.`,
      html: `<p>Hi ${escapeHtml(order.customer)},</p><p>Your order <strong>${escapeHtml(order.id)}</strong> is now <strong>${escapeHtml(order.status)}</strong>.</p>${order.tracking ? `<p>Tracking number: <strong>${escapeHtml(order.tracking)}</strong></p>` : ''}${order.trackingUrl ? `<p><a href="${escapeHtml(order.trackingUrl)}">Track your shipment</a></p>` : ''}<p>Thank you for shopping with us.</p>`,
    });
  } catch (error) {
    console.error('Order status email failed:', error.message);
  }
}

// API Routes
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    name: 'Store API',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'memory-only',
    authenticationConfigured: Boolean(JWT_SECRET && JWT_SECRET.length >= 32),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/store-settings', async (_req, res) => {
  try {
    const settings = await getStoreSettings();
    res.json({ success: true, data: { supportEmail: settings.supportEmail, whatsappNumber: settings.whatsappNumber, socials: settings.socials } });
  }
  catch (error) { res.status(500).json({ success: false, error: error.message }); }
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

// The storefront sees only live, user-managed products.
app.get('/api/products', async (_req, res) => {
  try {
    const products = await getAllProducts();
    const items = products.filter(product =>
      !isSampleProduct(product)
      && product.status !== 'Draft'
      && product.status !== 'Out of Stock'
    )
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map(product => {
        const { cost, supplier, supplierDetails, verifiedFacts, policyReviewed, inventoryVerified, researchId, ...publicProduct } = product.toObject ? product.toObject() : product;
        delete publicProduct.isSample;
        return publicProduct;
      });
    res.json({ success: true, count: items.length, data: items });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const adminRoles = requireRoles('super_admin', 'admin', 'moderator');
const editorRoles = requireRoles('super_admin', 'admin');
const storeSettingsAdmin = requireRoles('super_admin');

app.get('/api/admin/store-settings', authenticate, storeSettingsAdmin, async (_req, res) => {
  try {
    res.json({ success: true, data: await getStoreSettings(), email: emailProviderStatus() });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.patch('/api/admin/store-settings', authenticate, storeSettingsAdmin, async (req, res) => {
  try {
    const current = await getStoreSettings();
    const next = normalizeStoreSettingsInput(req.body || {}, current);
    await saveStoreSettings(next);
    res.json({ success: true, data: next, email: emailProviderStatus() });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});

app.post('/api/admin/store-settings/test-email', authenticate, storeSettingsAdmin, async (_req, res) => {
  const emailStatus = emailProviderStatus();
  if (!emailStatus.configured) return res.status(503).json({ success: false, error: 'Email is not configured. Add RESEND_API_KEY and EMAIL_FROM to the backend environment.' });
  try {
    const settings = await getStoreSettings();
    if (!settings.notificationEmail) return res.status(400).json({ success: false, error: 'Save an admin notification inbox before sending a test email.' });
    await sendTransactionalEmail({
      to: settings.notificationEmail,
      subject: 'Your store email setup is working',
      text: 'This is a test email from your store admin settings. Your email provider and notification inbox are connected.',
      html: '<p>This is a test email from your store admin settings.</p><p>Your email provider and notification inbox are connected.</p>',
    });
    res.json({ success: true, sentTo: settings.notificationEmail, message: `Test email sent to ${settings.notificationEmail}.` });
  } catch (error) {
    res.status(502).json({ success: false, error: `Could not send the test email: ${error.message}` });
  }
});

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
    const images = [...new Set((Array.isArray(req.body.images) ? req.body.images : [req.body.image])
      .filter(value => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean))];
    const data = { ...req.body, name, category, price, image: images[0] || '', images, id: Date.now(), status: ['Draft', 'Out of Stock'].includes(req.body.status) ? req.body.status : 'Active' };
    delete data.isSample;
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
    delete patch.isSample;
    if (Object.prototype.hasOwnProperty.call(patch, 'images') || Object.prototype.hasOwnProperty.call(patch, 'image')) {
      const images = [...new Set((Array.isArray(patch.images) ? patch.images : [patch.image ?? current.image])
        .filter(value => typeof value === 'string')
        .map(value => value.trim())
        .filter(Boolean))];
      patch.images = images;
      patch.image = images[0] || '';
    }
    if (patch.status && !['Active', 'Draft', 'Out of Stock'].includes(patch.status)) return res.status(400).json({ success: false, error: 'Invalid product status.' });
    if (current.isSample && patch.status === 'Active') patch.isSample = false;
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
    const paystack = String(req.body.paymentMethod || '').toLowerCase().includes('paystack');
    const paymentReference = paystack ? String(req.body.paymentRef || '').trim() : '';
    const paymentCurrency = paystack ? String(req.body.paymentCurrency || '').trim().toUpperCase() : '';
    if (paystack && !paymentReference) return res.status(400).json({ success: false, error: 'The Paystack transaction reference is required.' });
    if (paystack && !PAYSTACK_CURRENCIES.has(paymentCurrency)) return res.status(400).json({ success: false, error: 'This Paystack currency is not supported for server verification.' });
    if (paystack) {
      const existing = await findOrderByPaymentReference(paymentReference);
      if (existing) {
        if (String(existing.email || '').toLowerCase() !== email) {
          return res.status(409).json({ success: false, error: 'This Paystack reference is already attached to another order.' });
        }
        if (existing.paymentStatus !== 'paid') {
          try {
            const verification = await checkPaystackPayment(existing);
            if (verification.verified) {
              existing.paymentAmount = Number(verification.amount);
              await markOrderPaymentVerified(existing, 'server', false);
            }
          } catch (error) { console.error('Paystack verification could not be completed:', error.message); }
        }
        const saved = await findOrder(existing.id) || existing;
        return res.json({
          success: true,
          data: { id: saved.id, status: saved.status, paymentStatus: saved.paymentStatus, paymentReference: saved.paymentReference, total: saved.total },
          paymentStatus: saved.paymentStatus,
        });
      }
    }
    const catalog = await getAllProducts();
    const items = [];
    for (const incoming of incomingItems) {
      const productId = incoming.product?.id ?? incoming.productId;
      const product = catalog.find(item =>
        String(item.id) === String(productId)
        && !isSampleProduct(item)
        && item.status !== 'Draft'
        && item.status !== 'Out of Stock'
      );
      const qty = Number(incoming.qty || 1);
      if (!product || !Number.isInteger(qty) || qty < 1 || qty > 99) return res.status(400).json({ success: false, error: 'A product is unavailable or has an invalid quantity. Refresh the cart and try again.' });
      const storedProduct = product.toObject ? product.toObject() : product;
      const requestedVariant = incoming.variant && typeof incoming.variant === 'object' ? incoming.variant : null;
      let chosenVariant = null;
      if (requestedVariant) {
        const variantKey = String(requestedVariant.id || requestedVariant.color || requestedVariant.name || '').trim().toLowerCase();
        const variants = Array.isArray(storedProduct.variants) ? storedProduct.variants : [];
        chosenVariant = variants.find(variant =>
          String(variant?.id || variant?.color || variant?.name || '').trim().toLowerCase() === variantKey
          || (variant?.color && String(variant.color).trim().toLowerCase() === variantKey)
          || (variant?.name && String(variant.name).trim().toLowerCase() === variantKey)
        );
        if (!chosenVariant) return res.status(400).json({ success: false, error: 'The selected product color is no longer available. Refresh the product and try again.' });
        if (chosenVariant.stock != null && Number.isInteger(Number(chosenVariant.stock)) && Number(chosenVariant.stock) >= 0 && qty > Number(chosenVariant.stock)) {
          return res.status(409).json({ success: false, error: 'The selected color does not have enough stock.' });
        }
      }
      const { cost, supplier, supplierDetails, verifiedFacts, policyReviewed, inventoryVerified, ...safeProductBase } = storedProduct;
      const safeVariant = chosenVariant ? {
        id: String(chosenVariant.id || chosenVariant.color || chosenVariant.name || ''),
        name: String(chosenVariant.name || chosenVariant.color || ''),
        color: String(chosenVariant.color || chosenVariant.name || ''),
        image: String(chosenVariant.image || chosenVariant.imageUrl || ''),
        images: Array.isArray(chosenVariant.images) ? chosenVariant.images.filter(value => typeof value === 'string').slice(0, 20) : [],
        sku: String(chosenVariant.sku || ''),
      } : null;
      const safeProduct = safeVariant ? {
        ...safeProductBase,
        image: safeVariant.image || safeProductBase.image,
        images: safeVariant.images.length ? safeVariant.images : safeProductBase.images,
      } : safeProductBase;
      const supplierUnitCost = supplierDetails?.unitCost ?? cost;
      const shippingStatus = supplierDetails?.shippingStatus;
      const supplierShippingCost = shippingStatus === 'free'
        ? 0
        : shippingStatus === 'paid' && supplierDetails?.shippingCost !== null && supplierDetails?.shippingCost !== undefined && supplierDetails?.shippingCost !== '' && Number.isFinite(Number(supplierDetails.shippingCost))
          ? Number(supplierDetails.shippingCost)
          : null;
      const supplierCost = supplierUnitCost !== null && supplierUnitCost !== undefined && supplierUnitCost !== ''
        && Number.isFinite(Number(supplierUnitCost)) && supplierShippingCost !== null
        ? Number(supplierUnitCost) + supplierShippingCost
        : null;
      items.push({ product: safeProduct, variant: safeVariant, qty, supplierCost, supplierName: product.supplier || null });
    }
    const subtotal = items.reduce((sum, item) => sum + Number(item.product.price) * item.qty, 0);
    const shipping = subtotal > 50 ? 0 : 4.99;
    const tax = subtotal * 0.08;
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
      paymentReference: paystack ? paymentReference : undefined,
      paymentCurrency: paystack ? paymentCurrency : undefined,
      paymentVerification: paystack ? 'client_callback_unverified' : undefined,
      paymentMethod: String(req.body.paymentMethod || ''),
      supplierPurchaseStatus: 'not_started',
    };
    let created = await saveOrder(order);
    if (paystack && String(process.env.PAYSTACK_SECRET_KEY || '').trim()) {
      try {
        const verification = await checkPaystackPayment(created);
        if (verification.verified) {
          created.paymentAmount = Number(verification.amount);
          created = await markOrderPaymentVerified(created, 'server', false);
        } else {
          created.paymentVerification = 'verification_pending';
          created = await saveOrder(created);
          console.info(`Payment for order ${created.id} needs review: ${verification.error}`);
        }
      } catch (error) {
        created.paymentVerification = 'verification_unavailable';
        created = await saveOrder(created);
        console.error(`Could not verify payment for order ${created.id}:`, error.message);
      }
    }
    void notifyOrderCreated(created).catch(error => console.error('Could not prepare order notification:', error.message));
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

app.post('/api/payments/paystack/webhook', async (req, res) => {
  const secret = String(process.env.PAYSTACK_SECRET_KEY || '').trim();
  if (!secret) return res.status(503).send('Paystack verification is not configured.');
  const signature = String(req.get('x-paystack-signature') || '');
  if (!signature || !req.rawBody) return res.status(400).send('Missing Paystack signature.');
  const expected = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex');
  const suppliedBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    return res.status(401).send('Invalid Paystack signature.');
  }
  if (req.body?.event !== 'charge.success') return res.sendStatus(200);
  try {
    const reference = String(req.body?.data?.reference || '').trim();
    const order = await findOrderByPaymentReference(reference);
    if (!order || order.paymentStatus === 'paid') return res.sendStatus(200);
    const verification = await checkPaystackPayment(order);
    if (!verification.verified) {
      console.warn(`Paystack webhook for order ${order.id} was not verified: ${verification.error}`);
      return res.sendStatus(200);
    }
    order.paymentAmount = Number(verification.amount);
    await markOrderPaymentVerified(order, 'webhook');
    return res.sendStatus(200);
  } catch (error) {
    console.error('Paystack webhook processing failed:', error.message);
    return res.sendStatus(500);
  }
});

app.post('/api/admin/orders/:id/verify-paystack', authenticate, requireRoles('super_admin'), async (req, res) => {
  try {
    const order = await findOrder(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });
    if (!order.paymentReference) return res.status(400).json({ success: false, error: 'This order has no Paystack transaction reference.' });
    if (order.paymentStatus === 'paid') return res.json({ success: true, data: order, message: 'Payment is already verified.' });
    const verification = await checkPaystackPayment(order);
    if (!verification.verified) return res.status(422).json({ success: false, error: verification.error || 'Paystack could not verify this payment.' });
    order.paymentAmount = Number(verification.amount);
    const saved = await markOrderPaymentVerified(order, 'admin_check');
    res.json({ success: true, data: saved, message: 'Paystack payment verified.' });
  } catch (error) {
    res.status(502).json({ success: false, error: `Could not verify this payment with Paystack: ${error.message}` });
  }
});

app.patch('/api/admin/orders/:id', authenticate, adminRoles, async (req, res) => {
  try {
    const order = await findOrder(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });
    const previousStatus = order.status;
    const previousTracking = order.tracking || '';
    const previousTrackingUrl = order.trackingUrl || '';
    if (req.body.status && ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled', 'Canceled', 'Refunded'].includes(req.body.status)) order.status = req.body.status;
    if ('tracking' in req.body) {
      const tracking = String(req.body.tracking || '').trim();
      if (tracking.length > 150) return res.status(400).json({ success: false, error: 'Tracking numbers must be 150 characters or fewer.' });
      order.tracking = tracking;
    }
    if ('trackingUrl' in req.body) {
      const trackingUrl = String(req.body.trackingUrl || '').trim();
      if (trackingUrl) {
        let parsedUrl;
        try { parsedUrl = new URL(trackingUrl); } catch { return res.status(400).json({ success: false, error: 'Enter a valid tracking URL.' }); }
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) return res.status(400).json({ success: false, error: 'Tracking links must use HTTP or HTTPS.' });
      }
      order.trackingUrl = trackingUrl;
    }
    await saveOrder(order);
    if (previousStatus !== order.status || previousTracking !== (order.tracking || '') || previousTrackingUrl !== (order.trackingUrl || '')) {
      void notifyOrderStatusChanged(order).catch(error => console.error('Could not prepare order status email:', error.message));
    }
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
  console.log(`🚀 Shoppercart Backend API running on port ${PORT}`);
  await connectDB();
});
