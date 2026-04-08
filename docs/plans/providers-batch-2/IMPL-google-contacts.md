# IMPL: Google Contacts Provider

## Provider Info
- **Slug**: `google-contacts`
- **Display Name**: Google Contacts
- **Auth Mode**: OAuth2
- **Base URL**: `https://people.googleapis.com/v1`
- **Docs**: https://developers.google.com/people/api/rest

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
  - `https://www.googleapis.com/auth/contacts.readonly` — Read contacts
- **Available**:
  - `https://www.googleapis.com/auth/contacts.readonly` — Read contacts
  - `https://www.googleapis.com/auth/contacts` — Read and write contacts
  - `https://www.googleapis.com/auth/contacts.other.readonly` — Read "other contacts"
  - `https://www.googleapis.com/auth/directory.readonly` — Read directory (Google Workspace)
  - `https://www.googleapis.com/auth/userinfo.profile` — Read user profile

## Authorized URIs
- `https://people.googleapis.com/*`

## Setup Guide
1. Enable the People API → https://console.cloud.google.com/apis/library/people.googleapis.com
2. Configure the OAuth consent screen → https://console.cloud.google.com/apis/credentials/consent
3. Create OAuth credentials → https://console.cloud.google.com/apis/credentials

## Key Endpoints to Document
1. GET /v1/people/me — Get current user profile
2. GET /v1/people/{resourceName} — Get a contact
3. GET /v1/people/me/connections — List contacts (deprecated, use searchContacts)
4. GET /v1/people:searchContacts — Search contacts
5. POST /v1/people:createContact — Create contact
6. PATCH /v1/people/{resourceName}:updateContact — Update contact
7. DELETE /v1/people/{resourceName}:deleteContact — Delete contact
8. GET /v1/contactGroups — List contact groups (labels)
9. GET /v1/contactGroups/{resourceName} — Get contact group
10. POST /v1/people:batchGetContacts — Batch get contacts
11. GET /v1/otherContacts — List "Other contacts"

## Compatibility Notes
- Standard Google OAuth2 pattern
- Uses People API (replacement for deprecated Contacts API)
- Resource names format: `people/{personId}`
- Must specify `personFields` mask in requests (e.g. `names,emailAddresses,phoneNumbers`)
- Pagination uses `pageToken` and `pageSize`
- Contact groups use resource names: `contactGroups/{groupId}`
- "Other contacts" = auto-suggested contacts from Gmail interactions
