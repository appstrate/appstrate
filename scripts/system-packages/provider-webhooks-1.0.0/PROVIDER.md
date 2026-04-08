# Webhooks Provider

This is a **generic webhook provider** for sending HTTP requests to arbitrary URLs. Unlike other providers that connect to a specific API, this provider enables integration with any service that accepts HTTP webhooks.

## Credentials

- `{{webhook_url}}` — The target URL to send requests to
- `{{secret_header_name}}` — Optional custom header name for authentication
- `{{secret_header_value}}` — Optional secret value for the auth header

The sidecar substitutes these placeholders automatically.

## Usage

### Send a JSON Payload

```
POST {{webhook_url}}
Content-Type: application/json

{
  "event": "order.created",
  "data": {
    "id": "123",
    "total": 99.99
  }
}
```

If authentication is configured, include the secret header:

```
{{secret_header_name}}: {{secret_header_value}}
```

### Common Webhook Patterns

**Zapier Webhook**

```
POST {{webhook_url}}
Content-Type: application/json

{ "key": "value" }
```

**Make (Integromat) Webhook**

```
POST {{webhook_url}}
Content-Type: application/json

{ "data": { ... } }
```

**Slack Incoming Webhook**

```
POST {{webhook_url}}
Content-Type: application/json

{
  "text": "Hello from Appstrate!",
  "channel": "#general"
}
```

**Discord Webhook**

```
POST {{webhook_url}}
Content-Type: application/json

{
  "content": "Hello from Appstrate!",
  "username": "Bot Name"
}
```

## Notes

- `allowAllUris` is enabled — webhooks can target any URL
- Default to `POST` with `Content-Type: application/json`
- For HMAC-signed webhooks, the agent must compute the signature and include it as a header
- No rate limits imposed by Appstrate — respect the target service's limits
- Retry failed deliveries by re-sending the request
- This provider is useful for services without a dedicated Appstrate provider (Zapier, Make, n8n, custom APIs)
