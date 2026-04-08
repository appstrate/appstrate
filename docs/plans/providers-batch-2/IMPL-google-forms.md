# IMPL: Google Forms Provider

## Provider Info
- **Slug**: `google-forms`
- **Display Name**: Google Forms
- **Auth Mode**: OAuth2
- **Base URL**: `https://forms.googleapis.com/v1`
- **Docs**: https://developers.google.com/workspace/forms/api/reference/rest

## Auth Details
- **Authorization URL**: `https://accounts.google.com/o/oauth2/v2/auth`
- **Token URL**: `https://oauth2.googleapis.com/token`
- **Refresh URL**: `https://oauth2.googleapis.com/token`
- **PKCE**: false
- **Token Auth Method**: `client_secret_post`
- **Authorization Params**: `{ "access_type": "offline", "prompt": "consent" }`
- **Scope Separator**: space

## Scopes
- **Default (read-only)**:
  - `https://www.googleapis.com/auth/forms.responses.readonly` — Read form responses
  - `https://www.googleapis.com/auth/forms.body.readonly` — Read form structure
- **Available**:
  - `https://www.googleapis.com/auth/forms.body.readonly` — Read form structure
  - `https://www.googleapis.com/auth/forms.body` — Read and write form structure
  - `https://www.googleapis.com/auth/forms.responses.readonly` — Read form responses
  - `https://www.googleapis.com/auth/drive.readonly` — Read Google Drive (to list forms)
  - `https://www.googleapis.com/auth/drive` — Full Drive access

## Authorized URIs
- `https://forms.googleapis.com/*`

## Setup Guide
1. Enable the Google Forms API → https://console.cloud.google.com/apis/library/forms.googleapis.com
2. Configure the OAuth consent screen → https://console.cloud.google.com/apis/credentials/consent
3. Create OAuth credentials → https://console.cloud.google.com/apis/credentials

## Key Endpoints to Document
1. GET /v1/forms/{formId} — Get form structure
2. POST /v1/forms — Create form
3. POST /v1/forms/{formId}:batchUpdate — Update form structure
4. GET /v1/forms/{formId}/responses — List form responses
5. GET /v1/forms/{formId}/responses/{responseId} — Get single response
6. POST /v1/forms/{formId}/watches — Create watch (push notifications)
7. DELETE /v1/forms/{formId}/watches/{watchId} — Delete watch

## Compatibility Notes
- Standard Google OAuth2 pattern
- Forms API has limited endpoints compared to other Google APIs
- Form discovery requires Google Drive API (`drive.readonly` scope)
- batchUpdate uses a request body with `requests[]` array containing update operations
- Watch notifications use Cloud Pub/Sub topics
