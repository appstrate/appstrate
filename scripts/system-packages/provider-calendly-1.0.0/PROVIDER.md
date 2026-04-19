# Calendly API

Base URL: `https://api.calendly.com`

Scheduling platform API. Manage event types, retrieve scheduled events, invitees, and user availability. All resources use URI-based identifiers (full URLs as IDs).

## Endpoints

### Get Current User
`GET /users/me`

Returns the authenticated user's profile.

**Response:**
```json
{
  "resource": {
    "uri": "https://api.calendly.com/users/abc123-def456",
    "name": "John Doe",
    "email": "john@example.com",
    "scheduling_url": "https://calendly.com/johndoe",
    "timezone": "Europe/Paris",
    "avatar_url": "https://...",
    "current_organization": "https://api.calendly.com/organizations/org123"
  }
}
```

### List Event Types
`GET /event_types`

Returns all event types for a user or organization.

**Query parameters:**
- `user` — User URI (required unless `organization` is set)
- `organization` — Organization URI
- `active` — Filter by active status (`true` or `false`)
- `count` — Items per page (default 20, max 100)
- `page_token` — Token for next page
- `sort` — Sort field (e.g. `name:asc`)

**Response:**
```json
{
  "collection": [
    {
      "uri": "https://api.calendly.com/event_types/evt123",
      "name": "30 Minute Meeting",
      "active": true,
      "slug": "30min",
      "scheduling_url": "https://calendly.com/johndoe/30min",
      "duration": 30,
      "kind": "solo",
      "color": "#0069ff",
      "description_plain": "A quick 30-minute call"
    }
  ],
  "pagination": {
    "count": 20,
    "next_page": "https://api.calendly.com/event_types?page_token=abc123",
    "next_page_token": "abc123"
  }
}
```

### List Scheduled Events
`GET /scheduled_events`

Returns scheduled events for a user or organization.

**Query parameters:**
- `user` — User URI (required unless `organization` is set)
- `organization` — Organization URI
- `min_start_time` — Events starting after this time (ISO 8601)
- `max_start_time` — Events starting before this time
- `status` — Filter: `active`, `canceled`
- `count` — Items per page (default 20, max 100)
- `page_token` — Token for next page
- `sort` — `start_time:asc` or `start_time:desc`

**Response:**
```json
{
  "collection": [
    {
      "uri": "https://api.calendly.com/scheduled_events/sched123",
      "name": "30 Minute Meeting",
      "status": "active",
      "start_time": "2024-06-20T14:00:00.000000Z",
      "end_time": "2024-06-20T14:30:00.000000Z",
      "event_type": "https://api.calendly.com/event_types/evt123",
      "location": {
        "type": "google_conference",
        "join_url": "https://meet.google.com/abc-defg-hij"
      },
      "invitees_counter": { "total": 1, "active": 1, "limit": 1 },
      "created_at": "2024-06-18T10:00:00.000000Z",
      "updated_at": "2024-06-18T10:00:00.000000Z",
      "event_memberships": [
        { "user": "https://api.calendly.com/users/abc123-def456" }
      ]
    }
  ],
  "pagination": {
    "count": 20,
    "next_page": null,
    "next_page_token": null
  }
}
```

### Get Scheduled Event
`GET /scheduled_events/{eventUuid}`

Returns details for a specific scheduled event.

### List Event Invitees
`GET /scheduled_events/{eventUuid}/invitees`

Returns invitees for a scheduled event.

**Query parameters:**
- `count` — Items per page (default 20, max 100)
- `page_token` — Token for next page
- `status` — Filter: `active`, `canceled`
- `sort` — `created_at:asc` or `created_at:desc`

**Response:**
```json
{
  "collection": [
    {
      "uri": "https://api.calendly.com/invitees/inv123",
      "email": "alice@example.com",
      "name": "Alice Martin",
      "status": "active",
      "timezone": "Europe/Paris",
      "created_at": "2024-06-18T10:05:00.000000Z",
      "updated_at": "2024-06-18T10:05:00.000000Z",
      "questions_and_answers": [
        {
          "question": "What would you like to discuss?",
          "answer": "Product demo and pricing"
        }
      ],
      "tracking": { "utm_source": "website" },
      "cancel_url": "https://calendly.com/cancellations/inv123",
      "reschedule_url": "https://calendly.com/reschedulings/inv123"
    }
  ],
  "pagination": {
    "count": 20,
    "next_page": null,
    "next_page_token": null
  }
}
```

### Cancel Event
`POST /scheduled_events/{eventUuid}/cancellation`

Cancels a scheduled event.

**Request body (JSON):**
```json
{
  "reason": "Meeting no longer needed"
}
```

### List Organization Members
`GET /organization_memberships`

Returns members of an organization.

**Query parameters:**
- `organization` — Organization URI (required)
- `count` — Items per page (default 20, max 100)
- `page_token` — Token for next page

### Get User Availability
`GET /user_availability_schedules`

Returns availability schedules for a user.

**Query parameters:**
- `user` — User URI (required)

### Create Webhook Subscription
`POST /webhook_subscriptions`

Creates a webhook to receive event notifications.

**Request body (JSON):**
```json
{
  "url": "https://example.com/webhook",
  "events": ["invitee.created", "invitee.canceled"],
  "organization": "https://api.calendly.com/organizations/org123",
  "scope": "organization"
}
```

## Common Patterns

### Pagination
Cursor-based pagination:
- Response includes `pagination.next_page_token`
- Pass as `page_token` query parameter
- When `next_page_token` is `null`, no more pages
- `pagination.count` shows items in current page

### URI-Based Identifiers
All Calendly resources use full URIs as IDs:
- Users: `https://api.calendly.com/users/{uuid}`
- Events: `https://api.calendly.com/scheduled_events/{uuid}`
- Event types: `https://api.calendly.com/event_types/{uuid}`

When filtering by user or organization, pass the full URI.

### Error Format
```json
{
  "title": "Resource Not Found",
  "message": "The resource you are looking for does not exist.",
  "details": []
}
```

## Important Notes
- **No scopes** — Calendly OAuth grants full API access to the authenticated user's account.
- All resource identifiers are **full URIs** (not just UUIDs). Pass the complete URI in query parameters.
- The `user` query parameter is required on most list endpoints and must be the user's full URI.
- Access tokens expire after 2 hours, refresh tokens are long-lived.
- Rate limit: 40 requests per 20 seconds per user (pool-based, replenishes 2 per second).
- Webhook events: `invitee.created`, `invitee.canceled`, `routing_form_submission.created`.
- Location types: `physical`, `outbound_call`, `inbound_call`, `google_conference`, `zoom_conference`, `microsoft_teams_conference`, `custom`.
