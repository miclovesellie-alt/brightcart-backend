# BrightCart Backend API

RESTful API backend for the BrightCart e-commerce platform.

## Features
- **Products API**: Full catalog retrieval, single product queries, and admin creation.
- **Orders API**: Place orders and list orders with real-time sync.
- **Authentication**: SHA-256 salted password hashing & session management for admin and customer accounts.
- **Security**: Hardened with Helmet headers, CORS policies, and request payload sanitization.

## Running Locally
```bash
npm install
npm run dev
```

API will be available at `http://localhost:5000/api`.
