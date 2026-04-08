# IMPL: Shopify Provider

## Provider Info
- **Slug**: `shopify`
- **Display Name**: Shopify
- **Auth Mode**: OAuth2
- **Base URL**: `https://{shop}.myshopify.com/admin/api/2024-10`
- **Docs**: https://shopify.dev/docs/api/admin-rest

## Auth Details
- **Authorization URL**: `https://{shop}.myshopify.com/admin/oauth/authorize`
- **Token URL**: `https://{shop}.myshopify.com/admin/oauth/access_token`
- **Refresh URL**: none (Shopify offline tokens don't expire)
- **PKCE**: false
- **Token Auth Method**: `client_secret_post`
- **Scope Separator**: comma

## ⚠️ Compatibility Issue
Shopify OAuth is **shop-specific** — the authorization and token URLs contain `{shop}` which must be provided by the user. The Appstrate OAuth flow uses static URLs. This requires either:
1. A custom `authorizationParams` approach where the user enters their shop domain
2. Pre-configuring the shop URL in the connection settings

**Recommendation**: Use **API key** auth mode instead, with Custom App access tokens. Users create a Custom App in their Shopify admin and provide the access token. This is simpler and more compatible.

## Alternative: API Key Mode
- **Auth Mode**: `api_key`
- **Credential Schema**: `{ "shop_domain": "string", "access_token": "string" }`
- **Header**: `X-Shopify-Access-Token: {access_token}`

## Scopes (informational, for API key users to configure in Shopify admin)
- `read_products` — Read products
- `write_products` — Write products
- `read_orders` — Read orders
- `write_orders` — Write orders
- `read_customers` — Read customers
- `write_customers` — Write customers
- `read_inventory` — Read inventory
- `read_fulfillments` — Read fulfillments

## Authorized URIs
- `https://*.myshopify.com/*`

## Setup Guide
1. Go to your Shopify Admin → Settings → Apps → Develop apps
2. Create a Custom App and configure API scopes
3. Install the app and copy the Admin API access token

## Key Endpoints to Document
1. GET /admin/api/2024-10/products.json — List products
2. GET /admin/api/2024-10/products/{id}.json — Get product
3. POST /admin/api/2024-10/products.json — Create product
4. PUT /admin/api/2024-10/products/{id}.json — Update product
5. GET /admin/api/2024-10/orders.json — List orders
6. GET /admin/api/2024-10/orders/{id}.json — Get order
7. GET /admin/api/2024-10/customers.json — List customers
8. GET /admin/api/2024-10/customers/{id}.json — Get customer
9. GET /admin/api/2024-10/inventory_levels.json — Get inventory levels
10. GET /admin/api/2024-10/shop.json — Get shop info

## Compatibility Notes
- **Using API Key mode** due to shop-specific OAuth URLs
- API versioning in URL path (e.g. 2024-10)
- Rate limit: 40 requests per app per store, bucket-based (leaky bucket, 2/sec restore)
- Pagination via Link headers with `page_info` cursor
- Custom App access tokens don't expire
