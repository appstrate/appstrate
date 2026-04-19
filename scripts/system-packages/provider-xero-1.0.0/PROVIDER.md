# Xero Provider

Base URL: `https://api.xero.com/api.xro/2.0`

## Important: Multi-Tenant — xero-tenant-id Header Required

Xero is a **multi-tenant** API. After authentication, the user may have access to multiple organisations. Every API request **must** include the `xero-tenant-id` header.

To discover available tenants:

```
GET https://api.xero.com/connections
```

Returns a list of connected organisations with their `tenantId`. Use the desired `tenantId` as the `xero-tenant-id` header value on all subsequent requests.

## Key Endpoints

### Get Organisation Info

```
GET /api.xro/2.0/Organisation
xero-tenant-id: {tenantId}
```

### List Contacts

```
GET /api.xro/2.0/Contacts
xero-tenant-id: {tenantId}
```

Supports `?page=1` (100 items per page), `?where=` filter, `If-Modified-Since` header.

### Get Contact

```
GET /api.xro/2.0/Contacts/{ContactID}
xero-tenant-id: {tenantId}
```

### Create/Update Contacts

```
POST /api.xro/2.0/Contacts
xero-tenant-id: {tenantId}
Content-Type: application/json

{
  "Contacts": [
    { "Name": "Acme Corp", "EmailAddress": "info@acme.com" }
  ]
}
```

### List Invoices

```
GET /api.xro/2.0/Invoices
xero-tenant-id: {tenantId}
```

### Create Invoice

```
POST /api.xro/2.0/Invoices
xero-tenant-id: {tenantId}
Content-Type: application/json

{
  "Invoices": [
    {
      "Type": "ACCREC",
      "Contact": { "ContactID": "{contactId}" },
      "LineItems": [
        { "Description": "Consulting", "Quantity": 1, "UnitAmount": 500.00, "AccountCode": "200" }
      ],
      "Date": "2024-01-15",
      "DueDate": "2024-02-15"
    }
  ]
}
```

### List Chart of Accounts

```
GET /api.xro/2.0/Accounts
xero-tenant-id: {tenantId}
```

### List Bank Transactions

```
GET /api.xro/2.0/BankTransactions
xero-tenant-id: {tenantId}
```

### List Payments

```
GET /api.xro/2.0/Payments
xero-tenant-id: {tenantId}
```

## Notes

- Access tokens expire after 30 minutes, refresh tokens after 60 days
- `offline_access` scope is required for refresh tokens
- Supports `If-Modified-Since` header for conditional GET requests
- Pagination: `?page=N` (1-indexed, 100 items per page)
- Filtering: `?where=Type=="ACCREC"` (OData-like syntax)
- Rate limit: 60 calls per minute per tenant, 5,000 per day
