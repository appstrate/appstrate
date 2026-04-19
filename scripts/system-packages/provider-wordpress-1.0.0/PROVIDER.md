# WordPress Provider

Base URL: `{{site_url}}/wp-json/wp/v2`

Replace `{{site_url}}` with the site URL from the connection credentials.

## Authentication

WordPress uses **Application Passwords** with HTTP Basic Auth. The credentials (`{{username}}` and `{{application_password}}`) are available via sidecar substitution. You must construct the `Authorization` header yourself:

```
Authorization: Basic base64({{username}}:{{application_password}})
```

Application Passwords require HTTPS. The sidecar substitutes `{{username}}` and `{{application_password}}` placeholders automatically.

## Key Endpoints

### Get Current User

```
GET {{site_url}}/wp-json/wp/v2/users/me
```

### List Posts

```
GET {{site_url}}/wp-json/wp/v2/posts
```

Supports `?page=1&per_page=10`, `?status=publish|draft|pending`, `?search=`, `?categories=`, `?tags=`.

### Get Post

```
GET {{site_url}}/wp-json/wp/v2/posts/{postId}
```

### Create Post

```
POST {{site_url}}/wp-json/wp/v2/posts
Content-Type: application/json

{
  "title": "My Post",
  "content": "<p>Post content here</p>",
  "status": "draft",
  "categories": [1, 3],
  "tags": [5]
}
```

### Update Post

```
PUT {{site_url}}/wp-json/wp/v2/posts/{postId}
Content-Type: application/json

{
  "title": "Updated Title",
  "status": "publish"
}
```

### Delete Post

```
DELETE {{site_url}}/wp-json/wp/v2/posts/{postId}
```

Moves to trash by default. Add `?force=true` to permanently delete.

### List Pages

```
GET {{site_url}}/wp-json/wp/v2/pages
```

### Create Page

```
POST {{site_url}}/wp-json/wp/v2/pages
Content-Type: application/json

{
  "title": "My Page",
  "content": "<p>Page content</p>",
  "status": "publish"
}
```

### List Categories

```
GET {{site_url}}/wp-json/wp/v2/categories
```

### List Media

```
GET {{site_url}}/wp-json/wp/v2/media
```

### Upload Media

```
POST {{site_url}}/wp-json/wp/v2/media
Content-Type: image/jpeg
Content-Disposition: attachment; filename="photo.jpg"

{binary data}
```

## Notes

- Pagination: `?page=N&per_page=M` (max 100). Response headers: `X-WP-Total`, `X-WP-TotalPages`
- Post statuses: `publish`, `draft`, `pending`, `private`, `trash`
- `allowAllUris` is enabled because site URLs are user-specific
- Rate limits depend on the hosting provider
- Some endpoints may be restricted by plugins or hosting configuration
