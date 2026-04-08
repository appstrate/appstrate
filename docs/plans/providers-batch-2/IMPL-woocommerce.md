# IMPL: WooCommerce Provider

## Provider Info
- **Slug**: `woocommerce`
- **Display Name**: WooCommerce
- **Auth Mode**: API Key
- **Base URL**: `https://{site}/wp-json/wc/v3`
- **Docs**: https://woocommerce.github.io/woocommerce-rest-api-docs/

## Auth Details
- **Auth Mode**: `api_key`
- **Credential Schema**:
  - `site_url` (string) — WordPress/WooCommerce site URL
  - `consumer_key` (string) — Consumer Key (starts with `ck_`)
  - `consumer_secret` (string) — Consumer Secret (starts with `cs_`)
- **Header**: `Authorization: Basic base64(consumer_key:consumer_secret)`

## Authorized URIs
- `https://*/*` → `allowAllUris: true` (site URLs vary)

## Setup Guide
1. Go to WooCommerce → Settings → Advanced → REST API
2. Add a new API key with Read/Write permissions
3. Copy the Consumer Key and Consumer Secret

## Key Endpoints to Document
1. GET /wc/v3/products — List products
2. GET /wc/v3/products/{id} — Get product
3. POST /wc/v3/products — Create product
4. PUT /wc/v3/products/{id} — Update product
5. DELETE /wc/v3/products/{id} — Delete product
6. GET /wc/v3/orders — List orders
7. GET /wc/v3/orders/{id} — Get order
8. PUT /wc/v3/orders/{id} — Update order
9. GET /wc/v3/customers — List customers
10. GET /wc/v3/customers/{id} — Get customer
11. GET /wc/v3/reports/sales — Sales report
12. GET /wc/v3/coupons — List coupons

## Compatibility Notes
- Uses WooCommerce REST API keys (consumer_key + consumer_secret) with HTTP Basic Auth
- `allowAllUris: true` needed since site URLs are user-specific
- HTTPS required for Basic Auth (WooCommerce falls back to OAuth1 for HTTP)
- Pagination uses `page` and `per_page` params + `X-WP-Total` / `X-WP-TotalPages` headers
- Rate limits depend on hosting provider
- Batch operations: POST /wc/v3/products/batch (create, update, delete multiple)
