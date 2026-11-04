import express from 'express';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const researchSchema = new mongoose.Schema({
  productName: { type: String, required: true },
  category: { type: String, required: true },
  sourceUrl: { type: String, required: true },
  supplierName: { type: String, required: true },
  supplierUrl: String,
  imageUrl: String,
  images: { type: [String], default: [] },
  verifiedFacts: [String],
  variants: [mongoose.Schema.Types.Mixed],
  unitCost: { type: Number, default: null },
  shippingCost: { type: Number, default: null },
  shippingStatus: { type: String, enum: ['unknown', 'free', 'paid'], default: 'unknown' },
  shippingDestination: String,
  shippingCurrency: String,
  retailPrice: { type: Number, default: null },
  availableStock: { type: Number, default: null },
  shippingDays: Number,
  currency: { type: String, default: 'USD' },
  supplierCurrency: String,
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
  if (Number.isFinite(input.availableStock) && input.availableStock > 0) {
    score += 25;
    notes.push('Supplier stock was supplied and is above zero.');
  } else {
    notes.push('Exact available quantity was not confirmed.');
  }
  if (Number.isFinite(input.shippingDays) && input.shippingDays >= 0) {
    const shippingScore = Math.max(0, Math.round(25 * (1 - Math.min(input.shippingDays, 60) / 60)));
    score += shippingScore;
    notes.push(`Shipping estimate: ${input.shippingDays} days (admin supplied).`);
  }
  if (input.shippingStatus === 'free' || (input.shippingStatus === 'paid' && Number.isFinite(input.shippingCost))) {
    notes.push(input.shippingStatus === 'free' ? 'Free shipping was explicitly confirmed.' : 'A supplier shipping fee was supplied.');
  } else {
    notes.push('Supplier shipping to the selected destination is unknown.');
  }
  const unitCost = Number.isFinite(input.unitCost) ? input.unitCost : null;
  const shippingCost = input.shippingStatus === 'free' ? 0 : Number.isFinite(input.shippingCost) ? input.shippingCost : null;
  const retailPrice = Number.isFinite(input.retailPrice) ? input.retailPrice : null;
  const totalCost = unitCost !== null && shippingCost !== null ? unitCost + shippingCost : null;
  const margin = totalCost !== null && retailPrice > 0 ? (retailPrice - totalCost) / retailPrice : 0;
  if (retailPrice > totalCost && margin > 0) {
    score += Math.min(30, Math.round(margin * 60));
    notes.push(`Calculated gross margin from entered costs: ${(margin * 100).toFixed(1)}%.`);
  } else if (retailPrice === null || totalCost === null) {
    notes.push('A complete price recommendation is pending confirmed costs.');
  } else {
    notes.push('Entered retail price does not exceed the known supplier and shipping costs.');
  }
  const missingSignals = [];
  if (unitCost === null) missingSignals.push('Supplier unit price');
  if (input.shippingStatus === 'unknown') missingSignals.push('Shipping cost for destination');
  if (retailPrice === null) missingSignals.push('Retail price');
  if (!Number.isFinite(input.availableStock)) missingSignals.push('Available stock quantity');
  missingSignals.push('Demand and trend data', 'Competition data', 'Supplier reliability history', 'Seasonality and policy review');
  return { score: Math.min(100, score), scoreNotes: notes, missingSignals };
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
    return { provider: 'Ollama (local)', configured: false, available: false, free: true, model: model || null, setup: 'Set OLLAMA_BASE_URL and OLLAMA_MODEL after installing Ollama locally.' };
  }
  try {
    const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1800) });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const payload = await response.json();
    const models = Array.isArray(payload.models) ? payload.models.map(item => item.name) : [];
    const available = models.some(name => name === model || name.startsWith(`${model}:`));
    return { provider: 'Ollama (local)', configured: true, available, free: true, model, installedModels: models, setup: available ? null : `Model “${model}” is not installed. Pull it locally before generating content.` };
  } catch (error) {
    return { provider: 'Ollama (local)', configured: true, available: false, free: true, model, setup: `Local Ollama is unavailable: ${error.message}.` };
  }
}

function configuredAiProviders(localStatus) {
  const providers = [
    { id: 'gemini', name: 'Google Gemini', configured: Boolean(clean(process.env.GEMINI_API_KEY)), model: clean(process.env.GEMINI_MODEL) || 'gemini-2.5-flash-lite', freePlanAvailable: true },
    { id: 'groq', name: 'Groq', configured: Boolean(clean(process.env.GROQ_API_KEY)), model: clean(process.env.GROQ_MODEL) || 'openai/gpt-oss-20b', freePlanAvailable: true },
    { id: 'ollama', name: 'Ollama (local)', configured: localStatus.configured, available: localStatus.available, model: localStatus.model, freePlanAvailable: true },
  ];
  return providers;
}

async function aiStatus() {
  const local = await localAiStatus();
  const providers = configuredAiProviders(local);
  const configured = providers.some(provider => provider.configured);
  const available = providers.some(provider => provider.configured && provider.id !== 'ollama')
    || providers.some(provider => provider.id === 'ollama' && provider.available);
  return {
    provider: 'Gemini → Groq → Ollama fallback',
    configured,
    available,
    providers,
    model: providers.filter(provider => provider.configured).map(provider => provider.model).join(', ') || null,
    setup: configured ? 'Providers are tried in order; quota or availability errors trigger the next configured provider.' : 'Set GEMINI_API_KEY or GROQ_API_KEY on the backend, or configure a local Ollama model. Keep cloud provider accounts on their free tier.',
  };
}

function toProduct(candidate) {
  const facts = Array.isArray(candidate.verifiedFacts) ? candidate.verifiedFacts : [];
  const content = candidate.content || {};
  const images = [...new Set([
    ...(Array.isArray(candidate.images) ? candidate.images : []),
    candidate.imageUrl,
  ].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
  const variants = Array.isArray(candidate.variants) ? candidate.variants.map(variant => ({
    id: clean(variant?.id || variant?.color || variant?.name),
    name: clean(variant?.name || variant?.color),
    color: clean(variant?.color || variant?.name),
    image: clean(variant?.image || variant?.imageUrl),
    images: Array.isArray(variant?.images) ? variant.images.filter(value => typeof value === 'string').slice(0, 20) : [],
    sku: clean(variant?.sku),
  })).filter(variant => variant.color) : [];
  return {
    id: Date.now(),
    name: clean(content.title) || candidate.productName,
    category: candidate.category,
    price: Number.isFinite(Number(candidate.retailPrice)) ? Number(candidate.retailPrice) : 0,
    originalPrice: Number.isFinite(Number(candidate.retailPrice)) ? Number(candidate.retailPrice) : 0,
    cost: candidate.unitCost !== null && candidate.unitCost !== undefined && candidate.unitCost !== '' && Number.isFinite(Number(candidate.unitCost)) ? Number(candidate.unitCost) + (candidate.shippingStatus === 'free' ? 0 : Number(candidate.shippingCost || 0)) : undefined,
    stock: Number.isInteger(Number(candidate.availableStock)) ? Number(candidate.availableStock) : 0,
    image: images[0] || '',
    images,
    description: clean(content.description) || facts.join('\n'),
    featured: false,
    tag: 'Research draft',
    sku: '',
    status: 'Draft',
    supplier: candidate.supplierName,
    supplierDetails: {
      sourceUrl: candidate.sourceUrl,
      productUrl: candidate.supplierUrl || candidate.sourceUrl,
      unitCost: candidate.unitCost !== null && candidate.unitCost !== undefined && candidate.unitCost !== '' && Number.isFinite(Number(candidate.unitCost)) ? Number(candidate.unitCost) : null,
      shippingCost: candidate.shippingStatus === 'free' ? 0 : candidate.shippingCost !== null && candidate.shippingCost !== undefined && candidate.shippingCost !== '' && Number.isFinite(Number(candidate.shippingCost)) ? Number(candidate.shippingCost) : null,
      shippingStatus: candidate.shippingStatus || 'unknown',
      shippingDestination: candidate.shippingDestination || '',
      shippingCurrency: candidate.shippingCurrency || candidate.supplierCurrency || '',
      shippingDays: candidate.shippingDays ?? null,
      availableStock: Number.isFinite(Number(candidate.availableStock)) ? Number(candidate.availableStock) : null,
      currency: candidate.currency || 'USD',
      supplierCurrency: candidate.supplierCurrency || candidate.currency || 'USD',
      lastSyncAt: null,
      variants,
    },
    variants,
    verifiedFacts: facts,
    policyReviewed: false,
    inventoryVerified: false,
    researchId: String(candidate._id),
  };
}

const MAX_PRODUCT_PAGE_BYTES = 1_500_000;
const MAX_PRODUCT_PAGE_REDIRECTS = 4;

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 2 || b === 88 || b === 168))
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100)))
    || (a === 203 && b === 0 && parts[2] === 113);
}

function isPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) return !isPrivateIpv4(address);
  if (version !== 6) return false;
  const value = address.toLowerCase();
  if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
    || value.startsWith('ff') || value.startsWith('64:ff9b:') || value.startsWith('2001:db8:') || value.startsWith('2001:10:')
    || /^fe[89ab][0-9a-f]:/.test(value)) return false;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return !isPrivateIpv4(mapped[1]);
  const firstSegment = parseInt(value.split(':')[0] || '0', 16);
  return Number.isFinite(firstSegment) && (firstSegment & 0xe000) === 0x2000;
}

async function validateProductPageUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Enter a valid supplier product URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Product imports require a public HTTPS URL without embedded credentials.');
  if (url.port && url.port !== '443') throw new Error('Product imports only support the standard HTTPS port.');
  if (!url.hostname || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) {
    throw new Error('The URL must point to a public supplier website.');
  }
  let addresses;
  try {
    if (isIP(url.hostname)) addresses = [{ address: url.hostname }];
    else addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch { throw new Error('The supplier URL host could not be resolved.'); }
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('The supplier URL must resolve only to public internet addresses.');
  return url;
}

async function readLimitedBody(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PRODUCT_PAGE_BYTES) {
      await reader.cancel();
      throw new Error('The supplier page is larger than the importer limit.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchProductPage(raw) {
  let url = await validateProductPageUrl(raw);
  for (let redirects = 0; redirects <= MAX_PRODUCT_PAGE_REDIRECTS; redirects += 1) {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': 'BrightcartProductResearch/1.0', Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(12000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirects === MAX_PRODUCT_PAGE_REDIRECTS) throw new Error('The supplier page redirected too many times.');
      url = await validateProductPageUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Supplier page returned HTTP ${response.status}.`);
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (!type.includes('text/html') && !type.includes('application/xhtml+xml')) throw new Error('The supplier URL did not return a readable HTML product page.');
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_PRODUCT_PAGE_BYTES) throw new Error('The supplier page is larger than the importer limit.');
    return { html: await readLimitedBody(response), finalUrl: url.toString() };
  }
  throw new Error('Could not follow the supplier page redirect.');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)));
}

function htmlAttributes(source) {
  const result = {};
  String(source || '').replace(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g, (_match, key, doubleValue, singleValue, bareValue) => {
    result[key.toLowerCase()] = decodeHtml(doubleValue ?? singleValue ?? bareValue ?? '');
    return _match;
  });
  return result;
}

function pageMeta(html, key) {
  const wanted = key.toLowerCase();
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = htmlAttributes(tag.replace(/^<meta\b/i, '').replace(/>$/, ''));
    if ([attrs.property, attrs.name, attrs.itemprop].some(value => value?.toLowerCase() === wanted)) return attrs.content || '';
  }
  return '';
}

function absolutePublicWebUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim(), base);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch { return ''; }
}

function productNodes(value, output = [], seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) productNodes(item, output, seen, depth + 1);
    return output;
  }
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  if (types.some(type => ['Product', 'ProductGroup'].includes(type))) output.push(value);
  for (const [key, child] of Object.entries(value)) if (child && typeof child === 'object') productNodes(child, output, seen, depth + 1);
  return output;
}

function productOffer(product) {
  const raw = product?.offers;
  const offers = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const offer = offers.find(item => item && (item.price != null || item.lowPrice != null)) || offers[0] || {};
  const priceValue = offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price;
  const price = typeof priceValue === 'string' ? Number(priceValue.replace(/,/g, '').match(/[+-]?(?:\d+\.?\d*|\.\d+)/)?.[0]) : Number(priceValue);
  return { price: Number.isFinite(price) && price > 0 ? price : null, currency: clean(offer.priceCurrency || offer.priceSpecification?.priceCurrency).toUpperCase() || null, offer };
}

function productImages(product, html, baseUrl) {
  const raw = product?.image ?? product?.images ?? [];
  const values = Array.isArray(raw) ? raw : [raw];
  const images = [];
  for (const value of values) {
    const source = typeof value === 'string' ? value : value?.url || value?.contentUrl;
    const url = absolutePublicWebUrl(source, baseUrl);
    if (url) images.push(url);
  }
  for (const value of [pageMeta(html, 'og:image'), pageMeta(html, 'twitter:image')]) {
    const url = absolutePublicWebUrl(value, baseUrl);
    if (url) images.push(url);
  }
  return [...new Set(images)].slice(0, 20);
}

function productVariantList(product, baseUrl) {
  const raw = product?.hasVariant ?? product?.variants ?? [];
  const values = Array.isArray(raw) ? raw : [raw];
  const variants = [];
  for (const item of values) {
    if (!item || typeof item !== 'object') continue;
    const color = clean(item.color || item.colorName);
    if (!color) continue;
    const images = productImages(item, '', baseUrl);
    const offer = productOffer(item);
    variants.push({
      id: clean(item.sku || item.productID) || color.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: color,
      color,
      image: images[0] || '',
      images,
      sku: clean(item.sku) || '',
      price: offer.price,
      currency: offer.currency,
    });
  }
  return variants.slice(0, 30);
}

function normalizeCategory(value) {
  const category = clean(value).toLowerCase();
  if (/phone accessory|phone case|screen protector|charger|charging cable|earbuds?/.test(category)) return 'phone-accessories';
  if (/smart ?phone|mobile phone|cell phone|\bphone\b/.test(category)) return 'phones';
  if (/laptop|computer accessory/.test(category)) return 'laptop-accessories';
  if (/electrical appliance|electrical|power adapter/.test(category)) return 'electrical';
  return category.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function shippingFromSchema(product, destination) {
  const countryCode = value => {
    const normalized = clean(value).toLowerCase().replace(/\s+/g, ' ');
    const aliases = { ghana: 'gh', nigeria: 'ng', 'united states': 'us', 'united states of america': 'us', usa: 'us', 'united kingdom': 'gb', uk: 'gb', canada: 'ca', australia: 'au' };
    return aliases[normalized] || normalized;
  };
  const country = countryCode(destination);
  if (!country) return { status: 'unknown', cost: null, currency: null, days: null };
  const raw = product?.offers;
  const offers = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const offer of offers) {
    const detailsRaw = offer?.shippingDetails;
    const details = Array.isArray(detailsRaw) ? detailsRaw : detailsRaw ? [detailsRaw] : [];
    for (const detail of details) {
      const destinationRaw = detail?.shippingDestination?.addressCountry
        || detail?.shippingDestination?.name
        || detail?.shippingDestination?.identifier;
      const destinationValue = typeof destinationRaw === 'object'
        ? destinationRaw.name || destinationRaw.identifier || destinationRaw['@id']
        : destinationRaw;
      if (countryCode(destinationValue) !== country) continue;
      const rateValue = detail?.shippingRate?.value ?? detail?.shippingRate?.price;
      const rate = typeof rateValue === 'string' ? Number(rateValue.replace(/,/g, '')) : Number(rateValue);
      if (!Number.isFinite(rate) || rate < 0) continue;
      const currency = clean(detail?.shippingRate?.currency || detail?.shippingRate?.priceCurrency || offer.priceCurrency).toUpperCase() || null;
      const transit = detail?.deliveryTime?.transitTime;
      const min = Number(transit?.minValue);
      const max = Number(transit?.maxValue);
      const days = Number.isFinite(max) && max >= 0 ? max : Number.isFinite(min) && min >= 0 ? min : null;
      return { status: rate === 0 ? 'free' : 'paid', cost: rate, currency, days };
    }
  }
  return { status: 'unknown', cost: null, currency: null, days: null };
}

function pricePolicy() {
  const paymentFeePercent = Number(process.env.DROPSHIP_PAYMENT_FEE_PERCENT ?? 0);
  const platformFeePercent = Number(process.env.DROPSHIP_PLATFORM_FEE_PERCENT ?? 0);
  const roundingIncrement = Number(process.env.DROPSHIP_PRICE_ROUNDING_INCREMENT ?? 1);
  return {
    targetMarginPercent: 35,
    paymentFeePercent: Number.isFinite(paymentFeePercent) && paymentFeePercent >= 0 ? paymentFeePercent : 0,
    platformFeePercent: Number.isFinite(platformFeePercent) && platformFeePercent >= 0 ? platformFeePercent : 0,
    roundingIncrement: Number.isFinite(roundingIncrement) && roundingIncrement > 0 ? roundingIncrement : 1,
    feesConfigured: Boolean(process.env.DROPSHIP_PAYMENT_FEE_PERCENT && process.env.DROPSHIP_PLATFORM_FEE_PERCENT),
  };
}

function recommendRetailPrice(unitCost, shippingCost, policy = pricePolicy()) {
  if (!Number.isFinite(unitCost) || unitCost <= 0 || !Number.isFinite(shippingCost) || shippingCost < 0) return null;
  const fees = (policy.paymentFeePercent + policy.platformFeePercent) / 100;
  const denominator = 1 - fees - policy.targetMarginPercent / 100;
  if (denominator <= 0 || denominator > 1) return null;
  return Math.ceil(((unitCost + shippingCost) / denominator) / policy.roundingIncrement) * policy.roundingIncrement;
}

function parseProductHtml(html, finalUrl, destination) {
  const scripts = String(html || '').match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  const nodes = [];
  for (const script of scripts) {
    const body = script.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try { nodes.push(JSON.parse(body)); } catch { /* Ignore malformed structured-data blocks. */ }
  }
  const products = nodes.flatMap(node => productNodes(node));
  const product = products.find(item => (Array.isArray(item['@type']) ? item['@type'] : [item['@type']]).includes('ProductGroup') && (item.hasVariant || item.offers))
    || products.find(item => (Array.isArray(item['@type']) ? item['@type'] : [item['@type']]).includes('Product'))
    || products.find(item => (Array.isArray(item['@type']) ? item['@type'] : [item['@type']]).includes('ProductGroup'))
    || {};
  const pageTitle = pageMeta(html, 'og:title')
    || pageMeta(html, 'twitter:title')
    || decodeHtml(String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim();
  const productName = clean(product.name || product.alternateName || pageTitle);
  const description = clean(product.description || pageMeta(html, 'og:description') || pageMeta(html, 'description'));
  const supplierName = clean(pageMeta(html, 'og:site_name')) || new URL(finalUrl).hostname.replace(/^www\./i, '');
  const brand = clean(typeof product.brand === 'string' ? product.brand : product.brand?.name);
  const categoryRaw = clean(product.category || pageMeta(html, 'product:category'));
  let offer = productOffer(product);
  if (!offer.price) {
    const metaPrice = pageMeta(html, 'product:price:amount') || pageMeta(html, 'og:price:amount') || pageMeta(html, 'price');
    const price = Number(String(metaPrice).replace(/,/g, '').match(/[+-]?(?:\d+\.?\d*|\.\d+)/)?.[0]);
    if (Number.isFinite(price) && price > 0) offer = { ...offer, price, currency: (pageMeta(html, 'product:price:currency') || pageMeta(html, 'og:price:currency') || pageMeta(html, 'pricecurrency')).toUpperCase() || null };
  }
  const variants = productVariantList(product, finalUrl);
  const images = productImages(product, html, finalUrl);
  const destinationShipping = shippingFromSchema(product, destination);
  const facts = [];
  if (description) facts.push(description);
  if (brand) facts.push(`Brand: ${brand}`);
  if (categoryRaw) facts.push(`Supplier category: ${categoryRaw}`);
  if (clean(product.sku)) facts.push(`Supplier SKU: ${clean(product.sku)}`);
  if (product.color) facts.push(`Listed color: ${clean(product.color)}`);
  const availability = clean(offer.offer?.availability);
  if (availability) facts.push(`Supplier listing availability: ${availability.split('/').pop().replace(/([A-Z])/g, ' $1').trim()}.`);
  for (const prop of Array.isArray(product.additionalProperty) ? product.additionalProperty : []) {
    const name = clean(prop.name);
    const value = clean(prop.value);
    if (name && value) facts.push(`${name}: ${value}`);
  }
  const variantsFromGroup = products.filter(item => clean(item.color) && item !== product).map(item => {
    const variantImages = productImages(item, '', finalUrl);
    const variantOffer = productOffer(item);
    const color = clean(item.color);
    return { id: clean(item.sku || item.productID) || color.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: color, color, image: variantImages[0] || '', images: variantImages, sku: clean(item.sku) || '', price: variantOffer.price, currency: variantOffer.currency };
  });
  const allVariants = [...new Map([...variants, ...variantsFromGroup].map(item => [item.color.toLowerCase(), item])).values()].slice(0, 30);
  const sourceCurrency = offer.currency;
  const sameCurrencyShipping = destinationShipping.status === 'free'
    || (destinationShipping.status === 'paid' && sourceCurrency && destinationShipping.currency === sourceCurrency);
  const suggestedRetailPrice = offer.price
    ? recommendRetailPrice(offer.price, sameCurrencyShipping && destinationShipping.status === 'paid' ? destinationShipping.cost : 0)
    : null;
  const missingSignals = [];
  if (!offer.price) missingSignals.push('Supplier unit price');
  if (!images.length) missingSignals.push('Product images');
  if (!destination) missingSignals.push('Shipping destination country');
  if (destinationShipping.status === 'unknown') missingSignals.push('Shipping cost to the selected destination');
  if (!suggestedRetailPrice) missingSignals.push('Retail price recommendation');
  if (!allVariants.length) missingSignals.push('Color variants (none were found in structured product data)');
  return {
    productName,
    category: normalizeCategory(categoryRaw),
    supplierName,
    supplierUrl: finalUrl,
    sourceUrl: finalUrl,
    description,
    imageUrl: images[0] || '',
    images,
    unitCost: offer.price,
    currency: offer.currency,
    shippingStatus: sameCurrencyShipping ? destinationShipping.status : 'unknown',
    shippingCost: sameCurrencyShipping && destinationShipping.status === 'paid' ? destinationShipping.cost : sameCurrencyShipping ? 0 : null,
    shippingCurrency: sameCurrencyShipping ? destinationShipping.currency || sourceCurrency : destinationShipping.currency,
    shippingDestination: clean(destination).toUpperCase(),
    shippingDays: destinationShipping.days,
    suggestedRetailPrice,
    availableStock: null,
    variants: allVariants,
    verifiedFacts: [...new Set(facts)].slice(0, 30),
    missingSignals,
    pricingPolicy: pricePolicy(),
  };
}

function extractJsonObject(value) {
  const text = String(value || '').trim().replace(/^\x60{3}(?:json)?\s*/i, '').replace(/\s*\x60{3}$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The AI provider returned invalid JSON.');
  return JSON.parse(text.slice(start, end + 1));
}

async function generateWithGemini(payload) {
  const key = clean(process.env.GEMINI_API_KEY);
  if (!key) throw new Error('Not configured.');
  const model = clean(process.env.GEMINI_MODEL) || 'gemini-2.5-flash-lite';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      system_instruction: { parts: [{ text: payload.system }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(payload.input) }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    }),
  });
  if (!response.ok) throw new Error(`Gemini returned HTTP ${response.status}.`);
  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('');
  return extractJsonObject(text);
}

async function generateWithGroq(payload) {
  const key = clean(process.env.GROQ_API_KEY);
  if (!key) throw new Error('Not configured.');
  const model = clean(process.env.GROQ_MODEL) || 'openai/gpt-oss-20b';
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 1200,
      messages: [{ role: 'system', content: payload.system }, { role: 'user', content: JSON.stringify(payload.input) }],
    }),
  });
  if (!response.ok) throw new Error(`Groq returned HTTP ${response.status}.`);
  const result = await response.json();
  return extractJsonObject(result.choices?.[0]?.message?.content);
}

async function generateWithOllama(payload) {
  const base = normalizeLocalBase();
  const model = clean(process.env.OLLAMA_MODEL);
  if (!base || !model) throw new Error('Not configured.');
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(45000),
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      messages: [{ role: 'system', content: payload.system }, { role: 'user', content: JSON.stringify(payload.input) }],
      options: { temperature: 0.2 },
    }),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
  const result = await response.json();
  return extractJsonObject(result.message?.content);
}

async function generateProductCopy(candidate) {
  const facts = Array.isArray(candidate.verifiedFacts) ? candidate.verifiedFacts : [];
  const payload = {
    system: 'Write cautious ecommerce copy using only the supplied facts. Never add specifications, materials, dimensions, certifications, performance claims, shipping promises, or benefits not explicitly present. If facts are sparse, keep copy sparse. Return JSON with title, description, bullets (array), seoTitle, seoDescription, and faqs (array of question/answer objects). This output is a draft for human review.',
    input: { productName: candidate.productName, category: candidate.category, verifiedFacts: facts, supplierName: candidate.supplierName, sourceUrl: candidate.sourceUrl },
  };
  const local = await localAiStatus();
  const providers = configuredAiProviders(local);
  const generators = [
    ['Google Gemini', providers.find(provider => provider.id === 'gemini')?.configured, generateWithGemini],
    ['Groq', providers.find(provider => provider.id === 'groq')?.configured, generateWithGroq],
    ['Ollama local', providers.find(provider => provider.id === 'ollama')?.available, generateWithOllama],
  ];
  const failures = [];
  for (const [name, enabled, generate] of generators) {
    if (!enabled) continue;
    try {
      return { content: await generate(payload), provider: name };
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }
  throw new Error(failures.length ? failures.join(' · ') : 'No AI provider is configured.');
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
      ai: await aiStatus(),
      pricing: pricePolicy(),
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

  router.delete('/research/:id', async (req, res) => {
    try {
      let removed;
      if (dbReady()) {
        removed = await Research.findByIdAndDelete(req.params.id);
      } else {
        const index = memory.research.findIndex(item => String(item._id) === String(req.params.id));
        if (index >= 0) removed = memory.research.splice(index, 1)[0];
      }
      if (!removed) return res.status(404).json({ success: false, error: 'Research candidate not found.' });
      await writeActivity('research_deleted', `Removed research candidate: ${removed.productName}`, safeUser(req), removed._id);
      res.json({ success: true, data: { id: String(removed._id) } });
    } catch (error) {
      res.status(500).json({ success: false, error: `Could not remove this research candidate: ${error.message}` });
    }
  });

  router.post('/research/extract', async (req, res) => {
    const rawUrl = clean(req.body.url);
    const destination = clean(req.body.destinationCountry);
    try {
      const source = await validateProductPageUrl(rawUrl);
      const { html, finalUrl } = await fetchProductPage(source.toString());
      const extracted = parseProductHtml(html, finalUrl, destination);
      if (!extracted.productName) return res.status(422).json({ success: false, error: 'The page does not expose a product name. Enter product facts manually or use another source page.' });
      res.json({
        success: true,
        data: extracted,
        source: finalUrl,
        extractionMode: 'public product metadata; dynamic-only supplier pages may need manual review',
      });
    } catch (error) {
      res.status(422).json({ success: false, error: error.message || 'Could not extract the supplier page.' });
    }
  });

  router.post('/research', async (req, res) => {
    const shippingStatus = ['unknown', 'free', 'paid'].includes(req.body.shippingStatus) ? req.body.shippingStatus : 'unknown';
    const input = {
      productName: clean(req.body.productName),
      category: clean(req.body.category),
      sourceUrl: clean(req.body.sourceUrl),
      supplierName: clean(req.body.supplierName),
      supplierUrl: clean(req.body.supplierUrl),
      imageUrl: clean(req.body.imageUrl),
      images: Array.isArray(req.body.images) ? [...new Set(req.body.images.map(clean).filter(Boolean))].slice(0, 20) : [],
      verifiedFacts: Array.isArray(req.body.verifiedFacts) ? req.body.verifiedFacts.map(clean).filter(Boolean).slice(0, 30) : [],
      variants: Array.isArray(req.body.variants) ? req.body.variants.filter(item => item && typeof item === 'object').slice(0, 30) : [],
      unitCost: req.body.unitCost === '' || req.body.unitCost == null ? null : Number(req.body.unitCost),
      shippingStatus,
      shippingCost: shippingStatus === 'free' ? 0 : shippingStatus === 'paid' && req.body.shippingCost !== '' && req.body.shippingCost != null ? Number(req.body.shippingCost) : null,
      shippingDestination: clean(req.body.shippingDestination).toUpperCase(),
      shippingCurrency: clean(req.body.shippingCurrency || req.body.supplierCurrency || 'USD').toUpperCase(),
      retailPrice: req.body.retailPrice === '' || req.body.retailPrice == null ? null : Number(req.body.retailPrice),
      availableStock: req.body.availableStock === '' || req.body.availableStock == null ? null : Number(req.body.availableStock),
      shippingDays: req.body.shippingDays === '' || req.body.shippingDays == null ? null : Number(req.body.shippingDays),
      currency: clean(req.body.currency || 'USD').toUpperCase(),
      supplierCurrency: clean(req.body.supplierCurrency || req.body.currency || 'USD').toUpperCase(),
      state: 'researched',
      researchedBy: safeUser(req),
      researchedAt: new Date(),
    };
    let source;
    try { source = new URL(input.sourceUrl); } catch { return res.status(400).json({ success: false, error: 'Enter a valid supplier or research source URL.' }); }
    if (!['http:', 'https:'].includes(source.protocol)) return res.status(400).json({ success: false, error: 'Source URLs must use HTTPS or HTTP.' });
    if (!input.productName || !input.category || !input.supplierName) return res.status(400).json({ success: false, error: 'Product name, category, and supplier are required.' });
    if (input.unitCost !== null && (!Number.isFinite(input.unitCost) || input.unitCost < 0)) return res.status(400).json({ success: false, error: 'Supplier unit cost must be a non-negative amount.' });
    if (input.shippingStatus === 'paid' && (!Number.isFinite(input.shippingCost) || input.shippingCost < 0)) return res.status(400).json({ success: false, error: 'Enter the confirmed supplier shipping fee, or mark shipping as unknown.' });
    if (input.retailPrice !== null && (!Number.isFinite(input.retailPrice) || input.retailPrice <= 0)) return res.status(400).json({ success: false, error: 'Retail price must be a positive amount or left blank until costs are confirmed.' });
    if (input.availableStock !== null && (!Number.isInteger(input.availableStock) || input.availableStock < 0)) return res.status(400).json({ success: false, error: 'Available stock must be a whole number or left blank when unknown.' });
    if (input.shippingDays != null && (!Number.isFinite(input.shippingDays) || input.shippingDays < 0)) return res.status(400).json({ success: false, error: 'Shipping days must be zero or greater.' });
    if (input.unitCost !== null) {
      const shippingForPrice = input.shippingStatus === 'free' ? 0 : input.shippingStatus === 'paid' ? input.shippingCost : 0;
      input.retailPrice = recommendRetailPrice(input.unitCost, shippingForPrice);
    }
    Object.assign(input, scoreCandidate(input));
    try {
      const saved = await saveResearch(input);
      await writeActivity('research_created', `Added research candidate: ${input.productName}`, safeUser(req), saved._id, { sourceUrl: input.sourceUrl });
      res.status(201).json({ success: true, data: saved });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/research/:id/generate-content', async (req, res) => {
    try {
      const candidate = dbReady() ? await Research.findById(req.params.id) : memory.research.find(item => String(item._id) === req.params.id);
      if (!candidate) return res.status(404).json({ success: false, error: 'Research candidate not found.' });
      const result = await generateProductCopy(candidate);
      const content = result.content;
      for (const key of ['title', 'description', 'seoTitle', 'seoDescription']) if (typeof content[key] !== 'string') content[key] = '';
      content.bullets = Array.isArray(content.bullets) ? content.bullets.filter(item => typeof item === 'string').slice(0, 8) : [];
      content.faqs = Array.isArray(content.faqs) ? content.faqs.filter(item => item && typeof item.question === 'string' && typeof item.answer === 'string').slice(0, 8) : [];
      content.reviewRequired = true;
      candidate.content = content;
      if (candidate.save) await candidate.save();
      await writeActivity('content_generated', `Generated draft copy for ${candidate.productName}`, safeUser(req), candidate._id, { provider: result.provider });
      res.json({ success: true, data: candidate, provider: result.provider });
    } catch (error) {
      res.status(503).json({ success: false, error: `AI content generation failed: ${error.message}` });
    }
  });

  router.post('/research/:id/import', requirePublisher, async (req, res) => {
    try {
      const candidate = dbReady() ? await Research.findById(req.params.id).lean() : memory.research.find(item => String(item._id) === req.params.id);
      if (!candidate) return res.status(404).json({ success: false, error: 'Research candidate not found.' });
      if (!clean(candidate.productName) || !clean(candidate.category)) return res.status(422).json({ success: false, error: 'Set a product name and select a product category before creating its draft.' });
      const product = toProduct(candidate);
      if (Number.isFinite(Number(candidate.unitCost)) && Number(candidate.unitCost) > 0) {
        const shippingForPrice = candidate.shippingStatus === 'free' ? 0
          : candidate.shippingStatus === 'paid' && Number.isFinite(Number(candidate.shippingCost)) ? Number(candidate.shippingCost)
            : 0;
        const recommended = recommendRetailPrice(Number(candidate.unitCost), shippingForPrice);
        if (recommended !== null) {
          product.price = recommended;
          product.originalPrice = recommended;
        }
      }
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
      if (!['free', 'paid'].includes(product.supplierDetails?.shippingStatus)) missing.push('supplier shipping status for destination');
      if (!clean(product.supplierDetails?.shippingDestination)) missing.push('shipping destination');
      if (product.supplierDetails?.shippingStatus === 'paid' && (product.supplierDetails?.shippingCost == null || product.supplierDetails.shippingCost === '' || !Number.isFinite(Number(product.supplierDetails.shippingCost)) || Number(product.supplierDetails.shippingCost) < 0)) missing.push('confirmed supplier shipping fee');
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

