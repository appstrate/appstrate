# API Client Example

Demonstrates how to interact with the Appstrate API programmatically using API keys.

## Prerequisites

1. A running Appstrate instance (see [self-hosting example](../self-hosting/))
2. An account with at least one configured agent
3. An API key created from the dashboard (Settings > API Keys)

API keys use the `ask_` prefix and are sent via the `Authorization: Bearer` header.

## Create an API Key

From the dashboard, navigate to **Settings > API Keys** and create a new key. Copy the key -- it is only shown once.

## Run an Agent

### With curl

```bash
# Set your variables
APPSTRATE_URL="http://localhost:3000"
API_KEY="ask_your_api_key_here"
ORG_ID="your_org_id"
AGENT_ID="your_agent_id"

# Trigger an agent run
curl -X POST "$APPSTRATE_URL/api/agents/$AGENT_ID/run" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Org-Id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{"input": {"message": "Hello from the API"}}'
```

The response is a Server-Sent Events (SSE) stream. Each event contains run logs in real time.

### With curl (SSE stream)

```bash
# Stream run logs in real time
curl -N -X POST "$APPSTRATE_URL/api/agents/$AGENT_ID/run" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Org-Id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{"input": {"message": "Hello from the API"}}'
```

The `-N` flag disables buffering so you see events as they arrive.

## Poll for Results

If you prefer polling over SSE, you can check the run status:

```bash
RUN_ID="run_id_from_run_response"

# Get run status and result
curl "$APPSTRATE_URL/api/runs/$RUN_ID" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Org-Id: $ORG_ID"
```

Possible status values: `pending`, `running`, `success`, `failed`, `timeout`, `cancelled`.

## JavaScript / fetch Example

```javascript
const APPSTRATE_URL = "http://localhost:3000";
const API_KEY = "ask_your_api_key_here";
const ORG_ID = "your_org_id";
const AGENT_ID = "your_agent_id";

// Run an agent and read the SSE stream
async function runAgent(input) {
  const response = await fetch(`${APPSTRATE_URL}/api/agents/${AGENT_ID}/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "X-Org-Id": ORG_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`API error: ${error.title} - ${error.detail}`);
  }

  // Read SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    // SSE events are separated by double newlines
    const events = text.split("\n\n").filter(Boolean);

    for (const event of events) {
      const dataLine = event.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) {
        const data = JSON.parse(dataLine.slice(6));
        console.log(`[${data.type}]`, data);
      }
    }
  }
}

// Poll run status
async function getRun(runId) {
  const response = await fetch(`${APPSTRATE_URL}/api/runs/${runId}`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "X-Org-Id": ORG_ID,
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`API error: ${error.title} - ${error.detail}`);
  }

  return response.json();
}

// Usage
runAgent({ message: "Hello from JavaScript" }).catch(console.error);
```

## End-User Impersonation

When building applications on top of Appstrate, use the `Appstrate-User` header to associate runs with your end-users:

```bash
curl -X POST "$APPSTRATE_URL/api/agents/$AGENT_ID/run" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Org-Id: $ORG_ID" \
  -H "Appstrate-User: eu_your_end_user_id" \
  -H "Content-Type: application/json" \
  -d '{"input": {"message": "Hello"}}'
```

This header is only available with API key authentication (not cookie sessions). The end-user must belong to the API key's application.

## Error Format

All errors follow [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) (`application/problem+json`):

```json
{
  "type": "https://appstrate.com/problems/not-found",
  "title": "Not Found",
  "status": 404,
  "detail": "Agent not found"
}
```

## Further Reading

- Interactive API docs: `GET /api/docs` (Swagger UI)
- Raw OpenAPI spec: `GET /api/openapi.json`
