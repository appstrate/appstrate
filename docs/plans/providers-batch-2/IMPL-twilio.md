# IMPL: Twilio Provider

## Provider Info
- **Slug**: `twilio`
- **Display Name**: Twilio
- **Auth Mode**: API Key (Account SID + Auth Token)
- **Base URL**: `https://api.twilio.com/2010-04-01`
- **Docs**: https://www.twilio.com/docs/usage/api

## Auth Details
- **Auth Mode**: `api_key`
- **Credential Schema**:
  - `account_sid` (string) — Twilio Account SID (starts with `AC`)
  - `auth_token` (string) — Twilio Auth Token
- **Header**: `Authorization: Basic base64(account_sid:auth_token)`

## Authorized URIs
- `https://api.twilio.com/*`
- `https://lookups.twilio.com/*`
- `https://verify.twilio.com/*`

## Setup Guide
1. Sign up for Twilio → https://www.twilio.com/try-twilio
2. Go to Console Dashboard to find Account SID and Auth Token
3. Copy both credentials

## Key Endpoints to Document
1. GET /2010-04-01/Accounts/{AccountSid}.json — Get account info
2. POST /2010-04-01/Accounts/{AccountSid}/Messages.json — Send SMS/MMS
3. GET /2010-04-01/Accounts/{AccountSid}/Messages.json — List messages
4. GET /2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json — Get message
5. POST /2010-04-01/Accounts/{AccountSid}/Calls.json — Make call
6. GET /2010-04-01/Accounts/{AccountSid}/Calls.json — List calls
7. GET /2010-04-01/Accounts/{AccountSid}/Calls/{Sid}.json — Get call
8. GET /2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json — List phone numbers
9. POST /2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json — Buy phone number
10. GET /v2/Services — List Verify services (verify.twilio.com)

## Compatibility Notes
- Uses HTTP Basic Auth with Account SID as username and Auth Token as password
- Request bodies use `application/x-www-form-urlencoded` (NOT JSON)
- Responses are JSON (add `.json` to endpoint paths)
- Pagination uses `PageSize`, `Page`, `PageToken` parameters
- Phone numbers in E.164 format (+1234567890)
- Rate limits vary by endpoint and account type
- Twilio has multiple subdomains for different products (api, lookups, verify, etc.)
