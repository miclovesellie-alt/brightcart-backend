# Shoppercart Backend API

Express and MongoDB API for the Shoppercart storefront and admin workspace.

## Run locally

1. Install Node.js and MongoDB (local MongoDB is sufficient for development).
2. Copy `.env.example` to `.env`, then set a private `JWT_SECRET`, `SUPER_ADMIN_EMAIL`, and `SUPER_ADMIN_PASSWORD`.
3. Install dependencies and start the API:

   ```sh
   npm install
   npm run dev
   ```

The API listens on `http://localhost:5000/api` by default. The frontend uses this URL in local development; production must set `VITE_API_URL` to the deployed backend's `/api` URL. The API can start without MongoDB, but its in-memory users, research, purchases, and orders disappear when the process stops.

## Authentication and authorization

- `POST /api/auth/register` creates customer accounts only. It accepts a valid email, name, and password of at least 10 characters; clients cannot choose an elevated role.
- `POST /api/auth/login` checks the stored password hash and returns an 8-hour signed JWT. `GET /api/auth/me` validates that token against the current account and status.
- Passwords are stored as Node.js `scrypt` hashes with a fresh random salt per password. Successful logins for old SHA-256 records upgrade the hash. The configured super admin is bootstrapped from environment variables when the API starts.
- Authenticated requests send `Authorization: Bearer <token>`. Middleware verifies the JWT and reloads the account, then route middleware checks its role. Super admins manage team accounts; admins manage catalog and orders; moderators have restricted admin access.
- The frontend keeps the token in tab-scoped `sessionStorage`, clears it on sign-out, expiry, failed session validation, or a `401`, and logs admins out after 30 minutes without activity. Passwords are sent only to the API over the configured connection; they are not saved in browser storage.
- Five consecutive failed logins for the same IP and email trigger an increasing temporary lockout. This counter is process-local and resets when the server restarts.

Email verification and password reset are not implemented in this repository. Configure HTTPS and a strong, private JWT secret before exposing the API publicly.

## Catalog, orders, and payment state

Public catalog requests hide drafts, out-of-stock products, supplier details, and cost fields. The API does not seed demo products; the original sample catalog records are kept as drafts so they can be recovered or removed by an admin. Add real products through the admin catalog before they appear in the storefront. Admin product and order routes require a valid JWT and role. Order totals are recomputed from the current catalog on the server; the browser's Paystack callback creates an order as `pending_verification`, never as paid. A super admin must compare the reference with Paystack and record the manual verification before that order can be used for a supplier purchase record. This code does not verify payments through Paystack's API.

Admin product records accept `images` as an ordered array of public image URLs; the first URL is also stored in the legacy `image` field for existing clients. Categories are free-form strings, so admins can create categories without a backend migration. Supplier unit cost and inbound shipping per unit are stored in `cost` and `supplierDetails.unitCost` / `supplierDetails.shippingCost`; the storefront API removes these internal costs from public product responses.

Catalog prices are stored in USD for consistent orders and payments. Product entry may record an `inputCurrency` for the admin's reference; the frontend converts entered prices and supplier costs to USD before saving, then formats USD values in each shopper's preferred currency.

## Dropshipping workspace

The `/api/dropship` routes back the integrated admin research, pricing, product studio, fulfillment, and connection views. Research candidates can be extracted from a public HTTPS supplier product URL. The importer reads JSON-LD and Open Graph product metadata, captures ordered image URLs and structured color options, and checks shipping only when the page specifies a rate for the destination country supplied by the admin. It does not guess stock quantity, shipping, currency, or unsupported details. Login-protected, JavaScript-only, and blocked pages may need manual entry. Product-page fetching rejects private/localhost addresses and unsafe redirects.

The score uses only entered or extracted costs, stock, and shipping estimates, and explicitly reports missing trend, demand, competition, and supplier-history signals. Import creates a hidden catalog draft, including incomplete extracted facts for admin review. Publishing requires a positive retail price, image, stock, supplier source and cost, confirmed shipping status, and explicit policy, inventory, and content review. Color variants and their images are carried into the storefront, cart, and order snapshot.

AI product copy tries the configured providers in this order: Gemini, Groq, then local Ollama. HTTP errors, quota exhaustion, and invalid responses move to the next configured provider. The code does not use a paid-provider fallback or send AI requests for product extraction or pricing; provider keys and model overrides are optional server-side settings. Keep Gemini and Groq projects on a free tier if you want to avoid provider charges. AI copy is only generated from recorded facts and remains a draft for human review. Set `GEMINI_API_KEY` and/or `GROQ_API_KEY`; Ollama can be configured with `OLLAMA_BASE_URL` and `OLLAMA_MODEL`.

Suggested retail price is calculated deterministically to target a fixed 20% contribution margin after configured payment and platform fees, using the confirmed supplier cost and destination shipping where available. When shipping is unknown or stated in a different currency, the initial draft price uses supplier unit cost only and is clearly flagged for review; confirming shipping and recalculating updates the price. `DROPSHIP_PAYMENT_FEE_PERCENT`, `DROPSHIP_PLATFORM_FEE_PERCENT`, and `DROPSHIP_PRICE_ROUNDING_INCREMENT` control actual fees and rounding. Absent fee settings default to 0% and should be configured before publishing.

No supplier API or credentials are included. Stock sync and automatic purchasing are off. The fulfillment page can record supplier orders placed manually through an authorized supplier channel, after an order is marked paid. MongoDB stores these records when connected; otherwise they are temporary in-memory records.

## Environment

See `.env.example` for the supported settings. Keep `.env` and all real secrets out of source control. `CORS_ORIGIN` accepts a comma-separated list of frontend origins.

