import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { createDropshipRouter } from './dropship.js';
import { rateLimit } from './security.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const isProduction = process.env.NODE_ENV === 'production';
const LEGACY_SALT = 'brightcart_secure_salt_v1_2026';
const memoryUsers = new Map();
const memoryOrders = [];
const loginFailures = new Map();
const memoryCheckoutRequests = new Map();
const loginFailureCleanup = setInterval(() => {
  const expiry = Date.now() - 24 * 60 * 60_000;
  for (const [key, item] of loginFailures) if (Number(item.lastAttemptAt || 0) < expiry) loginFailures.delete(key);
}, 60 * 60_000);
loginFailureCleanup.unref?.();
const DEFAULT_STORE_SETTINGS = {
  supportEmail: '',
  whatsappNumber: '',
  notificationEmail: '',
  socials: { instagram: '', facebook: '', tiktok: '', youtube: '', x: '' },
  notifications: { customerOrderConfirmation: true, adminNewOrder: true, customerOrderStatus: true },
};

// Middlewares
app.use(helmet());
const configuredOrigins = String(process.env.CORS_ORIGIN || '').split(',').map(origin => origin.trim()).filter(origin => origin && origin !== '*');
const allowedOrigins = configuredOrigins.length
  ? configuredOrigins
  : ['https://shoppercart.uhcacadamy.com', 'https://brightcart-nine.vercel.app'];
if (!isProduction) allowedOrigins.push('http://localhost:5173', 'http://127.0.0.1:5173');
const uniqueAllowedOrigins = [...new Set(allowedOrigins)].filter(origin => {
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin) return false;
    if (isProduction && (parsed.protocol !== 'https:' || ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname))) return false;
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch { return false; }
});
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS || (isProduction ? '1' : '0'), 10);
app.set('trust proxy', Number.isInteger(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 0);
app.use(cors({
  origin(origin, callback) {
    if (!origin || uniqueAllowedOrigins.includes(origin)) return callback(null, true);
    return callback(Object.assign(new Error('Origin is not allowed.'), { status: 403 }));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  credentials: false,
  maxAge: 600,
}));
app.use(express.json({ limit: '1mb', verify: (req, _res, buffer) => { req.rawBody = buffer; } }));
app.use((req, res, next) => {
  if (isProduction && req.path !== '/api/health' && mongoose.connection.readyState !== 1) {
    return res.status(503).json({ success: false, error: 'Store database is temporarily unavailable. Please retry shortly.' });
  }
  next();
});
app.use(morgan('dev'));

const loginRateLimit = rateLimit({ windowMs: 15 * 60_000, max: 10, keyPrefix: 'login', message: 'Too many sign-in attempts. Try again later.' });
const registerRateLimit = rateLimit({ windowMs: 60 * 60_000, max: 8, keyPrefix: 'register', message: 'Too many account creation attempts. Try again later.' });
const orderRateLimit = rateLimit({ windowMs: 15 * 60_000, max: 20, keyPrefix: 'order-create' });
const paymentInitRateLimit = rateLimit({ windowMs: 15 * 60_000, max: 10, keyPrefix: 'payment-init' });
const paymentVerifyRateLimit = rateLimit({ windowMs: 15 * 60_000, max: 30, keyPrefix: 'payment-verify' });
const testEmailRateLimit = rateLimit({ windowMs: 60 * 60_000, max: 3, keyPrefix: 'test-email', message: 'Too many test emails were requested. Try again later.' });

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
  brand: String,
  barcode: String,
  mpn: String,
  availability: String,
  supplierDetails: mongoose.Schema.Types.Mixed,
  variants: [mongoose.Schema.Types.Mixed],
  specifications: { type: [mongoose.Schema.Types.Mixed], default: [] },
  verifiedFacts: [String],
  policyReviewed: { type: Boolean, default: false },
  inventoryVerified: { type: Boolean, default: false },
  researchId: String,
  publishedAt: Date,
}, { timestamps: true });

const orderSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  customerUserId: String,
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
  paymentStatus: { type: String, enum: ['unpaid', 'pending_verification', 'paid', 'cancelled', 'partially_refunded', 'refunded'], default: 'unpaid' },
  paymentReference: String,
  paymentCurrency: String,
  paymentAmount: Number,
  paymentRefundedAmount: Number,
  paymentRefundIds: { type: [String], default: [] },
  checkoutRequestId: String,
  paymentAuthorizationUrl: String,
  paymentVerification: String,
  paymentVerifiedBy: String,
  paymentVerifiedAt: Date,
  supplierPurchaseStatus: { type: String, default: 'not_started' },
  supplierPurchaseId: String,
  supplierSpend: Number,
}, { timestamps: true });
orderSchema.index({ paymentReference: 1 }, { unique: true, partialFilterExpression: { paymentReference: { $type: 'string' } } });
orderSchema.index({ checkoutRequestId: 1 }, { unique: true, partialFilterExpression: { checkoutRequestId: { $type: 'string' } } });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  role: { type: String, default: 'customer' },
  status: { type: String, default: 'Active' },
  phone: String,
  country: String,
  wishlistProductIds: { type: [Number], default: [] },
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

const notificationSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  recipientId: { type: String, required: true, index: true },
  audience: { type: String, enum: ['admin', 'user'], required: true, index: true },
  type: { type: String, required: true, maxlength: 60 },
  title: { type: String, required: true, maxlength: 140 },
  message: { type: String, required: true, maxlength: 320 },
  page: { type: String, default: '' },
  params: { type: mongoose.Schema.Types.Mixed, default: {} },
  readAt: { type: Date, default: null },
}, { timestamps: true });
notificationSchema.index({ recipientId: 1, audience: 1, createdAt: -1 });

const reviewSchema = new mongoose.Schema({
  productId: { type: Number, required: true, index: true },
  orderId: { type: String, required: true },
  customerUserId: { type: String, required: true, index: true },
  customerName: { type: String, required: true, maxlength: 80 },
  rating: { type: Number, required: true, min: 1, max: 5 },
  title: { type: String, required: true, maxlength: 100 },
  body: { type: String, required: true, maxlength: 1500 },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  moderatedBy: String,
}, { timestamps: true });
reviewSchema.index({ productId: 1, customerUserId: 1 }, { unique: true });

const Product = mongoose.model('Product', productSchema);
const Order = mongoose.model('Order', orderSchema);
const User = mongoose.model('User', userSchema);
const StoreSettings = mongoose.model('StoreSettings', storeSettingsSchema);
const Notification = mongoose.model('Notification', notificationSchema);
const ProductReview = mongoose.model('ProductReview', reviewSchema);
let memoryStoreSettings = JSON.parse(JSON.stringify(DEFAULT_STORE_SETTINGS));

// Initial Products Data
// IDs 1–34 belong to the original sample catalog. Keep them out of the live store.
const LEGACY_SAMPLE_PRODUCT_IDS = Array.from({ length: 34 }, (_, index) => index + 1);
const memoryProducts = [];
const memoryNotifications = [];
const memoryReviews = [];

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
    wishlistProductIds: Array.isArray(user.wishlistProductIds) ? user.wishlistProductIds : [],
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
  if (!email || email.length > 254 || password.length < 12 || password.length > 256) {
    console.warn('⚠️ Super admin bootstrap skipped. Set SUPER_ADMIN_EMAIL and a 12+ character SUPER_ADMIN_PASSWORD.');
    return;
  }
  const passwordHash = await hashPassword(password);
  const userData = { name: 'Super Admin', email, role: 'super_admin', passwordHash, status: 'Active' };
  if (mongoose.connection.readyState === 1) {
    if (!(await User.exists({ email }))) await User.create(userData);
  } else {
    if (!memoryUsers.has(email)) memoryUsers.set(email, { ...userData, id: crypto.randomUUID() });
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

function optionalAuthenticate(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header) return next();
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ success: false, error: 'Session is invalid. Sign in again.' });
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
  if (!loginFailures.has(key) && loginFailures.size >= 50_000) loginFailures.delete(loginFailures.keys().next().value);
  const item = loginFailures.get(key) || { attempts: 0, lockedUntil: 0, lockouts: 0 };
  item.attempts += 1;
  item.lastAttemptAt = Date.now();
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
    if (isProduction) throw new Error('MONGODB_URI is required in production; refusing to start with volatile in-memory storage.');
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
    if (isProduction) throw err;
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
  if (mongoose.connection.readyState === 1) return Order.find().select('-paymentAuthorizationUrl -checkoutRequestId').sort({ createdAt: -1 }).lean();
  return memoryOrders.map(({ paymentAuthorizationUrl: _paymentAuthorizationUrl, checkoutRequestId: _checkoutRequestId, ...order }) => order);
}

async function getProductReviews(productId, includePrivate = false, max = 100) {
  const query = { productId: Number(productId) };
  if (!includePrivate) query.status = 'approved';
  if (mongoose.connection.readyState === 1) {
    const request = ProductReview.find(query).sort({ createdAt: -1 });
    if (max > 0) request.limit(max);
    return request.lean();
  }
  const items = memoryReviews.filter(review => Number(review.productId) === Number(productId) && (includePrivate || review.status === 'approved'))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return max > 0 ? items.slice(0, max) : items;
}

function publicVariant(variant) {
  if (!variant || typeof variant !== 'object') return variant;
  const { unitCost, supplierPrice, supplierCurrency, ...safeVariant } = variant;
  if (safeVariant.attributes && typeof safeVariant.attributes === 'object') {
    safeVariant.attributes = Object.fromEntries(Object.entries(safeVariant.attributes)
      .filter(([key]) => !/(?:cost|price|supplier|margin|profit|currency)/i.test(key))
      .slice(0, 20));
  }
  return safeVariant;
}

async function updateProductReviewSummary(productId) {
  const approved = await getProductReviews(productId, false, 0);
  const product = await findProduct(null, null, Number(productId));
  if (!product) return;
  const rating = approved.length ? Math.round((approved.reduce((sum, item) => sum + Number(item.rating || 0), 0) / approved.length) * 10) / 10 : 0;
  await saveProduct({ ...product, rating, reviews: approved.length }, Number(productId));
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

async function findOrderByCheckoutRequestId(checkoutRequestId) {
  const normalized = String(checkoutRequestId || '').trim();
  if (!normalized) return null;
  if (mongoose.connection.readyState === 1) return Order.findOne({ checkoutRequestId: normalized });
  return memoryCheckoutRequests.get(normalized) || null;
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
  if (order.checkoutRequestId) memoryCheckoutRequests.set(String(order.checkoutRequestId), order);
  return order;
}

const notificationPages = new Set([
  'account', 'admin-orders', 'admin-products', 'admin-dropshipping', 'admin-dashboard', 'admin-reviews',
]);

function publicNotification(notification) {
  return {
    id: String(notification.id),
    type: String(notification.type || ''),
    title: String(notification.title || ''),
    message: String(notification.message || ''),
    page: String(notification.page || ''),
    params: notification.params && typeof notification.params === 'object' && !Array.isArray(notification.params) ? notification.params : {},
    readAt: notification.readAt || null,
    createdAt: notification.createdAt || null,
  };
}

async function createNotification({ recipientId, audience, type, title, message, page = '', params = {} }) {
  const safeRecipientId = String(recipientId || '').trim();
  if (!safeRecipientId || !['admin', 'user'].includes(audience)) return null;
  const entry = {
    id: crypto.randomUUID(),
    recipientId: safeRecipientId,
    audience,
    type: String(type || 'update').slice(0, 60),
    title: String(title || 'Store update').slice(0, 140),
    message: String(message || '').slice(0, 320),
    page: notificationPages.has(String(page)) ? String(page) : '',
    params: params && typeof params === 'object' && !Array.isArray(params) ? params : {},
    readAt: null,
  };
  if (mongoose.connection.readyState === 1) {
    const saved = await Notification.create(entry);
    return saved.toObject();
  }
  memoryNotifications.unshift({ ...entry, createdAt: new Date() });
  if (memoryNotifications.length > 3000) memoryNotifications.length = 3000;
  return memoryNotifications[0];
}

async function notifyAdmins(notification, roles = ['super_admin', 'admin', 'moderator']) {
  try {
    const recipients = mongoose.connection.readyState === 1
      ? await User.find({ role: { $in: roles }, status: 'Active' }).select('_id').lean()
      : [...memoryUsers.values()].filter(user => roles.includes(user.role) && user.status === 'Active');
    await Promise.all(recipients.map(user => createNotification({
      ...notification,
      audience: 'admin',
      recipientId: String(user._id || user.id),
    })));
  } catch (error) {
    console.error('Could not create admin in-app notification:', error.message);
  }
}

async function notifyCustomer(order, notification) {
  const recipientId = String(order?.customerUserId || '').trim();
  if (!recipientId) return;
  try {
    await createNotification({ ...notification, audience: 'user', recipientId });
  } catch (error) {
    console.error('Could not create customer in-app notification:', error.message);
  }
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
const PAYMENT_WEBHOOK_TOLERANCE_SECONDS = 300;

function timingSafeHexMatch(expected, provided) {
  if (!/^[0-9a-f]{128}$/i.test(String(provided || ''))) return false;
  const expectedBuffer = Buffer.isBuffer(expected) ? expected : Buffer.from(expected, 'hex');
  const providedBuffer = Buffer.from(provided, 'hex');
  return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function isValidPaystackWebhook(req) {
  if (!Buffer.isBuffer(req.rawBody)) return false;
  const webhookSignature = String(req.get('paystack-signature') || '');
  const webhookSecrets = [process.env.PAYSTACK_WEBHOOK_SECRET, process.env.PAYSTACK_WEBHOOK_SECRET_PREVIOUS]
    .map(value => String(value || '').trim()).filter(Boolean);
  if (webhookSignature && webhookSecrets.length) {
    let timestamp = null;
    const signatures = [];
    for (const part of webhookSignature.split(',')) {
      const separator = part.indexOf('=');
      if (separator < 0) continue;
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (key === 't') {
        if (timestamp !== null || !/^\d+$/.test(value)) return false;
        timestamp = Number(value);
      } else if (key === 'v1') {
        const colon = value.indexOf(':');
        if (colon > 0) signatures.push(value.slice(colon + 1));
      }
    }
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(timestamp) || !signatures.length || Math.abs(now - timestamp) > PAYMENT_WEBHOOK_TOLERANCE_SECONDS) return false;
    for (const secret of webhookSecrets) {
      const expected = crypto.createHmac('sha512', secret).update(`${timestamp}.`).update(req.rawBody).digest();
      if (signatures.some(signature => timingSafeHexMatch(expected, signature))) return true;
    }
    return false;
  }

  const legacySecret = String(process.env.PAYSTACK_SECRET_KEY || '').trim();
  const legacySignature = String(req.get('x-paystack-signature') || '');
  if (!legacySecret || !legacySignature) return false;
  const expected = crypto.createHmac('sha512', legacySecret).update(req.rawBody).digest();
  return timingSafeHexMatch(expected, legacySignature);
}

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

  let expectedAmount = Number(order.paymentAmount);
  if (!Number.isSafeInteger(expectedAmount) || expectedAmount < 1) {
    let rate;
    try { rate = await getPaystackRate(currency); }
    catch (error) { return { verified: false, error: `Could not confirm the currency conversion: ${error.message}` }; }
    if (!rate) return { verified: false, error: 'Could not determine the expected payment amount for this currency.' };
    expectedAmount = Math.round(Number(order.total || 0) * rate * 100);
  }
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

async function notifyOrderCreatedInApp(order) {
  const itemCount = (order.items || []).reduce((sum, item) => sum + Number(item.qty || 0), 0);
  const tasks = [notifyAdmins({
    type: 'new_order',
    title: 'New order received',
    message: `${order.customer || 'A customer'} placed order ${order.id}.`,
    page: 'admin-orders',
    params: { orderId: String(order.id) },
  })];
  if (order.customerUserId) {
    tasks.push(notifyCustomer(order, {
      type: 'order_received',
      title: 'Order received',
      message: `Order ${order.id} with ${itemCount} item${itemCount === 1 ? '' : 's'} is now ${String(order.status || 'being processed').toLowerCase()}.`,
      page: 'account',
      params: { tab: 'orders' },
    }));
  }
  await Promise.all(tasks);
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
  await notifyCustomer(order, {
    type: 'order_status',
    title: 'Order update',
    message: `Order ${order.id} is now ${order.status}.${order.tracking ? ` Tracking: ${order.tracking}.` : ''}`,
    page: 'account',
    params: { tab: 'orders' },
  });
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
  const databaseConnected = mongoose.connection.readyState === 1;
  res.status(isProduction && !databaseConnected ? 503 : 200).json({
    status: databaseConnected ? 'ok' : (isProduction ? 'degraded' : 'ok'),
    name: 'Store API',
    database: databaseConnected ? 'connected' : (isProduction ? 'unavailable' : 'memory-only'),
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

app.post('/api/auth/register', registerRateLimit, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !name || name.length > 100 || password.length < 10 || password.length > 256
    || String(req.body.phone || '').length > 40 || String(req.body.country || '').length > 100) {
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

app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || email.length > 254 || !password || password.length > 256) return res.status(400).json({ success: false, error: 'Enter a valid email and password.' });
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
        publicProduct.variants = Array.isArray(publicProduct.variants) ? publicProduct.variants.map(publicVariant) : [];
        delete publicProduct.isSample;
        return publicProduct;
      });
    res.json({ success: true, count: items.length, data: items });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/products/:id/reviews', async (req, res) => {
  const productId = Number(req.params.id);
  if (!Number.isSafeInteger(productId) || productId < 1) return res.status(400).json({ success: false, error: 'Invalid product ID.' });
  try {
    const product = await findProduct(null, null, productId);
    if (!product || product.status === 'Draft' || product.status === 'Out of Stock') return res.status(404).json({ success: false, error: 'Product not found.' });
    const reviews = await getProductReviews(productId);
    res.json({ success: true, count: reviews.length, data: reviews.map(({ customerUserId, orderId, moderatedBy, ...review }) => review) });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not load product reviews.' });
  }
});

app.post('/api/products/:id/reviews', authenticate, async (req, res) => {
  const productId = Number(req.params.id);
  const rating = Number(req.body.rating);
  const title = String(req.body.title || '').trim();
  const body = String(req.body.body || '').trim();
  const orderId = String(req.body.orderId || '').trim();
  if (!Number.isSafeInteger(productId) || productId < 1) return res.status(400).json({ success: false, error: 'Invalid product ID.' });
  if (req.user.role !== 'customer') return res.status(403).json({ success: false, error: 'Only customer accounts can submit product reviews.' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !title || title.length > 100 || body.length < 10 || body.length > 1500 || !orderId) {
    return res.status(400).json({ success: false, error: 'Provide a 1–5 star rating, a short title, a review of at least 10 characters, and the order being reviewed.' });
  }
  try {
    const product = await findProduct(null, null, productId);
    if (!product || product.status === 'Draft') return res.status(404).json({ success: false, error: 'Product not found.' });
    const customerUserId = String(req.user._id || req.user.id);
    const order = (await getAllOrders()).find(item => String(item.id) === orderId && String(item.customerUserId || '') === customerUserId && item.paymentStatus === 'paid' && !['cancelled', 'canceled', 'refunded'].includes(String(item.status || '').toLowerCase()));
    const purchased = order?.items?.some(item => Number(item.product?.id ?? item.productId) === productId);
    if (!purchased) return res.status(403).json({ success: false, error: 'Reviews require a verified paid order containing this product.' });
    const duplicate = mongoose.connection.readyState === 1
      ? await ProductReview.exists({ productId, customerUserId })
      : memoryReviews.some(review => Number(review.productId) === productId && review.customerUserId === customerUserId);
    if (duplicate) return res.status(409).json({ success: false, error: 'You have already submitted a review for this product.' });
    const displayName = String(req.user.name || 'Shopper').trim().split(/\s+/);
    const customerName = displayName.length > 1 ? `${displayName[0]} ${displayName[displayName.length - 1].slice(0, 1)}.` : displayName[0];
    const review = {
      productId, orderId, customerUserId, customerName: customerName.slice(0, 80), rating,
      title: title.slice(0, 100), body: body.slice(0, 1500), status: 'pending',
    };
    let saved;
    if (mongoose.connection.readyState === 1) saved = await ProductReview.create(review);
    else {
      saved = { ...review, _id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date() };
      memoryReviews.unshift(saved);
    }
    await notifyAdmins({
      type: 'product_review_pending', title: 'Product review needs approval',
      message: `A verified buyer reviewed ${product.name}.`, page: 'admin-reviews', params: { reviewId: String(saved._id) },
    }, ['super_admin', 'admin', 'moderator']);
    res.status(201).json({ success: true, data: { id: String(saved._id), status: saved.status, message: 'Your review was sent for approval.' } });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ success: false, error: 'You have already submitted a review for this product.' });
    res.status(500).json({ success: false, error: 'Could not save your review.' });
  }
});

const adminRoles = requireRoles('super_admin', 'admin', 'moderator');
const editorRoles = requireRoles('super_admin', 'admin');
const storeSettingsAdmin = requireRoles('super_admin');

function notificationScope(user) {
  return {
    audience: ['super_admin', 'admin', 'moderator'].includes(user?.role) ? 'admin' : 'user',
    recipientId: String(user?._id || user?.id || ''),
  };
}

app.get('/api/notifications', authenticate, async (req, res) => {
  try {
    const scope = notificationScope(req.user);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 30));
    const notifications = mongoose.connection.readyState === 1
      ? await Notification.find(scope).sort({ createdAt: -1 }).limit(limit).lean()
      : memoryNotifications.filter(item => item.audience === scope.audience && item.recipientId === scope.recipientId)
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()).slice(0, limit);
    res.json({ success: true, data: notifications.map(publicNotification) });
  } catch (error) { res.status(500).json({ success: false, error: 'Could not load notifications.' }); }
});

app.patch('/api/notifications/:id/read', authenticate, async (req, res) => {
  try {
    const scope = notificationScope(req.user);
    const readAt = new Date();
    let notification;
    if (mongoose.connection.readyState === 1) {
      notification = await Notification.findOneAndUpdate(
        { id: String(req.params.id), ...scope },
        { $set: { readAt } },
        { new: true },
      ).lean();
    } else {
      notification = memoryNotifications.find(item => item.id === String(req.params.id)
        && item.audience === scope.audience && item.recipientId === scope.recipientId);
      if (notification) notification.readAt = readAt;
    }
    if (!notification) return res.status(404).json({ success: false, error: 'Notification not found.' });
    res.json({ success: true, data: publicNotification(notification) });
  } catch { res.status(500).json({ success: false, error: 'Could not update this notification.' }); }
});

app.post('/api/notifications/read-all', authenticate, async (req, res) => {
  try {
    const scope = notificationScope(req.user);
    const readAt = new Date();
    let updated = 0;
    if (mongoose.connection.readyState === 1) {
      const result = await Notification.updateMany({ ...scope, readAt: null }, { $set: { readAt } });
      updated = result.modifiedCount || 0;
    } else {
      for (const notification of memoryNotifications) {
        if (notification.audience === scope.audience && notification.recipientId === scope.recipientId && !notification.readAt) {
          notification.readAt = readAt;
          updated += 1;
        }
      }
    }
    res.json({ success: true, updated });
  } catch { res.status(500).json({ success: false, error: 'Could not mark notifications as read.' }); }
});

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

app.post('/api/admin/store-settings/test-email', authenticate, storeSettingsAdmin, testEmailRateLimit, async (_req, res) => {
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

app.get('/api/admin/reviews', authenticate, adminRoles, async (req, res) => {
  try {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'all';
    const reviews = mongoose.connection.readyState === 1
      ? await ProductReview.find(status === 'all' ? {} : { status }).sort({ createdAt: -1 }).limit(500).lean()
      : memoryReviews.filter(review => status === 'all' || review.status === status).slice(0, 500);
    const products = await getAllProducts();
    const productNames = new Map(products.map(product => [Number(product.id), product.name]));
    res.json({ success: true, data: reviews.map(review => ({ ...review, productName: productNames.get(Number(review.productId)) || 'Deleted product' })) });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not load product reviews.' });
  }
});

app.patch('/api/admin/reviews/:id', authenticate, adminRoles, async (req, res) => {
  const status = String(req.body.status || '').toLowerCase();
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ success: false, error: 'Choose approved or rejected.' });
  try {
    let review;
    if (mongoose.connection.readyState === 1) {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: 'Review not found.' });
      review = await ProductReview.findByIdAndUpdate(req.params.id, { $set: { status, moderatedBy: String(req.user.email || '') } }, { new: true, runValidators: true }).lean();
    } else {
      review = memoryReviews.find(item => String(item._id) === req.params.id);
      if (review) { review.status = status; review.moderatedBy = String(req.user.email || ''); review.updatedAt = new Date(); }
    }
    if (!review) return res.status(404).json({ success: false, error: 'Review not found.' });
    await updateProductReviewSummary(review.productId);
    res.json({ success: true, data: review });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not update review moderation.' });
  }
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
    if (created.status === 'Draft') {
      await notifyAdmins({
        type: 'product_draft_saved',
        title: 'Product draft saved',
        message: `${created.name} is ready for review in Product Studio.`,
        page: 'admin-dropshipping',
        params: { section: 'studio' },
      }, ['super_admin', 'admin']);
    }
    res.status(201).json({ success: true, data: created });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.patch('/api/admin/products/:id', authenticate, editorRoles, async (req, res) => {
  try {
    const current = await findProduct(null, null, Number(req.params.id));
    if (!current) return res.status(404).json({ success: false, error: 'Product not found.' });
    const patch = { ...req.body };
    const notifyDraftSaved = patch.notifyDraftSaved === true;
    delete patch.id;
    delete patch._id;
    delete patch.isSample;
    delete patch.notifyDraftSaved;
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
    if (notifyDraftSaved && saved.status === 'Draft') {
      await notifyAdmins({
        type: 'product_draft_saved',
        title: 'Product draft saved',
        message: `${saved.name} is saved in Product Studio for review.`,
        page: 'admin-dropshipping',
        params: { section: 'studio' },
      }, ['super_admin', 'admin']);
    }
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

function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function checkoutOrderSummary(order) {
  return {
    id: order.id,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentReference: order.paymentReference || '',
    paymentRef: order.paymentReference || '',
    paymentCurrency: order.paymentCurrency || '',
    total: Number(order.total || 0),
  };
}

async function createOrderRecord(input = {}, payment = {}, customerUserId = '') {
  const customer = String(input.customer || input.name || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const incomingItems = Array.isArray(input.items) ? input.items : [];
  if (!customer || customer.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || incomingItems.length === 0 || incomingItems.length > 50) {
    throw requestError(400, 'Enter a valid customer name and email, with between 1 and 50 products.');
  }
  if (payment.reference && (String(payment.reference).length > 160 || !PAYSTACK_CURRENCIES.has(payment.currency))) {
    throw requestError(400, 'The Paystack transaction details are invalid.');
  }
  const catalog = await getAllProducts();
  const items = [];
  const requestedStock = new Map();
  for (const incoming of incomingItems) {
    const productId = incoming?.product?.id ?? incoming?.productId;
    const product = catalog.find(item => String(item.id) === String(productId)
      && !isSampleProduct(item) && item.status !== 'Draft' && item.status !== 'Out of Stock');
    const qty = Number(incoming?.qty ?? 1);
    if (!product || !Number.isInteger(qty) || qty < 1 || qty > 99) {
      throw requestError(400, 'A product is unavailable or has an invalid quantity. Refresh the cart and try again.');
    }
    const storedProduct = product.toObject ? product.toObject() : product;
    const requestedVariant = incoming?.variant && typeof incoming.variant === 'object' ? incoming.variant : null;
    let chosenVariant = null;
    if (requestedVariant) {
      const variantKey = String(requestedVariant.id || requestedVariant.color || requestedVariant.name || '').trim().toLowerCase();
      const variants = Array.isArray(storedProduct.variants) ? storedProduct.variants : [];
      chosenVariant = variants.find(variant =>
        String(variant?.id || variant?.color || variant?.name || '').trim().toLowerCase() === variantKey
        || (variant?.color && String(variant.color).trim().toLowerCase() === variantKey)
        || (variant?.name && String(variant.name).trim().toLowerCase() === variantKey));
      if (!chosenVariant) throw requestError(400, 'The selected product color is no longer available. Refresh the product and try again.');
      const variantStock = chosenVariant.stock;
      if (variantStock != null && Number.isInteger(Number(variantStock)) && Number(variantStock) >= 0) {
        const stockKey = `${product.id}:${variantKey}`;
        const requested = (requestedStock.get(stockKey) || 0) + qty;
        requestedStock.set(stockKey, requested);
        if (requested > Number(variantStock)) throw requestError(409, 'The selected color does not have enough stock.');
      }
    } else if (storedProduct.stock != null && Number.isFinite(Number(storedProduct.stock)) && Number(storedProduct.stock) >= 0) {
      const stockKey = `${product.id}:default`;
      const requested = (requestedStock.get(stockKey) || 0) + qty;
      requestedStock.set(stockKey, requested);
      if (requested > Number(storedProduct.stock)) throw requestError(409, 'There is not enough stock for this product.');
    }
    const { cost, supplier, supplierDetails, verifiedFacts, policyReviewed, inventoryVerified, researchId, ...safeProductBase } = storedProduct;
    safeProductBase.variants = Array.isArray(safeProductBase.variants) ? safeProductBase.variants.map(publicVariant) : [];
    const safeVariant = chosenVariant ? {
      id: String(chosenVariant.id || chosenVariant.color || chosenVariant.name || ''),
      name: String(chosenVariant.name || chosenVariant.color || ''),
      color: String(chosenVariant.color || chosenVariant.name || ''),
      size: String(chosenVariant.size || ''),
      attributes: chosenVariant.attributes && typeof chosenVariant.attributes === 'object' ? chosenVariant.attributes : {},
      image: String(chosenVariant.image || chosenVariant.imageUrl || ''),
      images: Array.isArray(chosenVariant.images) ? chosenVariant.images.filter(value => typeof value === 'string').slice(0, 20) : [],
      sku: String(chosenVariant.sku || ''),
      price: chosenVariant.price != null && Number.isFinite(Number(chosenVariant.price)) ? Number(chosenVariant.price) : null,
      originalPrice: chosenVariant.originalPrice != null && Number.isFinite(Number(chosenVariant.originalPrice)) ? Number(chosenVariant.originalPrice) : null,
    } : null;
    const safeProduct = safeVariant ? {
      ...safeProductBase,
      image: safeVariant.image || safeProductBase.image,
      images: safeVariant.images.length ? safeVariant.images : safeProductBase.images,
      price: safeVariant.price != null ? safeVariant.price : safeProductBase.price,
      originalPrice: safeVariant.originalPrice != null ? safeVariant.originalPrice : safeProductBase.originalPrice,
    } : safeProductBase;
    const supplierUnitCost = supplierDetails?.unitCost ?? cost;
    const shippingStatus = supplierDetails?.shippingStatus;
    const supplierShippingCost = shippingStatus === 'free' ? 0
      : shippingStatus === 'paid' && supplierDetails?.shippingCost !== null && supplierDetails?.shippingCost !== undefined && supplierDetails?.shippingCost !== '' && Number.isFinite(Number(supplierDetails.shippingCost))
        ? Number(supplierDetails.shippingCost) : null;
    const supplierCost = supplierUnitCost !== null && supplierUnitCost !== undefined && supplierUnitCost !== ''
      && Number.isFinite(Number(supplierUnitCost)) && supplierShippingCost !== null
      ? Number(supplierUnitCost) + supplierShippingCost : null;
    items.push({ product: safeProduct, variant: safeVariant, qty, supplierCost, supplierName: product.supplier || null });
  }

  const subtotal = items.reduce((sum, item) => sum + Number(item.product.price) * item.qty, 0);
  const shipping = subtotal > 50 ? 0 : 4.99;
  const tax = subtotal * 0.08;
  return saveOrder({
    id: `ORD-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`,
    customerUserId: customerUserId ? String(customerUserId) : undefined,
    customer,
    email,
    phone: String(input.phone || '').trim().slice(0, 40),
    country: String(input.country || '').trim().slice(0, 100),
    address: String(input.address || '').trim().slice(0, 300),
    city: String(input.city || '').trim().slice(0, 100),
    state: String(input.state || '').trim().slice(0, 100),
    date: new Date().toISOString(),
    items,
    subtotal,
    shipping,
    tax,
    total: subtotal + shipping + tax,
    status: payment.reference ? 'Pending payment verification' : 'Pending',
    paymentStatus: payment.reference ? 'pending_verification' : 'unpaid',
    paymentReference: payment.reference || undefined,
    paymentCurrency: payment.currency || undefined,
    paymentAmount: payment.amount || undefined,
    paymentVerification: payment.reference ? 'server_initializing' : undefined,
    paymentMethod: payment.reference ? 'Paystack (MoMo/Card)' : 'Pay on Delivery / Bank Transfer',
    checkoutRequestId: payment.checkoutRequestId || undefined,
    supplierPurchaseStatus: 'not_started',
  });
}

function storefrontOrigin(req) {
  const requestOrigin = String(req.get('origin') || '').trim();
  if (uniqueAllowedOrigins.includes(requestOrigin)) return requestOrigin;
  const configured = String(process.env.STOREFRONT_URL || '').trim();
  try {
    const url = new URL(configured);
    if (['https:', 'http:'].includes(url.protocol) && (!isProduction || url.protocol === 'https:')) return url.origin;
  } catch { /* Use the production storefront fallback below. */ }
  return uniqueAllowedOrigins.find(origin => origin.startsWith('https://')) || 'https://shoppercart.uhcacadamy.com';
}

async function createOrder(req, res) {
  if (String(req.body.paymentMethod || '').toLowerCase().includes('paystack')) {
    return res.status(409).json({ success: false, error: 'Paystack payments must be initialized by the secure checkout endpoint.' });
  }
  try {
    const created = await createOrderRecord(req.body, {}, req.user?._id || req.user?.id);
    await notifyOrderCreatedInApp(created);
    void notifyOrderCreated(created).catch(error => console.error('Could not prepare order notification:', error.message));
    res.status(201).json({ success: true, data: checkoutOrderSummary(created), paymentStatus: created.paymentStatus });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.status ? error.message : 'Could not create this order.' });
  }
}

app.post('/api/orders', orderRateLimit, optionalAuthenticate, createOrder);

app.post('/api/payments/paystack/initialize', paymentInitRateLimit, optionalAuthenticate, async (req, res) => {
  const secret = String(process.env.PAYSTACK_SECRET_KEY || '').trim();
  if (!secret) return res.status(503).json({ success: false, error: 'Secure Paystack checkout is not configured on the server.' });
  const currency = String(req.body.paymentCurrency || '').trim().toUpperCase();
  const checkoutRequestId = String(req.body.checkoutRequestId || '').trim();
  if (!PAYSTACK_CURRENCIES.has(currency)) return res.status(400).json({ success: false, error: 'Choose a Paystack-supported checkout currency.' });
  if (!/^[a-zA-Z0-9_-]{20,80}$/.test(checkoutRequestId)) return res.status(400).json({ success: false, error: 'A valid checkout request ID is required.' });
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const existing = await findOrderByCheckoutRequestId(checkoutRequestId);
    let unpricedOrder;
    let amount;
    if (existing) {
      if (String(existing.email || '').toLowerCase() !== email) return res.status(409).json({ success: false, error: 'This checkout request is already in use.' });
      if (existing.paymentAuthorizationUrl && existing.paymentStatus === 'pending_verification') {
        return res.json({ success: true, data: checkoutOrderSummary(existing), authorizationUrl: existing.paymentAuthorizationUrl });
      }
      if (existing.paymentStatus !== 'pending_verification' || existing.paymentCurrency !== currency) {
        return res.status(409).json({ success: false, error: 'This checkout request has already been used. Start checkout again.' });
      }
      amount = Number(existing.paymentAmount);
      if (!Number.isSafeInteger(amount) || amount < 1) return res.status(409).json({ success: false, error: 'This checkout request cannot be resumed. Start checkout again.' });
      unpricedOrder = existing;
    } else {
      const rate = await getPaystackRate(currency);
      if (!rate) return res.status(422).json({ success: false, error: 'Could not determine the payment amount for this currency.' });
      const reference = `BC-${crypto.randomBytes(24).toString('hex')}`;
      unpricedOrder = await createOrderRecord(req.body, { reference, currency, checkoutRequestId }, req.user?._id || req.user?.id);
      amount = Math.round(Number(unpricedOrder.total || 0) * rate * 100);
      if (!Number.isSafeInteger(amount) || amount < 1) {
        unpricedOrder.paymentStatus = 'cancelled';
        unpricedOrder.status = 'Cancelled';
        unpricedOrder.paymentVerification = 'invalid_amount';
        await saveOrder(unpricedOrder);
        return res.status(422).json({ success: false, error: 'This order total cannot be charged in the selected currency.' });
      }
      unpricedOrder.paymentAmount = amount;
      await saveOrder(unpricedOrder);
    }
    const callbackUrl = new URL('/', storefrontOrigin(req));
    callbackUrl.searchParams.set('checkout', 'paystack');
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: unpricedOrder.email,
        amount,
        currency,
        reference: unpricedOrder.paymentReference,
        callback_url: callbackUrl.toString(),
        metadata: { order_id: unpricedOrder.id, checkout_request_id: checkoutRequestId },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => ({}));
    const authorizationUrl = String(payload.data?.authorization_url || '');
    let parsedAuthorizationUrl;
    try { parsedAuthorizationUrl = new URL(authorizationUrl); } catch { parsedAuthorizationUrl = null; }
    if (!response.ok || payload.status !== true || parsedAuthorizationUrl?.protocol !== 'https:' || parsedAuthorizationUrl?.hostname !== 'checkout.paystack.com') {
      unpricedOrder.paymentStatus = 'cancelled';
      unpricedOrder.status = 'Cancelled';
      unpricedOrder.paymentVerification = 'initialization_failed';
      await saveOrder(unpricedOrder);
      return res.status(502).json({ success: false, error: 'Paystack could not initialize this payment. No charge was started.' });
    }
    unpricedOrder.paymentAuthorizationUrl = parsedAuthorizationUrl.toString();
    unpricedOrder.paymentVerification = 'server_initialized';
    await saveOrder(unpricedOrder);
    await notifyOrderCreatedInApp(unpricedOrder);
    void notifyOrderCreated(unpricedOrder).catch(error => console.error('Could not prepare order notification:', error.message));
    res.json({ success: true, data: checkoutOrderSummary(unpricedOrder), authorizationUrl: unpricedOrder.paymentAuthorizationUrl });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    if (error.code === 11000) return res.status(409).json({ success: false, error: 'This checkout request or payment reference has already been used.' });
    res.status(502).json({ success: false, error: 'Could not securely initialize payment with Paystack.' });
  }
});

app.post('/api/payments/paystack/verify', paymentVerifyRateLimit, async (req, res) => {
  const reference = String(req.body.reference || '').trim();
  if (!reference || reference.length > 160) return res.status(400).json({ success: false, error: 'A valid payment reference is required.' });
  try {
    const order = await findOrderByPaymentReference(reference);
    if (!order) return res.status(404).json({ success: false, error: 'No order was found for this payment reference.' });
    if (order.paymentStatus !== 'paid' && !['cancelled', 'refunded', 'partially_refunded'].includes(String(order.paymentStatus || '').toLowerCase())) {
      const verification = await checkPaystackPayment(order);
      if (verification.verified) {
        order.paymentAmount = Number(verification.amount);
        await markOrderPaymentVerified(order, 'customer_callback');
      }
    }
    return res.json({ success: true, data: checkoutOrderSummary(order), paymentStatus: order.paymentStatus });
  } catch {
    return res.status(502).json({ success: false, error: 'Could not check the payment with Paystack. Use your order reference to contact support.' });
  }
});
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
    const userId = String(req.user._id || req.user.id);
    const orders = (await getAllOrders()).filter(order => String(order.customerUserId || '') === userId);
    res.json({ success: true, data: orders.map(order => ({ ...order, items: (order.items || []).map(item => ({ ...item, supplierCost: undefined, supplierName: undefined })) })) });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/account/wishlist', authenticate, (req, res) => {
  res.json({ success: true, data: Array.isArray(req.user.wishlistProductIds) ? req.user.wishlistProductIds : [] });
});

app.get('/api/account/reviews', authenticate, async (req, res) => {
  try {
    const query = { customerUserId: String(req.user._id || req.user.id) };
    const productId = Number(req.query.productId);
    if (req.query.productId && Number.isSafeInteger(productId) && productId > 0) query.productId = productId;
    const reviews = mongoose.connection.readyState === 1
      ? await ProductReview.find(query).sort({ createdAt: -1 }).limit(200).lean()
      : memoryReviews.filter(review => review.customerUserId === query.customerUserId && (!query.productId || Number(review.productId) === query.productId)).slice(0, 200);
    res.json({ success: true, data: reviews.map(({ customerUserId, ...review }) => review) });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not load your reviews.' });
  }
});

app.put('/api/account/wishlist', authenticate, async (req, res) => {
  if (req.user.role !== 'customer') return res.status(403).json({ success: false, error: 'Only customer accounts have a saved-items list.' });
  const incoming = Array.isArray(req.body.productIds) ? req.body.productIds : null;
  if (!incoming || incoming.length > 200) return res.status(400).json({ success: false, error: 'Saved items must contain no more than 200 product IDs.' });
  const ids = [...new Set(incoming.map(Number))];
  if (ids.some(id => !Number.isSafeInteger(id) || id < 1)) return res.status(400).json({ success: false, error: 'Saved item IDs must be valid product IDs.' });
  try {
    const availableIds = new Set((await getAllProducts()).filter(product => !isSampleProduct(product) && product.status !== 'Draft' && product.status !== 'Out of Stock').map(product => Number(product.id)));
    req.user.wishlistProductIds = ids.filter(id => availableIds.has(id));
    await saveUser(req.user);
    res.json({ success: true, data: req.user.wishlistProductIds });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not save your items.' });
  }
});

app.post('/api/payments/paystack/webhook', async (req, res) => {
  if (!isValidPaystackWebhook(req)) return res.status(401).send('Invalid Paystack signature.');
  try {
    if (req.body?.event === 'refund.processed') {
      const refund = req.body?.data || {};
      const reference = String(refund.transaction_reference || refund.reference || refund.transaction?.reference || '').trim();
      const order = await findOrderByPaymentReference(reference);
      if (!order || order.paymentStatus === 'refunded') return res.sendStatus(200);
      const refundedAmount = Number(refund.amount);
      if (!Number.isSafeInteger(refundedAmount) || refundedAmount <= 0) return res.sendStatus(200);
      const refundId = String(refund.id || refund.reference || '').trim().slice(0, 160);
      if (refundId && (order.paymentRefundIds || []).includes(refundId)) return res.sendStatus(200);
      const totalPaid = Number(order.paymentAmount);
      order.paymentRefundedAmount = Math.min(Number.isSafeInteger(totalPaid) && totalPaid > 0 ? totalPaid : Number(order.paymentRefundedAmount || 0) + refundedAmount, Number(order.paymentRefundedAmount || 0) + refundedAmount);
      if (refundId) order.paymentRefundIds = [...(order.paymentRefundIds || []), refundId].slice(-100);
      order.paymentStatus = Number.isSafeInteger(totalPaid) && totalPaid > 0 && order.paymentRefundedAmount >= totalPaid ? 'refunded' : 'partially_refunded';
      if (order.paymentStatus === 'refunded') order.status = 'Refunded';
      const saved = await saveOrder(order);
      void notifyOrderStatusChanged(saved).catch(error => console.error('Could not prepare refund status email:', error.message));
      return res.sendStatus(200);
    }
    if (req.body?.event !== 'charge.success') return res.sendStatus(200);
    const reference = String(req.body?.data?.reference || '').trim();
    const order = await findOrderByPaymentReference(reference);
    if (!order || order.paymentStatus === 'paid' || ['refunded', 'partially_refunded'].includes(String(order.paymentStatus || '').toLowerCase())) return res.sendStatus(200);
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
    if (['refunded', 'partially_refunded'].includes(String(order.paymentStatus || '').toLowerCase())) return res.status(409).json({ success: false, error: 'This transaction has a refund recorded and cannot be marked as paid again.' });
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
    if (req.body.status && ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled', 'Canceled', 'Refunded'].includes(req.body.status)) {
      if (['Processing', 'Shipped', 'Delivered'].includes(req.body.status)
        && ['Cancelled', 'Canceled', 'Refunded'].includes(order.status)) {
        return res.status(409).json({ success: false, error: 'A cancelled or refunded order cannot move into fulfillment.' });
      }
      if (['Processing', 'Shipped', 'Delivered'].includes(req.body.status)
        && String(order.paymentMethod || '').toLowerCase().includes('paystack')
        && order.paymentStatus !== 'paid') {
        return res.status(409).json({ success: false, error: 'Verify the Paystack payment before moving this order into fulfillment.' });
      }
      if (['Processing', 'Shipped', 'Delivered'].includes(req.body.status)
        && ['refunded', 'partially_refunded'].includes(String(order.paymentStatus || '').toLowerCase())) {
        return res.status(409).json({ success: false, error: 'A refunded order cannot move into fulfillment.' });
      }
      order.status = req.body.status;
    }
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
  if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 10 || password.length > 256) return res.status(400).json({ success: false, error: 'Name, valid email, and a 10–256 character password are required.' });
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
    if (typeof req.body.password === 'string' && req.body.password.length > 0) {
      if (req.body.password.length < 10 || req.body.password.length > 256) return res.status(400).json({ success: false, error: 'New passwords must be between 10 and 256 characters.' });
      user.passwordHash = await hashPassword(req.body.password);
    }
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
  rateLimit,
  getAllProducts,
  getAllOrders,
  saveProduct,
  findProduct,
  saveOrder,
  findOrder,
  notifyAdmins,
}));

app.use((error, _req, res, _next) => {
  console.error('Unhandled API error:', error.message);
  if (res.headersSent) return;
  const status = Number(error.status) >= 400 && Number(error.status) < 500 ? Number(error.status) : 500;
  res.status(status).json({ success: false, error: status < 500 ? error.message : 'An internal server error occurred.' });
});

async function startServer() {
  if (isProduction && (!JWT_SECRET || JWT_SECRET.length < 32)) throw new Error('JWT_SECRET must be configured with at least 32 characters in production.');
  await connectDB();
  if (isProduction && mongoose.connection.readyState !== 1) throw new Error('MongoDB is required for production startup.');
  app.listen(PORT, () => console.log(`🚀 Shoppercart Backend API running on port ${PORT}`));
}

startServer().catch(error => {
  console.error('Backend startup failed:', error.message);
  process.exitCode = 1;
});
