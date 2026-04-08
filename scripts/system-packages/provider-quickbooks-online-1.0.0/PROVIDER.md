# QuickBooks Online Provider

Base URL: `https://quickbooks.api.intuit.com/v3`
Sandbox: `https://sandbox-quickbooks.api.intuit.com/v3`

## Important: Company ID (Realm ID) Required

All API requests include a **Company ID** (also called Realm ID) in the URL path. This ID is returned during the OAuth flow and identifies the connected QuickBooks company.

URL pattern: `/v3/company/{companyId}/...`

Add `?minorversion=75` to all requests for the latest features.

## Key Endpoints

### Get Company Info

```
GET /v3/company/{companyId}/companyinfo/{companyId}?minorversion=75
```

### Query (SQL-like)

```
GET /v3/company/{companyId}/query?query=SELECT * FROM Customer&minorversion=75
```

QuickBooks uses a SQL-like query language for list endpoints. Supports `WHERE`, `ORDER BY`, `STARTPOSITION`, `MAXRESULTS`.

### Get Customer

```
GET /v3/company/{companyId}/customer/{customerId}?minorversion=75
```

### Create Customer

```
POST /v3/company/{companyId}/customer?minorversion=75
Content-Type: application/json

{
  "DisplayName": "John Doe",
  "PrimaryEmailAddr": { "Address": "john@example.com" }
}
```

### Get Invoice

```
GET /v3/company/{companyId}/invoice/{invoiceId}?minorversion=75
```

### Create Invoice

```
POST /v3/company/{companyId}/invoice?minorversion=75
Content-Type: application/json

{
  "CustomerRef": { "value": "{customerId}" },
  "Line": [
    {
      "Amount": 150.00,
      "DetailType": "SalesItemLineDetail",
      "SalesItemLineDetail": {
        "ItemRef": { "value": "{itemId}" }
      }
    }
  ]
}
```

### Create Payment

```
POST /v3/company/{companyId}/payment?minorversion=75
Content-Type: application/json

{
  "CustomerRef": { "value": "{customerId}" },
  "TotalAmt": 150.00
}
```

### List Accounts

```
GET /v3/company/{companyId}/query?query=SELECT * FROM Account&minorversion=75
```

### Create Bill

```
POST /v3/company/{companyId}/bill?minorversion=75
Content-Type: application/json

{
  "VendorRef": { "value": "{vendorId}" },
  "Line": [
    {
      "Amount": 200.00,
      "DetailType": "AccountBasedExpenseLineDetail",
      "AccountBasedExpenseLineDetail": {
        "AccountRef": { "value": "{accountId}" }
      }
    }
  ]
}
```

## Notes

- Access tokens expire after 1 hour, refresh tokens after 100 days
- Company ID is returned in the OAuth callback URL as `realmId` parameter
- Uses `client_secret_basic` (HTTP Basic Auth) for token exchange
- All updates require the `SyncToken` field from the latest read (optimistic locking)
- Void operations: `POST /v3/company/{id}/invoice/{id}?operation=void`
- Sandbox environment available for testing
