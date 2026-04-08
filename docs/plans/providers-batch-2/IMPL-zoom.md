# IMPL: Zoom Provider

## Provider Info
- **Slug**: `zoom`
- **Display Name**: Zoom
- **Auth Mode**: OAuth2
- **Base URL**: `https://api.zoom.us/v2`
- **Docs**: https://developers.zoom.us/docs/api/

## Auth Details
- **Authorization URL**: `https://zoom.us/oauth/authorize`
- **Token URL**: `https://zoom.us/oauth/token`
- **Refresh URL**: `https://zoom.us/oauth/token`
- **PKCE**: true
- **Token Auth Method**: `client_secret_basic`
- **Scope Separator**: space

## Scopes
- **Default (read-only)**:
  - `user:read:user` — Read user profile
  - `meeting:read:list_meetings` — List meetings
  - `meeting:read:meeting` — Read meeting details
- **Available**:
  - `user:read:user` — Read user profile
  - `meeting:read:list_meetings` — List meetings
  - `meeting:read:meeting` — Read meeting details
  - `meeting:write:meeting` — Create/update meetings
  - `meeting:delete:meeting` — Delete meetings
  - `recording:read:list_recording_files` — List recordings
  - `recording:read:recording` — Read recording details
  - `webinar:read:list_webinars` — List webinars
  - `webinar:read:webinar` — Read webinar details
  - `report:read:list_meeting_participants` — Meeting participants report

## Authorized URIs
- `https://api.zoom.us/*`

## Setup Guide
1. Create a Zoom Server-to-Server OAuth or User-Managed app → https://marketplace.zoom.us/develop/create
2. Configure OAuth scopes and redirect URL
3. Copy Client ID and Client Secret

## Key Endpoints to Document
1. GET /users/me — Get current user
2. GET /users/{userId}/meetings — List meetings
3. GET /meetings/{meetingId} — Get meeting details
4. POST /users/{userId}/meetings — Create meeting
5. PATCH /meetings/{meetingId} — Update meeting
6. DELETE /meetings/{meetingId} — Delete meeting
7. GET /users/{userId}/recordings — List cloud recordings
8. GET /meetings/{meetingId}/recordings — Get meeting recordings
9. GET /report/meetings/{meetingId}/participants — Get meeting participants
10. GET /users/{userId}/webinars — List webinars

## Compatibility Notes
- Zoom uses `client_secret_basic` (HTTP Basic Auth) for token exchange
- Access tokens expire after 1 hour, refresh tokens after 15 years
- Zoom migrated to granular scopes (format: `resource:action:scope`)
- Rate limits: 10 requests/second (light), varies by endpoint
- Pagination uses `next_page_token` and `page_size`
