# Google Ads Provider

Base URL: `https://googleads.googleapis.com/v18`

## Important: Developer Token Required

Every API request **must** include a `developer-token` header with a valid Google Ads API developer token. This token is separate from OAuth credentials and must be obtained from a Google Ads Manager Account.

You must include this header on every request:

```
developer-token: YOUR_DEVELOPER_TOKEN
```

If managing accounts under a Manager (MCC) account, also include:

```
login-customer-id: MANAGER_ACCOUNT_ID
```

Customer IDs are 10-digit numbers **without hyphens** (e.g. `1234567890`, not `123-456-7890`).

## Key Endpoints

### List Accessible Customers

```
GET /v18/customers:listAccessibleCustomers
```

Returns customer resource names the authenticated user can access. No `developer-token` needed for this endpoint.

### Search (Paginated)

```
POST /v18/customers/{customerId}/googleAds:search
Content-Type: application/json

{
  "query": "SELECT campaign.id, campaign.name, campaign.status FROM campaign ORDER BY campaign.id"
}
```

Uses Google Ads Query Language (GAQL). Returns paginated results.

### Search Stream

```
POST /v18/customers/{customerId}/googleAds:searchStream
Content-Type: application/json

{
  "query": "SELECT campaign.id, campaign.name, metrics.impressions FROM campaign WHERE segments.date DURING LAST_30_DAYS"
}
```

Streaming variant — returns all rows in a single response (no pagination).

### Mutate Campaigns

```
POST /v18/customers/{customerId}/campaigns:mutate
Content-Type: application/json

{
  "operations": [
    {
      "create": {
        "name": "My Campaign",
        "advertisingChannelType": "SEARCH",
        "status": "PAUSED",
        "campaignBudget": "customers/{customerId}/campaignBudgets/{budgetId}"
      }
    }
  ]
}
```

### Mutate Ad Groups

```
POST /v18/customers/{customerId}/adGroups:mutate
Content-Type: application/json

{
  "operations": [
    {
      "create": {
        "name": "My Ad Group",
        "campaign": "customers/{customerId}/campaigns/{campaignId}",
        "status": "ENABLED",
        "type": "SEARCH_STANDARD"
      }
    }
  ]
}
```

### Get Customer Info

```
POST /v18/customers/{customerId}/googleAds:search

{
  "query": "SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer"
}
```

## Notes

- All data retrieval uses GAQL queries via `search` or `searchStream` endpoints
- Most write operations use `:mutate` endpoints with an `operations` array
- API version is in the URL path (currently v18)
- Supports `partial_failure` and `validate_only` flags on mutate operations
- Rate limits: 15,000 requests per day per developer token (basic access)
