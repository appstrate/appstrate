# Fathom API

Base URL: `https://api.fathom.video/v1`

AI-powered meeting recorder API. Retrieve meeting recordings, transcripts, summaries, and action items from calls recorded with Fathom. API keys are user-scoped — you can only access meetings you recorded or that were shared with your Team.

## Endpoints

### List Calls
`GET /calls`

Returns recent meetings/calls recorded by the authenticated user.

**Query parameters:**
- `from` — Start date (ISO 8601, e.g. `2024-06-01T00:00:00Z`)
- `to` — End date (ISO 8601)
- `attendee_email` — Filter calls by attendee email
- `next_cursor` — Cursor for next page
- `limit` — Items per page (default 20, max 100)

**Response:**
```json
{
  "calls": [
    {
      "id": "call_abc123def456",
      "title": "Weekly Team Standup",
      "start_time": "2024-06-15T09:00:00Z",
      "end_time": "2024-06-15T09:28:00Z",
      "duration_seconds": 1680,
      "meeting_url": "https://zoom.us/j/1234567890",
      "attendees": [
        {
          "name": "John Doe",
          "email": "john@example.com",
          "is_organizer": true
        },
        {
          "name": "Alice Martin",
          "email": "alice@example.com",
          "is_organizer": false
        }
      ],
      "summary": "Discussed sprint progress and upcoming release timeline...",
      "created_at": "2024-06-15T09:30:00Z"
    }
  ],
  "next_cursor": "eyJpZCI6ImNhbGxf...",
  "has_more": true
}
```

### Get Call
`GET /calls/{callId}`

Returns full details for a specific call, including transcript, summary, and action items.

**Response:**
```json
{
  "id": "call_abc123def456",
  "title": "Weekly Team Standup",
  "start_time": "2024-06-15T09:00:00Z",
  "end_time": "2024-06-15T09:28:00Z",
  "duration_seconds": 1680,
  "meeting_url": "https://zoom.us/j/1234567890",
  "attendees": [
    {
      "name": "John Doe",
      "email": "john@example.com",
      "is_organizer": true
    },
    {
      "name": "Alice Martin",
      "email": "alice@example.com",
      "is_organizer": false
    }
  ],
  "transcript": [
    {
      "speaker": "John Doe",
      "text": "Good morning everyone. Let's start with the sprint update.",
      "start_time": 0.0,
      "end_time": 4.2
    },
    {
      "speaker": "Alice Martin",
      "text": "Sure. We completed the authentication module yesterday.",
      "start_time": 4.5,
      "end_time": 8.1
    }
  ],
  "summary": "The team discussed sprint progress. The authentication module is complete. The release is planned for Friday. Alice will prepare the deployment checklist.",
  "action_items": [
    {
      "text": "Prepare the deployment checklist",
      "assignee": "Alice Martin",
      "assignee_email": "alice@example.com"
    },
    {
      "text": "Review PR #234 before Thursday",
      "assignee": "John Doe",
      "assignee_email": "john@example.com"
    }
  ],
  "topics": [
    "Sprint progress update",
    "Release planning",
    "Deployment preparation"
  ],
  "recording_url": "https://fathom.video/recordings/call_abc123def456",
  "crm_matches": [
    {
      "provider": "hubspot",
      "contact_name": "Alice Martin",
      "contact_email": "alice@example.com"
    }
  ],
  "created_at": "2024-06-15T09:30:00Z"
}
```

### List Calls by Attendee
`GET /calls?attendee_email={email}`

Filters calls to those where a specific attendee was present.

### List Calls by Date Range
`GET /calls?from={startDate}&to={endDate}`

Filters calls by date range.

### Create Webhook
`POST /webhooks`

Creates a webhook subscription to receive notifications when new meetings are processed.

**Request body (JSON):**
```json
{
  "url": "https://example.com/fathom-webhook",
  "events": ["call.processed"]
}
```

**Response:**
```json
{
  "id": "webhook_abc123",
  "url": "https://example.com/fathom-webhook",
  "events": ["call.processed"],
  "created_at": "2024-06-15T10:00:00Z"
}
```

### List Webhooks
`GET /webhooks`

Returns all webhook subscriptions.

**Response:**
```json
{
  "webhooks": [
    {
      "id": "webhook_abc123",
      "url": "https://example.com/fathom-webhook",
      "events": ["call.processed"],
      "created_at": "2024-06-15T10:00:00Z"
    }
  ]
}
```

### Delete Webhook
`DELETE /webhooks/{webhookId}`

Deletes a webhook subscription.

## Common Patterns

### Pagination
Cursor-based pagination:
- Response includes `next_cursor` and `has_more`
- Pass `next_cursor` as query parameter for the next page
- When `has_more` is `false`, no more pages
- Use `limit` to control page size

### Error Format
```json
{
  "error": {
    "code": "not_found",
    "message": "Call not found"
  }
}
```

## Important Notes
- API keys are **user-scoped**: you can only access meetings you recorded or that were shared with your Team.
- Admin API keys do NOT grant access to other users' unshared meetings.
- Rate limit: 60 requests per minute per user (across all API keys).
- Rate limit headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`.
- Call objects include: title, transcript, summary, action items, CRM matches, attendees, and topics.
- Transcripts are speaker-diarized with start/end timestamps in seconds.
- Webhook event `call.processed` fires when a new meeting recording is transcribed and summarized.
- Meeting processing typically takes 1-5 minutes after the call ends.
- The `recording_url` provides a link to the Fathom web player for the full recording.
