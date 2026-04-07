# Pinterest API

Base URL: `https://api.pinterest.com/v5`

Visual discovery platform API. Create and manage pins, boards, and access analytics. All requests use JSON bodies. All responses are JSON.

## Endpoints

### Get User Account
`GET /user_account`

Returns the authenticated user's profile information.

**Response:**
```json
{
  "account_type": "BUSINESS",
  "username": "myaccount",
  "profile_image": "https://...",
  "website_url": "https://example.com",
  "board_count": 15,
  "pin_count": 230,
  "follower_count": 1500,
  "following_count": 200
}
```

### Get User Analytics
`GET /user_account/analytics`

Returns analytics for the authenticated user's account.

**Query parameters:**
- `start_date` — Start date (YYYY-MM-DD, required)
- `end_date` — End date (YYYY-MM-DD, required)
- `metric_types` — Comma-separated: `IMPRESSION`, `PIN_CLICK`, `OUTBOUND_CLICK`, `SAVE`, `SAVE_RATE`
- `from_claimed_content` — `OTHER`, `CLAIMED`, `BOTH` (default `BOTH`)
- `app_types` — `ALL`, `MOBILE`, `TABLET`, `WEB` (default `ALL`)

**Response:**
```json
{
  "all": {
    "daily_metrics": [
      {
        "date": "2026-03-01",
        "data_status": "READY",
        "metrics": {
          "IMPRESSION": 1234,
          "PIN_CLICK": 56,
          "SAVE": 12
        }
      }
    ]
  }
}
```

### Create Pin
`POST /pins`

Create a new pin. Requires `pins:write` scope.

**Request body:**
```json
{
  "title": "My Pin Title",
  "description": "Pin description with keywords",
  "board_id": "123456789",
  "media_source": {
    "source_type": "image_url",
    "url": "https://example.com/image.jpg"
  },
  "link": "https://example.com/article",
  "alt_text": "Descriptive alt text for accessibility"
}
```

**Response:**
```json
{
  "id": "987654321",
  "created_at": "2026-03-15T10:30:00Z",
  "link": "https://example.com/article",
  "title": "My Pin Title",
  "description": "Pin description with keywords",
  "media": {
    "media_type": "image",
    "images": {
      "original": { "url": "https://i.pinimg.com/originals/..." }
    }
  }
}
```

### Get Pin
`GET /pins/{PIN_ID}`

Returns detailed information about a pin.

**Response:**
```json
{
  "id": "987654321",
  "created_at": "2026-03-15T10:30:00Z",
  "link": "https://example.com/article",
  "title": "My Pin Title",
  "description": "Pin description",
  "board_id": "123456789",
  "media": {
    "media_type": "image",
    "images": {
      "original": { "url": "https://i.pinimg.com/originals/..." },
      "600x": { "url": "https://i.pinimg.com/600x/..." }
    }
  }
}
```

### Delete Pin
`DELETE /pins/{PIN_ID}`

Delete a pin. Requires `pins:write` scope. Returns 204 No Content on success.

### Get Pin Analytics
`GET /pins/{PIN_ID}/analytics`

Get analytics for a specific pin.

**Query parameters:**
- `start_date` — Start date (YYYY-MM-DD, required)
- `end_date` — End date (YYYY-MM-DD, required)
- `metric_types` — Comma-separated: `IMPRESSION`, `PIN_CLICK`, `OUTBOUND_CLICK`, `SAVE`, `SAVE_RATE`

### List Boards
`GET /boards`

List all boards for the authenticated user.

**Query parameters:**
- `page_size` — Max items per page (1-250, default 25)
- `bookmark` — Pagination cursor

**Response:**
```json
{
  "items": [
    {
      "id": "123456789",
      "name": "My Board",
      "description": "Board description",
      "privacy": "PUBLIC",
      "pin_count": 45,
      "follower_count": 120,
      "created_at": "2025-06-01T08:00:00Z"
    }
  ],
  "bookmark": "abc123def456"
}
```

### Create Board
`POST /boards`

Create a new board. Requires `boards:write` scope.

**Request body:**
```json
{
  "name": "My New Board",
  "description": "Board for collecting ideas",
  "privacy": "PUBLIC"
}
```

### Get Board
`GET /boards/{BOARD_ID}`

Returns board details.

### List Board Pins
`GET /boards/{BOARD_ID}/pins`

List all pins on a board.

**Query parameters:**
- `page_size` — Max items per page (1-250, default 25)
- `bookmark` — Pagination cursor

### Delete Board
`DELETE /boards/{BOARD_ID}`

Delete a board. Requires `boards:write` scope. Returns 204 No Content.

### Search Pins
`GET /search/pins`

Search for pins. Requires `pins:read` scope.

**Query parameters:**
- `query` — Search query (required)
- `page_size` — Results per page (1-250, default 25)
- `bookmark` — Pagination cursor

## Common Patterns

### Pagination
Pinterest uses cursor-based pagination. Responses include a `bookmark` field. Pass this value as the `bookmark` query parameter for the next page. When `bookmark` is `null`, there are no more pages.

### Media Source (Pin Creation)
Pins require a `media_source` object:
- **Image URL**: `{ "source_type": "image_url", "url": "https://..." }`
- **Image base64**: `{ "source_type": "image_base64", "data": "...", "content_type": "image/png" }`
- **Video**: `{ "source_type": "video_id", "cover_image_url": "...", "media_id": "..." }`

### Rate Limits
- Write operations: ~1 request/second per user
- Read operations: ~100 requests/minute per user
- Rate limit info in response headers: `X-Ratelimit-Limit`, `X-Ratelimit-Remaining`

### Error Format
```json
{
  "code": 0,
  "message": "error description"
}
```

## Important Notes
- **Board IDs** and **Pin IDs** are numeric strings.
- **Dates in analytics** use `YYYY-MM-DD` format. Maximum 30 days range per query.
- **Images** must be JPEG or PNG, minimum 100x100 pixels.
- **Trial vs Standard access**: Apps in Trial mode are limited to the app owner. Apply for Standard access to serve other users.
- **Organic pin creation** requires Standard access (app review by Pinterest).
- **Video pins** require a two-step process: upload media first via `POST /media`, then reference the `media_id` in the pin.
