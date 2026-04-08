# WooCommerce Provider

Base URL: `{{site_url}}/wp-json/wc/v3`

Replace `{{site_url}}` with the site URL from the connection credentials.

## Authentication

WooCommerce uses REST API keys with HTTP Basic Auth. The credentials (`{{consumer_key}}` and `{{consumer_secret}}`) are available via sidecar substitution. You must construct the `Authorization` header yourself:

```
Authorization: Basic base64({{consumer_key}}:{{consumer_secret}})
```

HTTPS is required for Basic Auth. The sidecar substitutes the credential placeholders automatically.

## Key Endpoints

### List Products

```
GET {{site_url}}/wp-json/wc/v3/products
```

Supports `?per_page=10&page=1`, `?status=publish|draft|pending`, `?category=`, `?search=`.

### Get Product

```
GET {{site_url}}/wp-json/wc/v3/products/{productId}
```

### Create Product

```
POST {{site_url}}/wp-json/wc/v3/products
Content-Type: application/json

{
  "name": "Premium T-Shirt",
  "type": "simple",
  "regular_price": "29.99",
  "description": "Quality cotton t-shirt",
  "short_description": "Premium quality",
  "categories": [{ "id": 1 }],
  "status": "publish"
}
```

### Update Product

```
PUT {{site_url}}/wp-json/wc/v3/products/{productId}
Content-Type: application/json

{
  "regular_price": "24.99",
  "sale_price": "19.99"
}
```

### Delete Product

```
DELETE {{site_url}}/wp-json/wc/v3/products/{productId}?force=true
```

### List Orders

```
GET {{site_url}}/wp-json/wc/v3/orders
```

Supports `?status=processing|completed|on-hold|cancelled`, `?after=2024-01-01T00:00:00`, `?customer=`.

### Get Order

```
GET {{site_url}}/wp-json/wc/v3/orders/{orderId}
```

### Update Order

```
PUT {{site_url}}/wp-json/wc/v3/orders/{orderId}
Content-Type: application/json

{
  "status": "completed"
}
```

### List Customers

```
GET {{site_url}}/wp-json/wc/v3/customers
```

### Get Customer

```
GET {{site_url}}/wp-json/wc/v3/customers/{customerId}
```

### Sales Report

```
GET {{site_url}}/wp-json/wc/v3/reports/sales?date_min=2024-01-01&date_max=2024-12-31
```

### List Coupons

```
GET {{site_url}}/wp-json/wc/v3/coupons
```

### Batch Operations

```
POST {{site_url}}/wp-json/wc/v3/products/batch
Content-Type: application/json

{
  "create": [{ "name": "Product 1", "regular_price": "10.00" }],
  "update": [{ "id": 123, "regular_price": "15.00" }],
  "delete": [456]
}
```

## Notes

- Pagination: `?page=N&per_page=M` (max 100). Response headers: `X-WP-Total`, `X-WP-TotalPages`
- `allowAllUris` is enabled because site URLs are user-specific
- Prices are strings (e.g. `"29.99"`)
- Order statuses: `pending`, `processing`, `on-hold`, `completed`, `cancelled`, `refunded`, `failed`
- Batch endpoints support `create`, `update`, `delete` arrays in a single request
- Rate limits depend on the hosting provider
