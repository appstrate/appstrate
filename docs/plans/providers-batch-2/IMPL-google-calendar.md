# IMPL: Google Calendar Provider

## Provider Info
- **Slug**: `google-calendar`
- **Display Name**: Google Calendar
- **Auth Mode**: OAuth2
- **Base URL**: `https://www.googleapis.com/calendar/v3`
- **Docs**: https://developers.google.com/calendar/api/v3/reference

## Auth Details
- **Authorization URL**: `https://accounts.google.com/o/oauth2/v2/auth`
- **Token URL**: `https://oauth2.googleapis.com/token`
- **Refresh URL**: `https://oauth2.googleapis.com/token`
- **PKCE**: false (Google web apps don't support PKCE)
- **Token Auth Method**: `client_secret_post`
- **Authorization Params**: `{ "access_type": "offline", "prompt": "consent" }`
- **Scope Separator**: space

## Scopes
- **Default (read-only)**:
  - `https://www.googleapis.com/auth/calendar.readonly` — Read-only access to calendars
- **Available**:
  - `https://www.googleapis.com/auth/calendar.readonly` — Read-only access
  - `https://www.googleapis.com/auth/calendar` — Full calendar access
  - `https://www.googleapis.com/auth/calendar.events` — Manage events
  - `https://www.googleapis.com/auth/calendar.events.readonly` — Read events only
  - `https://www.googleapis.com/auth/calendar.settings.readonly` — Read calendar settings
  - `https://www.googleapis.com/auth/calendar.freebusy` — Read free/busy info

## Authorized URIs
- `https://www.googleapis.com/calendar/*`

## Setup Guide
1. Enable the Google Calendar API → https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
2. Configure the OAuth consent screen → https://console.cloud.google.com/apis/credentials/consent
3. Create OAuth credentials → https://console.cloud.google.com/apis/credentials

## Key Endpoints to Document
1. GET /calendars/{calendarId} — Get calendar metadata
2. GET /users/me/calendarList — List user's calendars
3. GET /calendars/{calendarId}/events — List events
4. GET /calendars/{calendarId}/events/{eventId} — Get single event
5. POST /calendars/{calendarId}/events — Create event
6. PUT /calendars/{calendarId}/events/{eventId} — Update event
7. DELETE /calendars/{calendarId}/events/{eventId} — Delete event
8. POST /calendars/{calendarId}/events/{eventId}/move — Move event to another calendar
9. GET /freeBusy — Check free/busy status
10. POST /calendars/{calendarId}/events/quickAdd — Quick-add from text string

## Compatibility Notes
- Standard Google OAuth2 pattern (same as Gmail, YouTube, Drive)
- No issues expected
