# Zoom API

Base URL: `https://api.zoom.us/v2`

Video conferencing platform API. Manage meetings, recordings, users, and webinars. Uses granular scopes with the format `resource:action:scope`. Token exchange uses HTTP Basic Auth (client_secret_basic).

## Endpoints

### Get Current User
`GET /users/me`

Returns the authenticated user's profile. Requires `user:read:user` scope.

**Response:**
```json
{
  "id": "KDcuGIm1QgePTO8WbOqwIQ",
  "first_name": "John",
  "last_name": "Doe",
  "display_name": "John Doe",
  "email": "john@example.com",
  "type": 2,
  "timezone": "Europe/Paris",
  "created_at": "2020-01-15T10:00:00Z",
  "pic_url": "https://lh3.googleusercontent.com/...",
  "personal_meeting_url": "https://zoom.us/j/1234567890"
}
```

### List Meetings
`GET /users/{userId}/meetings`

Returns meetings for a user. Use `me` as userId for the authenticated user. Requires `meeting:read:list_meetings` scope.

**Query parameters:**
- `type` — Meeting type: `scheduled`, `live`, `upcoming`, `upcoming_meetings`, `previous_meetings`
- `page_size` — Items per page (default 30, max 300)
- `next_page_token` — Token for next page
- `from` — Start date (YYYY-MM-DD, for `previous_meetings`)
- `to` — End date (YYYY-MM-DD)

**Response:**
```json
{
  "page_size": 30,
  "total_records": 15,
  "next_page_token": "",
  "meetings": [
    {
      "id": 1234567890,
      "topic": "Weekly Team Standup",
      "type": 8,
      "start_time": "2024-06-20T09:00:00Z",
      "duration": 30,
      "timezone": "Europe/Paris",
      "created_at": "2024-06-01T10:00:00Z",
      "join_url": "https://zoom.us/j/1234567890",
      "agenda": "Weekly sync meeting"
    }
  ]
}
```

### Get Meeting
`GET /meetings/{meetingId}`

Returns details for a specific meeting. Requires `meeting:read:meeting` scope.

**Response:**
```json
{
  "id": 1234567890,
  "topic": "Weekly Team Standup",
  "type": 8,
  "status": "waiting",
  "start_time": "2024-06-20T09:00:00Z",
  "duration": 30,
  "timezone": "Europe/Paris",
  "agenda": "Weekly sync meeting",
  "join_url": "https://zoom.us/j/1234567890",
  "password": "abc123",
  "settings": {
    "host_video": true,
    "participant_video": true,
    "mute_upon_entry": false,
    "waiting_room": true,
    "auto_recording": "none"
  }
}
```

### Create Meeting
`POST /users/{userId}/meetings`

Creates a new meeting. Requires `meeting:write:meeting` scope.

**Request body (JSON):**
```json
{
  "topic": "Project Review",
  "type": 2,
  "start_time": "2024-06-25T14:00:00Z",
  "duration": 60,
  "timezone": "Europe/Paris",
  "agenda": "Quarterly project review",
  "settings": {
    "host_video": true,
    "participant_video": true,
    "waiting_room": true,
    "auto_recording": "cloud",
    "meeting_authentication": false
  }
}
```

### Update Meeting
`PATCH /meetings/{meetingId}`

Updates an existing meeting. Requires `meeting:write:meeting` scope.

### Delete Meeting
`DELETE /meetings/{meetingId}`

Deletes a meeting. Requires `meeting:delete:meeting` scope.

**Query parameters:**
- `occurrence_id` — Delete a specific occurrence of a recurring meeting
- `schedule_for_reminder` — Send cancellation email (`true`/`false`)

### List Recordings
`GET /users/{userId}/recordings`

Returns cloud recordings for a user. Requires `recording:read:list_recording_files` scope.

**Query parameters:**
- `from` — Start date (YYYY-MM-DD, required)
- `to` — End date (YYYY-MM-DD, required)
- `page_size` — Items per page (default 30, max 300)
- `next_page_token` — Token for next page

**Response:**
```json
{
  "from": "2024-06-01",
  "to": "2024-06-30",
  "total_records": 5,
  "meetings": [
    {
      "id": 1234567890,
      "topic": "Team Standup",
      "start_time": "2024-06-15T09:00:00Z",
      "duration": 28,
      "recording_count": 3,
      "recording_files": [
        {
          "id": "rec123",
          "meeting_id": "abc123",
          "recording_start": "2024-06-15T09:00:00Z",
          "recording_end": "2024-06-15T09:28:00Z",
          "file_type": "MP4",
          "file_size": 52428800,
          "download_url": "https://zoom.us/rec/download/...",
          "recording_type": "shared_screen_with_speaker_view"
        }
      ]
    }
  ]
}
```

### Get Meeting Recordings
`GET /meetings/{meetingId}/recordings`

Returns recordings for a specific meeting.

### Get Meeting Participants Report
`GET /report/meetings/{meetingId}/participants`

Returns participants for a past meeting. Requires `report:read:list_meeting_participants` scope.

**Query parameters:**
- `page_size` — Items per page (default 30, max 300)
- `next_page_token` — Token for next page

**Response:**
```json
{
  "total_records": 5,
  "participants": [
    {
      "id": "abc123",
      "name": "Alice Martin",
      "user_email": "alice@example.com",
      "join_time": "2024-06-15T09:01:00Z",
      "leave_time": "2024-06-15T09:28:00Z",
      "duration": 1620
    }
  ]
}
```

### List Webinars
`GET /users/{userId}/webinars`

Returns webinars for a user. Requires `webinar:read:list_webinars` scope.

**Query parameters:**
- `page_size` — Items per page (default 30, max 300)
- `next_page_token` — Token for next page

## Common Patterns

### Pagination
Token-based pagination:
- Response includes `next_page_token`
- Pass as `next_page_token` query parameter
- Empty string `""` means no more pages
- `page_size` controls items per page

### Meeting Types
- `1` — Instant meeting
- `2` — Scheduled meeting
- `3` — Recurring meeting (no fixed time)
- `8` — Recurring meeting (fixed time)

### Error Format
```json
{
  "code": 3001,
  "message": "Meeting does not exist: 1234567890."
}
```

## Important Notes
- Access tokens expire after 1 hour. Refresh tokens are very long-lived (~15 years).
- Uses `client_secret_basic` (HTTP Basic Auth) for token exchange — client_id:client_secret base64-encoded in Authorization header.
- Meeting IDs are numeric (up to 11 digits). Use them as integers in paths.
- `type` values for users: `1` (basic), `2` (licensed), `3` (on-prem).
- Recording download URLs require the access token as a query parameter or header.
- Rate limits: varies by endpoint. Most endpoints allow ~10 requests/second. Heavy endpoints (reports) have lower limits.
- Date ranges for recordings/reports: max 30 days per request.
- Use `me` as `userId` to refer to the authenticated user.
