# Google Calendar API

Base URL: `https://www.googleapis.com/calendar/v3`

Calendar and scheduling service by Google. Create, read, update, and delete events, manage calendars, and check free/busy availability. All endpoints require OAuth2 Bearer token authentication.

## Endpoints

### List Calendars
`GET /users/me/calendarList`

Returns all calendars the authenticated user has added to their list.

**Query parameters:**
- `maxResults` — Maximum number of entries (default 100, max 250)
- `pageToken` — Token for next page
- `minAccessRole` — Filter by access role: `freeBusyReader`, `reader`, `writer`, `owner`
- `showDeleted` — Include deleted calendars (boolean, default `false`)
- `showHidden` — Include hidden calendars (boolean, default `false`)

**Response:**
```json
{
  "kind": "calendar#calendarList",
  "nextPageToken": "abc123",
  "items": [
    {
      "id": "john@gmail.com",
      "summary": "John's Calendar",
      "description": "Personal calendar",
      "timeZone": "Europe/Paris",
      "colorId": "17",
      "backgroundColor": "#9a9cff",
      "foregroundColor": "#000000",
      "accessRole": "owner",
      "primary": true
    }
  ]
}
```

### Get Calendar
`GET /calendars/{calendarId}`

Returns metadata for a specific calendar.

**Response:**
```json
{
  "kind": "calendar#calendar",
  "id": "john@gmail.com",
  "summary": "John's Calendar",
  "description": "Personal calendar",
  "timeZone": "Europe/Paris"
}
```

### List Events
`GET /calendars/{calendarId}/events`

Returns events from a calendar. Use `primary` as calendarId for the user's primary calendar.

**Query parameters:**
- `timeMin` — Lower bound (RFC 3339, e.g. `2024-01-01T00:00:00Z`)
- `timeMax` — Upper bound (RFC 3339)
- `maxResults` — Max events per page (default 250, max 2500)
- `pageToken` — Token for next page
- `q` — Free text search terms
- `singleEvents` — If `true`, expand recurring events into instances (required for `orderBy=startTime`)
- `orderBy` — `startTime` (requires `singleEvents=true`) or `updated`
- `showDeleted` — Include cancelled events (boolean)
- `timeZone` — Timezone for response (e.g. `Europe/Paris`)
- `updatedMin` — Only events updated after this time (RFC 3339)

**Response:**
```json
{
  "kind": "calendar#events",
  "summary": "John's Calendar",
  "timeZone": "Europe/Paris",
  "nextPageToken": "CiAKGjBp...",
  "items": [
    {
      "id": "abc123def456",
      "status": "confirmed",
      "summary": "Team standup",
      "description": "Daily sync meeting",
      "location": "Meeting Room A",
      "start": {
        "dateTime": "2024-06-15T09:00:00+02:00",
        "timeZone": "Europe/Paris"
      },
      "end": {
        "dateTime": "2024-06-15T09:30:00+02:00",
        "timeZone": "Europe/Paris"
      },
      "attendees": [
        { "email": "alice@example.com", "responseStatus": "accepted" },
        { "email": "bob@example.com", "responseStatus": "tentative" }
      ],
      "organizer": { "email": "john@gmail.com", "self": true },
      "creator": { "email": "john@gmail.com", "self": true },
      "htmlLink": "https://www.google.com/calendar/event?eid=...",
      "recurringEventId": "abc123def456_R20240615",
      "reminders": { "useDefault": true }
    }
  ]
}
```

### Get Event
`GET /calendars/{calendarId}/events/{eventId}`

Returns a single event by ID.

### Create Event
`POST /calendars/{calendarId}/events`

Creates a new event. Requires `calendar.events` or `calendar` scope.

**Query parameters:**
- `sendUpdates` — Send notifications: `all`, `externalOnly`, `none` (default `none`)
- `conferenceDataVersion` — Set to `1` to create Google Meet link

**Request body (JSON):**
```json
{
  "summary": "Project review",
  "description": "Quarterly project review meeting",
  "location": "Conference Room B",
  "start": {
    "dateTime": "2024-06-20T14:00:00",
    "timeZone": "Europe/Paris"
  },
  "end": {
    "dateTime": "2024-06-20T15:00:00",
    "timeZone": "Europe/Paris"
  },
  "attendees": [
    { "email": "alice@example.com" },
    { "email": "bob@example.com" }
  ],
  "reminders": {
    "useDefault": false,
    "overrides": [
      { "method": "popup", "minutes": 10 }
    ]
  },
  "conferenceData": {
    "createRequest": {
      "requestId": "unique-string-123",
      "conferenceSolutionKey": { "type": "hangoutsMeet" }
    }
  }
}
```

### Update Event
`PUT /calendars/{calendarId}/events/{eventId}`

Replaces an event entirely. Send the full event object. Requires `calendar.events` or `calendar` scope.

**Query parameters:**
- `sendUpdates` — `all`, `externalOnly`, `none`

### Patch Event
`PATCH /calendars/{calendarId}/events/{eventId}`

Partially updates an event. Only send the fields you want to change.

### Delete Event
`DELETE /calendars/{calendarId}/events/{eventId}`

Deletes an event. Requires `calendar.events` or `calendar` scope.

**Query parameters:**
- `sendUpdates` — `all`, `externalOnly`, `none`

### Quick Add Event
`POST /calendars/{calendarId}/events/quickAdd`

Creates an event from a text string (natural language). Requires `calendar.events` or `calendar` scope.

**Query parameters:**
- `text` — Text describing the event (e.g. "Lunch with Alice tomorrow at noon")

### Check Free/Busy
`POST /freeBusy`

Checks free/busy availability for calendars. Requires `calendar.freebusy` scope.

**Request body (JSON):**
```json
{
  "timeMin": "2024-06-15T00:00:00Z",
  "timeMax": "2024-06-16T00:00:00Z",
  "items": [
    { "id": "john@gmail.com" },
    { "id": "alice@example.com" }
  ]
}
```

**Response:**
```json
{
  "kind": "calendar#freeBusy",
  "calendars": {
    "john@gmail.com": {
      "busy": [
        {
          "start": "2024-06-15T09:00:00Z",
          "end": "2024-06-15T10:00:00Z"
        }
      ]
    }
  }
}
```

### Move Event
`POST /calendars/{calendarId}/events/{eventId}/move`

Moves an event to another calendar. Requires `calendar.events` or `calendar` scope.

**Query parameters:**
- `destination` — Target calendar ID

## Common Patterns

### Pagination
Token-based pagination:
- Response includes `nextPageToken`
- Pass as `pageToken` query parameter
- When no `nextPageToken` in response, no more pages

### Date/Time Formats
- **Timed events**: use `start.dateTime` and `end.dateTime` (RFC 3339)
- **All-day events**: use `start.date` and `end.date` (format `YYYY-MM-DD`)
- All-day event end date is **exclusive** (e.g. single-day event on June 15: `start.date: "2024-06-15"`, `end.date: "2024-06-16"`)

### Recurring Events
- Recurring events have a `recurrence` field with RRULE strings (e.g. `["RRULE:FREQ=WEEKLY;BYDAY=MO"]`)
- Use `singleEvents=true` to expand into individual instances
- Each instance has `recurringEventId` pointing to the parent

### Error Format
```json
{
  "error": {
    "code": 404,
    "message": "Not Found",
    "errors": [
      {
        "domain": "global",
        "reason": "notFound",
        "message": "Not Found"
      }
    ]
  }
}
```

## Important Notes
- Use `primary` as `calendarId` to refer to the authenticated user's primary calendar.
- Event IDs are globally unique strings. Calendar IDs are typically email addresses.
- Rate limit: 1,000,000 queries/day per project, up to 500 requests/100 seconds per user.
- All times must include timezone info. Use `timeZone` field or include offset in `dateTime`.
- To create a Google Meet link, set `conferenceDataVersion=1` query param and include `conferenceData.createRequest` in the body.
- The `sendUpdates` parameter controls email notifications to attendees — default is `none`.
