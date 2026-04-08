# IMPL: WordPress Provider

## Provider Info
- **Slug**: `wordpress`
- **Display Name**: WordPress
- **Auth Mode**: API Key (Application Passwords)
- **Base URL**: `https://{site}/wp-json/wp/v2`
- **Docs**: https://developer.wordpress.org/rest-api/

## Auth Details
- **Auth Mode**: `api_key`
- **Credential Schema**:
  - `site_url` (string) — WordPress site URL (e.g. https://mysite.com)
  - `username` (string) — WordPress username
  - `application_password` (string) — Application password (generated in WordPress admin)
- **Header**: `Authorization: Basic base64(username:application_password)`

## ⚠️ Note on Auth
WordPress.com hosted sites support OAuth2, but self-hosted WordPress uses Application Passwords (since WP 5.6). Since Appstrate targets the broadest compatibility, **API key mode with Application Passwords** is the best approach. Basic Auth with base64-encoded `username:password`.

## Authorized URIs
- `https://*/*` (site-specific, but since URLs vary we need `allowAllUris: true`)

## Setup Guide
1. Go to your WordPress admin → Users → Profile
2. Scroll to "Application Passwords" section
3. Create a new Application Password and copy it
4. Enter your site URL, username, and application password

## Key Endpoints to Document
1. GET /wp/v2/posts — List posts
2. GET /wp/v2/posts/{id} — Get post
3. POST /wp/v2/posts — Create post
4. PUT /wp/v2/posts/{id} — Update post
5. DELETE /wp/v2/posts/{id} — Delete post
6. GET /wp/v2/pages — List pages
7. GET /wp/v2/pages/{id} — Get page
8. POST /wp/v2/pages — Create page
9. GET /wp/v2/users/me — Get current user
10. GET /wp/v2/categories — List categories
11. GET /wp/v2/media — List media
12. POST /wp/v2/media — Upload media

## Compatibility Notes
- **Application Passwords** require HTTPS (WordPress enforces this)
- Base URL is site-specific — agent must construct from `site_url`
- `allowAllUris: true` needed since site URLs vary
- Pagination uses `page` and `per_page` query params + `X-WP-Total` / `X-WP-TotalPages` headers
- Rate limits depend on the hosting provider
- Post status values: `publish`, `draft`, `pending`, `private`, `trash`
