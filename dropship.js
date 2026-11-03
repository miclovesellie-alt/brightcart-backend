import express from 'express';
import mongoose from 'mongoose';
import crypto from 'node:crypto';

const researchSchema = new mongoose.Schema({
  productName: { type: String, required: true },
  category: { type: String, required: true },
  sourceUrl: { type: String, required: true },
  supplierName: { type: String, required: true },
  supplierUrl: String,
  imageUrl: String,
  verifiedFacts: [String],
  variants: [mongoose.Schema.Types.Mixed],
  unitCost: { type: Number, required: true },
  shippingCost: { type: Number, default: 0 },
  retailPrice: { type: Number, required: true },
  availableStock: { type: Number, default: 0 },
  shippingDays: Number,
  currency: { type: String, default: 'USD' },
  score: Number,
  scoreNotes: [String],
  missingSignals: [String],
  content: mongoose.Schema.Types.Mixed,
  state: { type: String, default: 'researched' },
  researchedAt: { type: Date, default: Date.now },
  researchedBy: String,
}, { timestamps: true });

const purchaseSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  supplierName: { type: String, required: true },
  supplierOrderId: { type: String, required: true },
  actualCost: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'USD' },
  status: { type: String, default: 'recorded' },
  tracking: String,
  note: String,
  createdBy: String,
}, { timestamps: true });

const activitySchema = new mongoose.Schema({
  action: { type: String, required: true },
  summary: { type: String, required: true },
  actor: String,
  subjectId: String,
  details: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

const Research = mongoose.models.DropshipResearch || mongoose.model('DropshipResearch', researchSchema);
const SupplierPurchase = mongoose.models.SupplierPurchase || mongoose.model('SupplierPurchase', purchaseSchema);
const Activity = mongoose.models.DropshipActivity || mongoose.model('DropshipActivity', activitySchema);

const memory = { research: [], purchases: [], activity: [] };
const dbReady = () => mongoose.connection.readyState === 1;
const clean = value => String(value || '').trim();
const safeUser = req => req.user?.email || 'admin';

function scoreCandidate(input) {
  const notes = [];
  let score = 0;
  if (input.sourceUrl) { score += 20; notes.push('A source URL was recorded.'); }
  if (input.availableStock > 0) { score += 25; notes.push('Supplier stock was supplied and is above zero.'); }
  if (Number.isFinite(input.shippingDays) && input.shippingDays >= 0) {
    const shippingScore = Math.max(0, Math.round(25 * (1 - Math.min(input.shippingDays, 60) / 60)));
    score += shippingScore;
    notes.push(`Shipping estimate: ${input.shippingDays} days (admin supplied).`);
  }
  const totalCost = input.unitCost + input.shippingCost;
  const margin = input.retailPrice > 0 ? (input.retailPrice - totalCost) / input.retailPrice : 0;
  if (input.retailPrice > totalCost && margin > 0) {
    score += Math.min(30, Math.round(margin * 60));
    notes.push(`Calculated gross margin from entered costs: ${(margin * 100).toFixed(1)}%.`);
  } else {
    notes.push('Entered retail price does not exceed the known supplier and shipping costs.');
  }
  return {
    score: Math.min(100, score),
    scoreNotes: notes,
    missingSignals: ['Demand and trend data', 'Competition data', 'Supplier reliability history', 'Seasonality and policy review'],
  };
}

async function writeActivity(action, summary, actor, subjectId, details = {}) {
  const entry = { action, summary, actor, subjectId: String(subjectId || ''), details, createdAt: new Date() };
  try {
    if (dbReady()) return await Activity.create(entry);
  } catch (error) {
    console.error('Dropship activity log failed:', error.message);
  }
  memory.activity.unshift(entry);
  memory.activity = memory.activity.slice(0, 100);
  return entry;
}

async function getResearch() {
  if (dbReady()) return Research.find().sort({ createdAt: -1 }).limit(100).lean();
  return memory.research;
}

async function getPurchases() {
  if (dbReady()) return SupplierPurchase.find().sort({ createdAt: -1 }).limit(100).lean();
  return memory.purchases;
}

async function getActivity() {
  if (dbReady()) return Activity.find().sort({ createdAt: -1 }).limit(30).lean();
  return memory.activity.slice(0, 30);
}

async function saveResearch(candidate) {
  if (dbReady()) return Research.create(candidate);
  const saved = { ...candidate, _id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date() };
  memory.research.unshift(saved);
  return saved;
}

async function savePurchase(purchase) {
  if (dbReady()) return SupplierPurchase.create(purchase);
  const saved = { ...purchase, _id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date() };
  memory.purchases.unshift(saved);
  return saved;
}

function normalizeLocalBase() {
  const raw = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  try {
    const url = new URL(raw);
    const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    return local && url.protocol === 'http:' ? url.toString().replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

async function localAiStatus() {
  const base = normalizeLocalBase();
  const model = clean(process.env.OLLAMA_MODEL);
  if (!base || !model) {
    return { provider: 'Ollama (local)', configured: false, available: false, free: true, model: model || null, setup: 'Install Ollama, pull a local model, and set OLLAMA_MODEL. No paid fallback is used.' };
  }
  try {
    const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1800) });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const payload = await response.json();
    const models = Array.isArray(payload.models) ? payload.models.map(item => item.name) : [];
    const available = models.some(name => name === model || name.startsWith(`${model}:`));
    return { provider: 'Ollama (local)', configured: true, available, free: true, model, installedModels: models, setup: available ? null : `Model “${model}” is not installed. Pull it locally before generating content.` };
  } catch (error) {
    return { provider: 'Ollama (local)', configured: true, available: false, free: true, model, setup: `Local Ollama is unavailable: ${error.message}. Start Ollama; this app will not call a paid provider.` };
  }
}

function toProduct(candidate) {
  const facts = Array.isArray(candidate.verifiedFacts) ? candidate.verifiedFacts : [];
  const content = candidate.content || {};
  return {
    id: Date.now(),
    name: clean(content.title) || candidate.productName,
    category: candidate.category,
    price: candidate.retailPrice,
    originalPrice: candidate.retailPrice,
    cost: candidate.unitCost + candidate.shippingCost,
    stock: candidate.availableStock,
    image: candidate.imageUrl || '',
    description: clean(content.description) || facts.join('\n'),
    featured: false,
    tag: 'Research draft',
    sku: '',
    status: 'Draft',
    supplier: candidate.supplierName,
    supplierDetails: {
      sourceUrl: candidate.sourceUrl,
      productUrl: candidate.supplierUrl || candidate.sourceUrl,
      unitCost: candidate.unitCost,
      shippingCost: candidate.shippingCost,
      shippingDays: candidate.shippingDays ?? null,
      availableStock: candidate.availableStock,
      currency: candidate.currency || 'USD',
      lastSyncAt: null,
      variants: Array.isArray(candidate.variants) ? candidate.variants : [],
    },
    verifiedFacts: facts,
    policyReviewed: false,
    inventoryVerified: false,
    researchId: String(candidate._id),
  };
}

export function createDropshipRouter({
  authenticate,
  requireAdmin,
  requirePublisher,
  getAllProducts,
  getAllOrders,
  saveProduct,
  findProduct,
  saveOrder,
  findOrder,
}) {
  const router = express.Router();
  router.use(authenticate, requireAdmin);

  router.get('/connections', async (_req, res) => {
    res.json({
      success: true,
      database: dbReady() ? 'connected' : 'memory only; records reset on server restart',
      publishingMode: 'Admin review required',
      supplier: { connected: false, provider: null, automaticPurchasing: false, mode: 'Manual records only', setup: 'No official supplier API is configured. Add a provider adapter and server-side credentials before enabling stock sync or automatic ordering.' },
      ai: await localAiStatus(),
      payment: { mode: 'manual confirmation', serverVerification: false, setup: 'Checkout callbacks are recorded as pending verification. A super admin must verify the payment externally before any supplier purchase can be recorded.' },
    });
  });

  router.get('/overview', async (req, res) => {
    try {
      const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const previousCutoff = cutoff - days * 24 * 60 * 60 * 1000;
      const [products, orders, purchases, research, activity] = await Promise.all([
        getAllProducts(), getAllOrders(), getPurchases(), getResearch(), getActivity(),
      ]);
      const periodOrders = orders.filter(order => new Date(order.createdAt || order.date || 0).getTime() >= cutoff);
      const previousPeriodOrders = orders.filter(order => {
        const timestamp = new Date(order.createdAt || order.date || 0).getTime();
        return timestamp >= previousCutoff && timestamp < cutoff;
      });
      const paidOrders = periodOrders.filter(order => order.paymentStatus === 'paid' && !['Cancelled', 'Canceled', 'Refunded'].includes(order.status));
      const previousPaidOrders = previousPeriodOrders.filter(order => order.paymentStatus === 'paid' && !['Cancelled', 'Canceled', 'Refunded'].includes(order.status));
      const unitsSold = paidOrders.reduce((sum, order) => sum + (order.items || []).reduce((n, item) => n + Number(item.qty || 1), 0), 0);
      const orderValue = periodOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
      const paidRevenue = paidOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
      const supplierSpend = purchases.filter(item => new Date(item.createdAt || 0).getTime() >= cutoff).reduce((sum, item) => sum + Number(item.actualCost || 0), 0);
      const purchaseByOrderId = new Map(purchases.map(item => [String(item.orderId), item]));
      const orderHasKnownCosts = order => purchaseByOrderId.has(String(order.id)) || (order.items || []).every(item => item.supplierCost !== null && item.supplierCost !== undefined && item.supplierCost !== '' && Number.isFinite(Number(item.supplierCost)) && Number(item.supplierCost) >= 0);
      const costKnownForAll = paidOrders.length > 0 && paidOrders.every(orderHasKnownCosts);
      const knownCost = paidOrders.reduce((sum, order) => {
        const recordedPurchase = purchaseByOrderId.get(String(order.id));
        if (recordedPurchase) return sum + Number(recordedPurchase.actualCost || 0);
        return sum + (order.items || []).reduce((n, item) => n + Number(item.supplierCost || 0) * Number(item.qty || 1), 0);
      }, 0);
      const chart = Array.from({ length: Math.min(days, 30) }, (_, index) => {
        const date = new Date(Date.now() - (Math.min(days, 30) - 1 - index) * 24 * 60 * 60 * 1000);
        const key = date.toISOString().slice(0, 10);
        const rows = periodOrders.filter(order => new Date(order.createdAt || order.date || 0).toISOString().slice(0, 10) === key);
        return { date: key, orders: rows.length, orderValue: rows.reduce((sum, order) => sum + Number(order.total || 0), 0), paidRevenue: rows.filter(order => order.paymentStatus === 'paid').reduce((sum, order) => sum + Number(order.total || 0), 0) };
      });
      res.json({
        success: true,
        periodDays: days,
        previous: {
          orders: previousPeriodOrders.length,
          paidOrders: previousPaidOrders.length,
          orderValue: previousPeriodOrders.reduce((sum, order) => sum + Number(order.total || 0), 0),
          paidRevenue: previousPaidOrders.reduce((sum, order) => sum + Number(order.total || 0), 0),
        },
        metrics: {
          orders: periodOrders.length,
          paidOrders: paidOrders.length,
          unitsSold: paidOrders.length ? unitsSold : null,
          orderValue,
          paidRevenue,
          supplierSpend,
          grossProfit: costKnownForAll ? paidRevenue - knownCost : null,
          grossMargin: costKnownForAll && paidRevenue > 0 ? ((paidRevenue - knownCost) / paidRevenue) * 100 : null,
          estimatedProfit: null,
          drafts: products.filter(product => product.status === 'Draft').length,
          published: products.filter(product => product.status !== 'Draft' && product.status !== 'Out of Stock').length,
          stockAlerts: products.filter(product => Number(product.stock || 0) < 5).length,
          researchCount: research.length,
          views: null,
          conversion: null,
          fulfillmentDelays: null,
          returns: null,
        },
        chart,
        statuses: periodOrders.reduce((out, order) => { const key = order.status || 'Unknown'; out[key] = (out[key] || 0) + 1; return out; }, {}),
        activity,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: `Could not load dropshipping overview: ${error.message}` });
    }
  });

  router.get('/research', async (_req, res) => {
    try { res.json({ success: true, data: await getResearch() }); }
    catch (error) { res.status(500).json({ success: false, error: error.message }); }
  });

  router.post('/research', async (req, res) => {
    const input = {
      productName: clean(req.body.productName),
      category: clean(req.body.category),
      sourceUrl: clean(req.body.sourceUrl),
      supplierName: clean(req.body.supplierName),
      supplierUrl: clean(req.body.supplierUrl),
      imageUrl: clean(req.body.imageUrl),
      verifiedFacts: Array.isArray(req.body.verifiedFacts) ? req.body.verifiedFacts.map(clean).filter(Boolean).slice(0, 30) : [],
      variants: Array.isArray(req.body.variants) ? req.body.variants.slice(0, 50) : [],
      unitCost: Number(req.body.unitCost),
      shippingCost: Number(req.body.shippingCost || 0),
      retailPrice: Number(req.body.retailPrice),
      availableStock: Number(req.body.availableStock || 0),
      shippingDays: req.body.shippingDays === '' || req.body.shippingDays == null ? null : Number(req.body.shippingDays),
      currency: clean(req.body.currency || 'USD').toUpperCase(),
      state: 'researched',
      researchedBy: safeUser(req),
      researchedAt: new Date(),
    };
    let source;
    try { source = new URL(input.sourceUrl); } catch { return res.status(400).json({ success: false, error: 'Enter a valid supplier or research source URL.' }); }
    if (!['http:', 'https:'].includes(source.protocol)) return res.status(400).json({ success: false, error: 'Source URLs must use HTTPS or HTTP.' });
    if (!input.productName || !input.category || !input.supplierName || !Number.isFinite(input.unitCost) || input.unitCost < 0 || !Number.isFinite(input.shippingCost) || input.shippingCost < 0 || !Number.isInteger(input.availableStock) || input.availableStock < 0 || !Number.isFinite(input.retailPrice) || input.retailPrice <= 0) {
      return res.status(400).json({ success: false, error: 'Product, category, supplier, non-negative cost, and retail price are required.' });
    }
    if (input.shippingDays != null && (!Number.isFinite(input.shippingDays) || input.shippingDays < 0)) return res.status(400).json({ success: false, error: 'Shipping days must be zero or greater.' });
    Object.assign(input, scoreCandidate(input));
    try {
      const saved = await saveResearch(input);
      await writeActivity('research_created', `Added research candidate: ${input.productName}`, safeUser(req), saved._id);
      res.status(201).json({ success: true, data: saved });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/research/:id/generate-content', async (req, res) => {
    const ai = await localAiStatus();
    if (!ai.configured || !ai.available) return res.status(503).json({ success: false, error: ai.setup || 'Local AI model is unavailable.', waiting: true });
    try {
      const candidate = dbReady() ? await Research.findById(req.params.id) : memory.research.find(item => String(item._id) === req.params.id);
      if (!candidate) return res.status(404).json({ success: false, error: 'Research candidate not found.' });
      const base = normalizeLocalBase();
      const facts = Array.isArray(candidate.verifiedFacts) ? candidate.verifiedFacts : [];
      const response = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(45000),
        body: JSON.stringify({
          model: process.env.OLLAMA_MODEL,
          stream: false,
          format: 'json',
          messages: [
            { role: 'system', content: 'Write cautious ecommerce copy using only the supplied facts. Never add specifications, materials, dimensions, certifications, performance claims, shipping promises, or benefits that are not explicitly present. If facts are sparse, keep copy sparse. Return JSON with title, description, bullets (array), seoTitle, seoDescription, and faqs (array of question/answer objects). This output is a draft for human review.' },
            { role: 'user', content: JSON.stringify({ productName: candidate.productName, category: candidate.category, verifiedFacts: facts, supplierName: candidate.supplierName, sourceUrl: candidate.sourceUrl }) },
          ],
          options: { temperature: 0.2 },
        }),
      });
      if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
      const payload = await response.json();
      let content;
      try { content = JSON.parse(payload.message?.content || '{}'); } catch { throw new Error('The local model returned invalid JSON. Try again or edit the copy manually.'); }
      const allowed = ['title', 'description', 'seoTitle', 'seoDescription'];
      for (const key of allowed) if (typeof content[key] !== 'string') content[key] = '';
      content.bullets = Array.isArray(content.bullets) ? content.bullets.filter(item => typeof item === 'string').slice(0, 8) : [];
      content.faqs = Array.isArray(content.faqs) ? content.faqs.filter(item => item && typeof item.question === 'string' && typeof item.answer === 'string').slice(0, 8) : [];
      content.reviewRequired = true;
      candidate.content = content;
      if (candidate.save) await candidate.save();
      else candidate.content = content;
      await writeActivity('content_generated', `Generated draft copy for ${candidate.productName}`, safeUser(req), candidate._id, { provider: 'Ollama local', model: process.env.OLLAMA_MODEL });
      res.json({ success: true, data: candidate });
    } catch (error) {
      res.status(503).json({ success: false, error: `Local AI generation failed: ${error.message}. No paid provider was used.` });
    }
  });

  router.post('/research/:id/import', requirePublisher, async (req, res) => {
    try {
      const candidate = dbReady() ? await Research.findById(req.params.id).lean() : memory.research.find(item => String(item._id) === req.params.id);
      if (!candidate) return res.status(404).json({ success: false, error: 'Research candidate not found.' });
      const product = toProduct(candidate);
      const duplicate = await findProduct(product.sku, product.name);
      if (duplicate && !req.body.updateExisting) return res.status(409).json({ success: false, duplicate: { id: duplicate.id, name: duplicate.name, status: duplicate.status }, error: 'A matching product already exists. Review it in Admin > Products before choosing an update.' });
      if (duplicate && req.body.updateExisting && duplicate.status !== 'Draft') return res.status(409).json({ success: false, duplicate: { id: duplicate.id, name: duplicate.name, status: duplicate.status || 'Active' }, error: 'Research imports can update drafts only. Edit a live product directly in Admin > Products.' });
      let saved;
      if (duplicate) {
        saved = await saveProduct({ ...duplicate, ...product, id: duplicate.id, status: duplicate.status, policyReviewed: duplicate.policyReviewed || false }, duplicate.id);
      } else {
        saved = await saveProduct(product);
      }
      if (dbReady()) await Research.updateOne({ _id: candidate._id }, { $set: { state: 'imported' } });
      else candidate.state = 'imported';
      await writeActivity('product_imported', `Imported ${product.name} as a draft`, safeUser(req), saved.id, { researchId: String(candidate._id) });
      res.status(201).json({ success: true, data: saved, visibility: 'draft' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/products/:id/publish', requirePublisher, async (req, res) => {
    try {
      const product = await findProduct(null, null, Number(req.params.id));
      if (!product) return res.status(404).json({ success: false, error: 'Product not found.' });
      const missing = [];
      if (!clean(product.name)) missing.push('name');
      if (!clean(product.category)) missing.push('category');
      if (!(Number(product.price) > 0)) missing.push('retail price');
      if (!clean(product.description)) missing.push('description');
      if (!clean(product.image)) missing.push('image');
      if (!(Number(product.stock) > 0)) missing.push('available stock');
      const supplierUnitCost = product.supplierDetails?.unitCost;
      if (supplierUnitCost === null || supplierUnitCost === undefined || supplierUnitCost === '' || !Number.isFinite(Number(supplierUnitCost)) || Number(supplierUnitCost) < 0 || !product.supplierDetails?.sourceUrl) missing.push('supplier cost and source');
      if (req.body.policyReviewed !== true) missing.push('policy review confirmation');
      if (req.body.inventoryVerified !== true) missing.push('inventory verification');
      if (req.body.contentReviewed !== true) missing.push('final content review');
      if (missing.length) return res.status(422).json({ success: false, error: `Cannot publish yet. Complete: ${missing.join(', ')}.` });
      const saved = await saveProduct({ ...product, status: 'Active', policyReviewed: true, inventoryVerified: true, publishedAt: new Date() }, Number(req.params.id));
      await writeActivity('product_published', `Published ${saved.name} to the storefront`, safeUser(req), saved.id);
      res.json({ success: true, data: saved });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/purchases', async (_req, res) => {
    try { res.json({ success: true, data: await getPurchases() }); }
    catch (error) { res.status(500).json({ success: false, error: error.message }); }
  });

  router.post('/orders/:id/purchases', requirePublisher, async (req, res) => {
    try {
      const order = await findOrder(req.params.id);
      if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });
      if (order.paymentStatus !== 'paid') return res.status(409).json({ success: false, error: 'Supplier purchases are blocked until payment is verified as paid.' });
      if (['cancelled', 'canceled', 'refunded'].includes(String(order.status || '').toLowerCase())) return res.status(409).json({ success: false, error: 'Cancelled or refunded orders cannot be purchased.' });
      const supplierName = clean(req.body.supplierName);
      const supplierOrderId = clean(req.body.supplierOrderId);
      const actualCost = Number(req.body.actualCost);
      if (!supplierName || !supplierOrderId || !Number.isFinite(actualCost) || actualCost < 0) return res.status(400).json({ success: false, error: 'Supplier name, supplier order ID, and a non-negative actual cost are required.' });
      const existing = dbReady() ? await SupplierPurchase.findOne({ orderId: String(order.id) }) : memory.purchases.find(item => String(item.orderId) === String(order.id));
      if (existing) return res.status(409).json({ success: false, data: existing, error: 'A supplier purchase is already recorded for this order.' });
      const purchase = await savePurchase({ orderId: String(order.id), supplierName, supplierOrderId, actualCost, currency: clean(req.body.currency || 'USD').toUpperCase(), status: 'recorded', tracking: clean(req.body.tracking), note: clean(req.body.note), createdBy: safeUser(req) });
      order.supplierPurchaseStatus = 'recorded';
      order.supplierPurchaseId = String(purchase._id);
      order.supplierSpend = actualCost;
      await saveOrder(order);
      await writeActivity('supplier_purchase_recorded', `Recorded external supplier purchase ${supplierOrderId} for order ${order.id}`, safeUser(req), order.id, { supplierName, actualCost });
      res.status(201).json({ success: true, data: purchase, mode: 'manual record; no supplier API call was made' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/orders/:id/confirm-payment', async (req, res) => {
    if (req.user?.role !== 'super_admin') return res.status(403).json({ success: false, error: 'Only a super admin can record external payment verification.' });
    try {
      const order = await findOrder(req.params.id);
      if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });
      if (['cancelled', 'canceled', 'refunded'].includes(String(order.status || '').toLowerCase())) return res.status(409).json({ success: false, error: 'Cancelled or refunded orders cannot be marked paid.' });
      if (!['pending_verification', 'unpaid'].includes(order.paymentStatus)) return res.status(409).json({ success: false, error: 'Only unpaid orders can be manually verified.' });
      const reference = clean(req.body.paymentReference);
      const note = clean(req.body.verificationNote);
      if (!reference || !note) return res.status(400).json({ success: false, error: 'Payment reference and a note describing the external verification are required.' });
      if (order.paymentReference && reference.toLowerCase() !== String(order.paymentReference).toLowerCase()) return res.status(409).json({ success: false, error: 'The reference must match the one returned at checkout.' });
      order.paymentReference = reference;
      order.paymentStatus = 'paid';
      order.paymentVerification = 'manual_external';
      order.paymentVerifiedBy = safeUser(req);
      order.paymentVerifiedAt = new Date();
      await saveOrder(order);
      await writeActivity('payment_confirmed_manually', `Super admin recorded external payment verification for order ${order.id}`, safeUser(req), order.id, { verificationNote: note, paymentReference: reference });
      res.json({ success: true, data: order, verification: 'manual external confirmation; not verified by Paystack API' });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
  });

  return router;
}
