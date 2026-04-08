# Fathom API

Base URL: `https://api.fathom.ai/external/v1`

Fathom's external API lets you retrieve meetings, transcripts, summaries, teams, and team members, and configure webhooks for new meeting content. Authentication is primarily done with the `X-Api-Key` header. API keys are user-scoped: they can access meetings recorded by you, or meetings shared to your Team.

## Endpoints

### List Meetings
`GET /meetings`

Returns a paginated list of meetings available to the authenticated user.

**Query parameters:**
- `cursor` — Cursor for pagination
- `created_after` — Only meetings created after this ISO 8601 timestamp
- `created_before` — Only meetings created before this ISO 8601 timestamp
- `recorded_by[]` — Filter by one or more recorder email addresses
- `teams[]` — Filter by one or more team names
- `calendar_invitees_domains[]` — Filter by one or more invitee company domains
- `calendar_invitees_domains_type` — `all`, `only_internal`, or `one_or_more_external`
- `include_transcript` — Include transcript in each meeting (`true`/`false`)
- `include_summary` — Include summary in each meeting (`true`/`false`)
- `include_action_items` — Include action items in each meeting (`true`/`false`)
- `include_crm_matches` — Include CRM matches in each meeting (`true`/`false`)

**Response:**
```json
{
  "items": [
    {
      "title": "Quarterly Business Review",
      "meeting_title": "QBR 2025 Q1",
      "recording_id": 123456789,
      "url": "https://fathom.video/xyz123",
      "share_url": "https://fathom.video/share/xyz123",
      "created_at": "2025-03-01T17:01:30Z",
      "scheduled_start_time": "2025-03-01T16:00:00Z",
      "scheduled_end_time": "2025-03-01T17:00:00Z",
      "recording_start_time": "2025-03-01T16:01:12Z",
      "recording_end_time": "2025-03-01T17:00:55Z",
      "calendar_invitees_domains_type": "one_or_more_external",
      "transcript_language": "en",
      "calendar_invitees": [
        {
          "name": "Alice Johnson",
          "matched_speaker_display_name": "Alice Johnson",
          "email": "alice.johnson@acme.com",
          "email_domain": "acme.com",
          "is_external": false
        }
      ],
      "recorded_by": {
        "name": "Alice Johnson",
        "email": "alice.johnson@acme.com",
        "email_domain": "acme.com",
        "team": "Marketing"
      },
      "transcript": [
        {
          "speaker": {
            "display_name": "Alice Johnson",
            "matched_calendar_invitee_email": "alice.johnson@acme.com"
          },
          "text": "Let's revisit the budget allocations.",
          "timestamp": "00:05:32"
        }
      ],
      "default_summary": {
        "template_name": "general",
        "markdown_formatted": "## Summary\nWe reviewed Q1 OKRs and identified budget risks."
      },
      "action_items": [
        {
          "description": "Email revised proposal to client",
          "user_generated": false,
          "completed": false,
          "recording_timestamp": "00:10:45",
          "recording_playback_url": "https://fathom.video/xyz123#t=645",
          "assignee": {
            "name": "Alice Johnson",
            "email": "alice.johnson@acme.com",
            "team": "Marketing"
          }
        }
      ],
      "crm_matches": {
        "contacts": [
          {
            "name": "Jane Smith",
            "email": "jane.smith@client.com",
            "record_url": "https://app.hubspot.com/contacts/123"
          }
        ],
        "companies": [
          {
            "name": "Acme Corp",
            "record_url": "https://app.hubspot.com/companies/456"
          }
        ],
        "deals": [
          {
            "name": "Q1 Renewal",
            "amount": 50000,
            "record_url": "https://app.hubspot.com/deals/789"
          }
        ],
        "error": null
      }
    }
  ],
  "limit": 1,
  "next_cursor": "eyJwYWdlX251bSI6Mn0="
}
```

### Get Transcript
`GET /recordings/{recording_id}/transcript`

Returns the transcript for a recording, or forwards it asynchronously if `destination_url` is provided.

**Query parameters:**
- `destination_url` — Optional callback URL. If provided, Fathom posts the transcript there instead of returning it directly.

**Response (direct):**
```json
{
  "transcript": [
    {
      "speaker": {
        "display_name": "Alice Johnson",
        "matched_calendar_invitee_email": "alice.johnson@acme.com"
      },
      "text": "Let's revisit the budget allocations.",
      "timestamp": "00:05:32"
    },
    {
      "speaker": {
        "display_name": "Bob Lee",
        "matched_calendar_invitee_email": "bob.lee@acme.com"
      },
      "text": "I can send the revised numbers by Friday.",
      "timestamp": "00:06:04"
    }
  ]
}
```

**Response (async callback mode):**
```json
{
  "destination_url": "https://example.com/destination"
}
```

### Get Summary
`GET /recordings/{recording_id}/summary`

Returns the summary for a recording, or forwards it asynchronously if `destination_url` is provided.

**Query parameters:**
- `destination_url` — Optional callback URL. If provided, Fathom posts the summary there instead of returning it directly.

**Response (direct):**
```json
{
  "summary": {
    "template_name": "general",
    "markdown_formatted": "## Summary\nWe reviewed Q1 OKRs, identified budget risks, and agreed to revisit projections next month."
  }
}
```

**Response (async callback mode):**
```json
{
  "destination_url": "https://example.com/destination"
}
```

### List Teams
`GET /teams`

Returns a paginated list of teams available to the authenticated user.

**Query parameters:**
- `cursor` — Cursor for pagination

**Response:**
```json
{
  "limit": 50,
  "next_cursor": null,
  "items": [
    {
      "name": "Sales",
      "created_at": "2023-11-10T12:00:00Z"
    },
    {
      "name": "Marketing",
      "created_at": "2024-01-05T09:30:00Z"
    }
  ]
}
```

### List Team Members
`GET /team_members`

Returns a paginated list of team members.

**Query parameters:**
- `cursor` — Cursor for pagination
- `team` — Filter by team name

**Response:**
```json
{
  "limit": 50,
  "next_cursor": "eyJwYWdlX251bSI6Mn0=",
  "items": [
    {
      "name": "Bob Lee",
      "email": "bob.lee@acme.com",
      "created_at": "2024-06-01T08:30:00Z"
    },
    {
      "name": "Alice Johnson",
      "email": "alice.johnson@acme.com",
      "created_at": "2024-05-15T10:00:00Z"
    }
  ]
}
```

### Create Webhook
`POST /webhooks`

Creates a webhook to receive new meeting content.

At least one of `include_transcript`, `include_crm_matches`, `include_summary`, or `include_action_items` must be `true`.

**Request body (JSON):**
```json
{
  "destination_url": "https://example.com/webhook",
  "include_transcript": true,
  "include_crm_matches": false,
  "include_summary": true,
  "include_action_items": true,
  "triggered_for": [
    "my_recordings",
    "my_shared_with_team_recordings"
  ]
}
```

**Response:**
```json
{
  "id": "ikEoQ4bVoq4JYUmc",
  "url": "https://example.com/webhook",
  "secret": "whsec_x6EV6NIAAz3ldclszNJTwrow",
  "created_at": "2025-06-30T10:40:46Z",
  "include_transcript": true,
  "include_crm_matches": false,
  "include_summary": true,
  "include_action_items": true,
  "triggered_for": [
    "my_recordings",
    "my_shared_with_team_recordings"
  ]
}
```

### Delete Webhook
`DELETE /webhooks/{id}`

Deletes a webhook.

## Common Patterns

### Pagination
Cursor-based pagination:
- Responses include `next_cursor`
- Pass `cursor={next_cursor}` on the next request
- When `next_cursor` is `null`, there are no more pages
- Responses also include `limit`

### Meeting Content Inclusion
`GET /meetings` can inline additional content using boolean query params:
- `include_transcript=true`
- `include_summary=true`
- `include_action_items=true`
- `include_crm_matches=true`

For OAuth-connected apps, Fathom documents that transcript and summary should be fetched through the `/recordings/{recording_id}/...` endpoints instead of inline meeting expansion.

### Webhook Trigger Types
Valid `triggered_for` values:
- `my_recordings`
- `shared_external_recordings`
- `my_shared_with_team_recordings`
- `shared_team_recordings`

### Error Format
```json
{
  "error": {
    "message": "Unauthorized"
  }
}
```

## Important Notes
- Authentication is primarily documented via `X-Api-Key: {api_key}`.
- API keys are **user-scoped**: they can only access meetings recorded by you, or meetings shared to your Team.
- Admin API keys do **not** grant access to other users' private, unshared meetings.
- Official base URL is `https://api.fathom.ai/external/v1`.
- `recording_id` is an integer and is used for transcript and summary endpoints.
- Transcript timestamps are relative timestamps in `HH:MM:SS` format, not absolute datetimes.
- Summary responses return `markdown_formatted`, which is always in English.
- Action items include playback metadata: `recording_timestamp` and `recording_playback_url`.
- Rate limit: 60 requests per 60-second window.
- Rate limit headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`.
- When rate-limited, the API returns HTTP `429`.
