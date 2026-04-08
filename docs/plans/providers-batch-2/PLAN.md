# Provider Batch 2 — Implementation Plan

**Branch**: `feat/misc-providers-batch`
**Total**: 27 providers
**Base branch**: `feat/pm-crm-providers`

---

## Summary by Auth Mode

### OAuth2 — Google Pattern (5 providers)
Same OAuth2 config: `accounts.google.com`, `oauth2.googleapis.com`, `pkceEnabled: false`, `client_secret_post`, `access_type: "offline"`, `prompt: "consent"`.

| # | Provider | Slug | API Base URL |
|---|----------|------|-------------|
| 1 | Google Calendar | `google-calendar` | `googleapis.com/calendar/v3` |
| 2 | Google Forms | `google-forms` | `forms.googleapis.com/v1` |
| 3 | Google Contacts | `google-contacts` | `people.googleapis.com/v1` |
| 4 | Google Ads | `google-ads` | `googleads.googleapis.com/v17` |
| 5 | — | — | (Google Ads also needs `developer-token` header) |

### OAuth2 — Microsoft Graph Pattern (3 providers)
Same OAuth2 config: `login.microsoftonline.com/common`, `pkceEnabled: true`, `client_secret_post`.

| # | Provider | Slug | Graph API Scope Prefix |
|---|----------|------|-----------------------|
| 5 | Microsoft Outlook | `microsoft-outlook` | `Mail.*`, `User.Read` |
| 6 | Microsoft Teams | `microsoft-teams` | `Team.*`, `Channel.*`, `Chat.*` |
| 7 | OneDrive | `onedrive` | `Files.*` |

### OAuth2 — Standard (10 providers)
Each has unique OAuth endpoints but follows standard authorization code flow.

| # | Provider | Slug | Token Auth | PKCE | Refresh | Notes |
|---|----------|------|-----------|------|---------|-------|
| 8 | Mailchimp | `mailchimp` | `client_secret_post` | ❌ | ❌ (permanent tokens) | No scopes |
| 9 | Typeform | `typeform` | `client_secret_post` | ❌ | ✅ | `offline:access` scope for refresh |
| 10 | Calendly | `calendly` | `client_secret_post` | ✅ | ✅ | |
| 11 | Zoom | `zoom` | `client_secret_basic` | ✅ | ✅ | Granular scopes |
| 12 | Dropbox | `dropbox` | `client_secret_post` | ✅ | ✅ | `token_access_type: "offline"` param |
| 13 | Intercom | `intercom` | `client_secret_post` | ❌ | ❌ (permanent tokens) | No scopes |
| 14 | Xero | `xero` | `client_secret_basic` | ✅ | ✅ | Multi-tenant, needs `xero-tenant-id` |
| 15 | QuickBooks Online | `quickbooks-online` | `client_secret_basic` | ❌ | ✅ | Needs company/realm ID |
| 16 | PayPal | `paypal` | `client_secret_basic` | ❌ | ✅ | URI-based scopes |
| 17 | Canva | `canva` | `client_secret_basic` | ✅ | ✅ | |
| 18 | ConvertKit (Kit) | `convertkit` | `client_secret_post` | ✅ | ✅ | No scopes, rebranded to Kit |

### API Key (9 providers)

| # | Provider | Slug | Auth Method | Notes |
|---|----------|------|------------|-------|
| 19 | Shopify | `shopify` | `X-Shopify-Access-Token` header | Shop-specific URLs, Custom App token |
| 20 | ActiveCampaign | `activecampaign` | `Api-Token` header | Account-specific base URL |
| 21 | WordPress | `wordpress` | HTTP Basic Auth | Application Passwords, `allowAllUris` |
| 22 | WooCommerce | `woocommerce` | HTTP Basic Auth | Consumer Key/Secret, `allowAllUris` |
| 23 | Telegram | `telegram` | Token in URL path | `bot{token}/method` pattern |
| 24 | Twilio | `twilio` | HTTP Basic Auth | Account SID + Auth Token |
| 25 | Webhooks | `webhooks` | Custom header (optional) | Generic provider, `allowAllUris` |
| 26 | Loom | `loom` | `Authorization: Bearer` | Very limited API surface |
| 27 | Fathom | `fathom` | `Authorization: Bearer` | Meeting transcripts/summaries |

---

## Implementation Order

### Phase 1 — Google Pattern (batch, high reuse)
Fastest to implement — copy Gmail/YouTube pattern, only change scopes and authorized URIs.
1. `google-calendar`
2. `google-forms`
3. `google-contacts`

### Phase 2 — Microsoft Graph Pattern (batch, high reuse)
Copy pattern, only change scopes.
4. `microsoft-outlook`
5. `microsoft-teams`
6. `onedrive`

### Phase 3 — Standard OAuth2 (no quirks)
Each has unique OAuth endpoints but standard flow, no special behavior.
7. `mailchimp` — permanent tokens, no refresh needed
8. `typeform`
9. `calendly`
10. `zoom`
11. `dropbox`
12. `intercom` — permanent tokens, no refresh needed
13. `paypal`
14. `canva`
15. `convertkit`

### Phase 4 — Simple API Key Providers
Straightforward API key auth with standard Bearer header.
16. `fathom`
17. `twilio`

### Phase 5 — Edge Cases ⚠️
Providers with non-standard patterns, extra credentials, variable URLs, or limited APIs. Each needs extra care.
18. `google-ads` — ⚠️ needs extra `developer-token` header on all requests
19. `xero` — ⚠️ multi-tenant, needs `xero-tenant-id` header after `/connections` call
20. `quickbooks-online` — ⚠️ company/realm ID from OAuth callback, used in all API paths
21. `shopify` — ⚠️ shop-specific URLs → API key mode with Custom App token
22. `activecampaign` — ⚠️ custom `Api-Token` header, account-specific base URL
23. `wordpress` — ⚠️ `allowAllUris`, variable site URLs, Application Passwords (Basic Auth)
24. `woocommerce` — ⚠️ `allowAllUris`, variable site URLs, Consumer Key/Secret (Basic Auth)
25. `telegram` — ⚠️ token embedded in URL path (`/bot{token}/method`)
26. `webhooks` — ⚠️ generic provider, `allowAllUris`, not a traditional API
27. `loom` — ⚠️ very limited REST API surface, mostly SDK-based platform

---

## Execution Checklist per Provider

For each provider:
- [ ] Create `scripts/system-packages/provider-{slug}-1.0.0/manifest.json`
- [ ] Create `scripts/system-packages/provider-{slug}-1.0.0/PROVIDER.md`
- [ ] Validate with `bun scripts/build-system-packages.ts --check`
- [ ] `git add` + `git commit --no-verify -m "feat: add {Display Name} provider"`

---

## Known Issues / Decisions Needed

### ⚠️ Shopify — Shop-Specific OAuth URLs
Shopify OAuth URLs contain `{shop}` subdomain. Using **API key mode** instead (Custom App access tokens). This is the recommended approach for Appstrate since the OAuth flow expects static URLs.

### ⚠️ Google Ads — Developer Token
Requires a `developer-token` header on all API requests, separate from OAuth. Documented in PROVIDER.md Important Notes. The agent must include this header.

### ⚠️ WordPress/WooCommerce — Variable Base URLs
Site URLs are user-specific. Using `allowAllUris: true` and requiring `site_url` in credentials.

### ⚠️ Telegram — Token in URL
Bot token is embedded in URL path, not in a header. Using `allowAllUris: true` and documenting the URL construction pattern.

### ⚠️ Loom — Very Limited API
Loom has no comprehensive REST API. Provider will be minimal, primarily oEmbed-based. Consider deferring if ROI is too low.

### ⚠️ Webhooks — Generic Provider
Not a traditional API provider. Allows sending data to arbitrary webhook URLs. Needs `allowAllUris: true`.

### ⚠️ ActiveCampaign — Custom Header
Uses `Api-Token` header (NOT `Authorization: Bearer`). Requires custom `credentialHeaderName`.

### ⚠️ Xero — Multi-Tenant
After OAuth, must call `/connections` to get tenant IDs. All API calls need `xero-tenant-id` header. Documented in PROVIDER.md.

### ⚠️ QuickBooks — Company ID
The realm/company ID is returned during OAuth callback. Must be stored and used in all API paths.

---

## Estimated Effort

| Phase | Providers | Est. Time | Notes |
|-------|-----------|-----------|-------|
| Phase 1 (Google) | 3 | 40min | High reuse from existing Google providers |
| Phase 2 (Microsoft) | 3 | 45min | High reuse within batch |
| Phase 3 (OAuth2, standard) | 9 | 3h | Individual endpoint research |
| Phase 4 (API Key, simple) | 2 | 30min | Straightforward Bearer auth |
| Phase 5 (Edge cases) | 10 | 4h | Extra research, non-standard patterns |
| **Total** | **27** | **~9h** | |
