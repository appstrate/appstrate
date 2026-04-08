# Twilio API

Base URL: `https://api.twilio.com/2010-04-01`

Cloud communications platform API. Send SMS/MMS, make phone calls, manage phone numbers, and verify users. Uses HTTP Basic Auth with Account SID as username and Auth Token as password. Request bodies use `application/x-www-form-urlencoded` (not JSON). Append `.json` to paths for JSON responses.

## Endpoints

### Get Account Info
`GET /Accounts/{AccountSid}.json`

Returns account details.

**Response:**
```json
{
  "sid": "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "friendly_name": "My Twilio Account",
  "status": "active",
  "type": "Full",
  "date_created": "Mon, 15 Jan 2024 10:00:00 +0000",
  "date_updated": "Sat, 15 Jun 2024 10:30:00 +0000"
}
```

### Send SMS
`POST /Accounts/{AccountSid}/Messages.json`

Sends an SMS or MMS message. **Request body is form-encoded, not JSON.**

**Request body (form-encoded):**
- `To` — Recipient phone number (E.164 format, e.g. `+33612345678`)
- `From` — Sender phone number (your Twilio number, E.164)
- `Body` — Message text (max 1600 characters)
- `MediaUrl` — URL of media to attach (MMS, up to 10 URLs)
- `StatusCallback` — Webhook URL for delivery status updates

**Response:**
```json
{
  "sid": "SM1234567890abcdef1234567890abcdef",
  "date_created": "Sat, 15 Jun 2024 10:30:00 +0000",
  "date_sent": null,
  "account_sid": "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "to": "+33612345678",
  "from": "+15551234567",
  "body": "Hello from Twilio!",
  "status": "queued",
  "direction": "outbound-api",
  "price": null,
  "num_segments": "1",
  "error_code": null,
  "error_message": null,
  "uri": "/2010-04-01/Accounts/ACXX.../Messages/SM123....json"
}
```

### List Messages
`GET /Accounts/{AccountSid}/Messages.json`

Returns sent and received messages.

**Query parameters:**
- `To` — Filter by recipient number
- `From` — Filter by sender number
- `DateSent>` — Messages sent after date (YYYY-MM-DD)
- `DateSent<` — Messages sent before date
- `PageSize` — Items per page (default 50, max 1000)
- `PageToken` — Token for next page

**Response:**
```json
{
  "messages": [
    {
      "sid": "SM1234567890abcdef1234567890abcdef",
      "to": "+33612345678",
      "from": "+15551234567",
      "body": "Hello from Twilio!",
      "status": "delivered",
      "date_sent": "Sat, 15 Jun 2024 10:30:05 +0000",
      "direction": "outbound-api",
      "price": "-0.0075",
      "price_unit": "USD",
      "num_segments": "1"
    }
  ],
  "first_page_uri": "/2010-04-01/Accounts/ACXX.../Messages.json?PageSize=50&Page=0",
  "next_page_uri": "/2010-04-01/Accounts/ACXX.../Messages.json?PageSize=50&Page=1&PageToken=PA...",
  "page": 0,
  "page_size": 50
}
```

### Get Message
`GET /Accounts/{AccountSid}/Messages/{MessageSid}.json`

Returns details for a specific message.

### Make Call
`POST /Accounts/{AccountSid}/Calls.json`

Initiates a phone call. **Request body is form-encoded.**

**Request body (form-encoded):**
- `To` — Recipient phone number (E.164)
- `From` — Caller ID (your Twilio number, E.164)
- `Url` — TwiML URL for call instructions
- `Twiml` — Inline TwiML XML (alternative to Url)
- `StatusCallback` — Webhook URL for call status updates
- `Record` — Record the call (`true`/`false`)
- `Timeout` — Ring timeout in seconds (default 60)

**Response:**
```json
{
  "sid": "CA1234567890abcdef1234567890abcdef",
  "to": "+33612345678",
  "from": "+15551234567",
  "status": "queued",
  "start_time": null,
  "end_time": null,
  "duration": null,
  "direction": "outbound-api",
  "price": null,
  "uri": "/2010-04-01/Accounts/ACXX.../Calls/CA123....json"
}
```

### List Calls
`GET /Accounts/{AccountSid}/Calls.json`

Returns call logs.

**Query parameters:**
- `To` — Filter by recipient
- `From` — Filter by caller
- `Status` — Filter: `queued`, `ringing`, `in-progress`, `completed`, `busy`, `failed`, `no-answer`, `canceled`
- `StartTime>` — Calls after date
- `StartTime<` — Calls before date
- `PageSize` — Items per page
- `PageToken` — Token for next page

### Get Call
`GET /Accounts/{AccountSid}/Calls/{CallSid}.json`

Returns details for a specific call.

### List Phone Numbers
`GET /Accounts/{AccountSid}/IncomingPhoneNumbers.json`

Returns the account's phone numbers.

**Response:**
```json
{
  "incoming_phone_numbers": [
    {
      "sid": "PN1234567890abcdef",
      "phone_number": "+15551234567",
      "friendly_name": "Main Line",
      "capabilities": {
        "voice": true,
        "sms": true,
        "mms": true
      },
      "status": "in-use",
      "date_created": "Mon, 15 Jan 2024 10:00:00 +0000"
    }
  ]
}
```

### Lookup Phone Number
`GET https://lookups.twilio.com/v2/PhoneNumbers/{PhoneNumber}`

Looks up info about a phone number. Uses separate domain `lookups.twilio.com`.

**Query parameters:**
- `Fields` — Info to return: `line_type_intelligence`, `caller_name`, `sms_pumping_risk`

**Response:**
```json
{
  "phone_number": "+33612345678",
  "country_code": "FR",
  "national_format": "06 12 34 56 78",
  "valid": true,
  "calling_country_code": "33",
  "line_type_intelligence": {
    "type": "mobile",
    "carrier_name": "Orange SA"
  }
}
```

### Send Verification Token
`POST https://verify.twilio.com/v2/Services/{ServiceSid}/Verifications`

Sends a verification code via SMS or email. Uses separate domain `verify.twilio.com`.

**Request body (form-encoded):**
- `To` — Phone number or email
- `Channel` — Delivery channel: `sms`, `call`, `email`

### Check Verification Token
`POST https://verify.twilio.com/v2/Services/{ServiceSid}/VerificationCheck`

Verifies a code submitted by the user.

**Request body (form-encoded):**
- `To` — Phone number or email
- `Code` — Verification code entered by user

## Common Patterns

### Pagination
URI-based pagination:
- Response includes `next_page_uri`
- Follow the URI directly (prepend `https://api.twilio.com`)
- When `next_page_uri` is `null`, no more pages
- Use `PageSize` to control items per page

### Phone Number Format
All phone numbers must use E.164 format:
- `+` prefix + country code + number
- Examples: `+33612345678` (France), `+15551234567` (US)

### Error Format
```json
{
  "code": 21211,
  "message": "The 'To' number +1234 is not a valid phone number.",
  "more_info": "https://www.twilio.com/docs/errors/21211",
  "status": 400
}
```

## Important Notes
- Uses **HTTP Basic Auth**: Account SID as username, Auth Token as password (base64-encoded).
- **Request bodies are form-encoded** (`application/x-www-form-urlencoded`), NOT JSON. This is critical.
- Always append `.json` to endpoint paths to get JSON responses (otherwise returns XML).
- Message SIDs start with `SM`, Call SIDs with `CA`, Account SIDs with `AC`.
- Phone numbers must be in E.164 format (`+` prefix + country code + number).
- Twilio has multiple subdomains: `api.twilio.com` (core), `lookups.twilio.com` (phone lookup), `verify.twilio.com` (verification).
- SMS price varies by country (typically $0.0075-$0.05 per segment).
- Rate limits vary by endpoint and account type. SMS: ~1 message/second per number (10DLC throughput varies).
- Message statuses: `queued` → `sending` → `sent` → `delivered` (or `failed`/`undelivered`).
