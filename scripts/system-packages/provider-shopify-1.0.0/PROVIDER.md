# Shopify Provider

Base URL: `https://{shop_domain}/admin/api/2024-10`

Replace `{shop_domain}` with the store domain from the connection credentials (e.g. `mystore.myshopify.com`).

## Authentication

This provider uses a Custom App access token sent via the `X-Shopify-Access-Token` header (injected automatically by the sidecar). Custom App tokens do not expire.

Shopify OAuth requires shop-specific URLs and is not used here. Instead, users create a Custom App in their Shopify admin and provide the access token directly.

## Key Endpoints

### Get Shop Info

```
GET /admin/api/2024-10/shop.json
```

### List Products

```
GET /admin/api/2024-10/products.json
```

Supports `?limit=50`, `?since_id=`, `?status=active|draft|archived`.

### Get Product

```
GET /admin/api/2024-10/products/{productId}.json
```

### Create Product

```
POST /admin/api/2024-10/products.json
Content-Type: application/json

{
  "product": {
    "title": "My Product",
    "body_html": "<p>Description</p>",
    "vendor": "My Store",
    "product_type": "Shoes",
    "status": "draft"
  }
}
```

### Update Product

```
PUT /admin/api/2024-10/products/{productId}.json
Content-Type: application/json

{
  "product": { "id": "{productId}", "title": "Updated Title" }
}
```

### List Orders

```
GET /admin/api/2024-10/orders.json
```

Supports `?status=any|open|closed|cancelled`, `?created_at_min=`, `?financial_status=`.

### Get Order

```
GET /admin/api/2024-10/orders/{orderId}.json
```

### List Customers

```
GET /admin/api/2024-10/customers.json
```

### Get Customer

```
GET /admin/api/2024-10/customers/{customerId}.json
```

### Get Inventory Levels

```
GET /admin/api/2024-10/inventory_levels.json?location_ids={locationId}
```

## Notes

- API versioning in URL path (e.g. `2024-10`). Use the latest stable version.
- Rate limit: 40 requests per app per store (leaky bucket, 2/sec restore rate)
- Pagination uses `Link` headers with `page_info` cursor — follow `rel="next"` links
- All response bodies wrap the resource in a root key (e.g. `{ "product": { ... } }`)
- Bulk operations available via GraphQL Admin API for large data sets
