# YouTube Data API

Base URL: `https://www.googleapis.com/youtube/v3`

Video sharing platform API by Google. Manage channels, videos, playlists, comments, and subscriptions. Uses the same Google OAuth2 as Gmail and Google Drive.

## Endpoints

### Get My Channel
`GET /channels`

Returns the authenticated user's channel.

**Query parameters:**
- `mine` — `true` (required for the authenticated user's channel)
- `part` — Comma-separated: `snippet`, `contentDetails`, `statistics`, `brandingSettings`

**Response:**
```json
{
  "items": [
    {
      "id": "UC1234567890",
      "snippet": {
        "title": "My Channel",
        "description": "Welcome to my channel!",
        "thumbnails": { "default": { "url": "https://..." } },
        "publishedAt": "2020-01-15T10:00:00Z"
      },
      "statistics": {
        "viewCount": "1234567",
        "subscriberCount": "50000",
        "videoCount": "150"
      },
      "contentDetails": {
        "relatedPlaylists": {
          "uploads": "UU1234567890"
        }
      }
    }
  ]
}
```

### Get Videos
`GET /videos`

Returns video details by ID.

**Query parameters:**
- `id` — Comma-separated video IDs (required)
- `part` — `snippet`, `contentDetails`, `statistics`, `status`, `player`, `topicDetails`

**Response:**
```json
{
  "items": [
    {
      "id": "dQw4w9WgXcQ",
      "snippet": {
        "title": "Video Title",
        "description": "Video description...",
        "channelId": "UC1234567890",
        "channelTitle": "My Channel",
        "publishedAt": "2026-01-15T12:00:00Z",
        "tags": ["tag1", "tag2"],
        "categoryId": "22",
        "thumbnails": {
          "default": { "url": "https://i.ytimg.com/vi/.../default.jpg" },
          "high": { "url": "https://i.ytimg.com/vi/.../hqdefault.jpg" }
        }
      },
      "statistics": {
        "viewCount": "123456",
        "likeCount": "5000",
        "commentCount": "200"
      },
      "contentDetails": {
        "duration": "PT5M30S",
        "definition": "hd"
      },
      "status": {
        "privacyStatus": "public",
        "uploadStatus": "processed"
      }
    }
  ]
}
```

### Search
`GET /search`

Search for videos, channels, or playlists.

**Query parameters:**
- `q` — Search query (required)
- `part` — `snippet` (required)
- `type` — `video`, `channel`, `playlist` (comma-separated)
- `maxResults` — Results per page (1-50, default 5)
- `pageToken` — Pagination token
- `order` — `relevance` (default), `date`, `rating`, `viewCount`, `title`
- `channelId` — Filter by channel
- `publishedAfter` / `publishedBefore` — ISO 8601 datetime
- `regionCode` — ISO 3166-1 alpha-2 (e.g. `US`, `FR`)
- `videoDuration` — `short` (<4min), `medium` (4-20min), `long` (>20min)

**Response:**
```json
{
  "items": [
    {
      "id": { "kind": "youtube#video", "videoId": "dQw4w9WgXcQ" },
      "snippet": {
        "title": "...",
        "description": "...",
        "channelTitle": "...",
        "publishedAt": "...",
        "thumbnails": {}
      }
    }
  ],
  "nextPageToken": "CAUQAA",
  "pageInfo": { "totalResults": 1000000, "resultsPerPage": 5 }
}
```

### Upload Video
`POST https://www.googleapis.com/upload/youtube/v3/videos`

Upload a video file. Uses resumable upload protocol. Requires `youtube.upload` scope.

**Query parameters:**
- `part` — `snippet,status` (required)
- `uploadType` — `resumable` (recommended)

**Request body (JSON, in first request):**
```json
{
  "snippet": {
    "title": "My Video Title",
    "description": "Video description",
    "tags": ["tag1", "tag2"],
    "categoryId": "22"
  },
  "status": {
    "privacyStatus": "public",
    "selfDeclaredMadeForKids": false
  }
}
```

Resumable upload flow:
1. POST with metadata → get `Location` header (upload URI)
2. PUT video bytes to upload URI (can be chunked)
3. On completion, response contains the video resource

### Update Video
`PUT /videos`

Update a video's metadata. Requires `youtube` or `youtube.force-ssl` scope.

**Query parameters:**
- `part` — Parts to update: `snippet`, `status`

**Request body (JSON):**
```json
{
  "id": "dQw4w9WgXcQ",
  "snippet": {
    "title": "Updated Title",
    "description": "Updated description",
    "categoryId": "22"
  }
}
```

### Delete Video
`DELETE /videos`

**Query parameters:**
- `id` — Video ID (required)

### List Playlists
`GET /playlists`

**Query parameters:**
- `mine` — `true` for the authenticated user's playlists
- `channelId` — Playlists of a specific channel
- `part` — `snippet`, `contentDetails`, `status`
- `maxResults` — 1-50 (default 5)
- `pageToken` — Pagination token

### Create Playlist
`POST /playlists`

**Query parameters:**
- `part` — `snippet,status`

**Request body:**
```json
{
  "snippet": {
    "title": "My Playlist",
    "description": "A great playlist"
  },
  "status": {
    "privacyStatus": "public"
  }
}
```

### Add Video to Playlist
`POST /playlistItems`

**Query parameters:**
- `part` — `snippet`

**Request body:**
```json
{
  "snippet": {
    "playlistId": "PL1234567890",
    "resourceId": {
      "kind": "youtube#video",
      "videoId": "dQw4w9WgXcQ"
    }
  }
}
```

### List Playlist Items
`GET /playlistItems`

**Query parameters:**
- `playlistId` — Playlist ID (required)
- `part` — `snippet`, `contentDetails`, `status`
- `maxResults` — 1-50

### Get Video Comments
`GET /commentThreads`

Top-level comment threads on a video.

**Query parameters:**
- `videoId` — Video ID (required)
- `part` — `snippet`, `replies`
- `maxResults` — 1-100 (default 20)
- `pageToken` — Pagination token
- `order` — `time` or `relevance`
- `textFormat` — `plainText` or `html`

### Post Comment
`POST /commentThreads`

**Query parameters:**
- `part` — `snippet`

**Request body:**
```json
{
  "snippet": {
    "videoId": "dQw4w9WgXcQ",
    "topLevelComment": {
      "snippet": {
        "textOriginal": "Great video!"
      }
    }
  }
}
```

### Reply to Comment
`POST /comments`

**Query parameters:**
- `part` — `snippet`

**Request body:**
```json
{
  "snippet": {
    "parentId": "UgxABC123",
    "textOriginal": "Thanks for your comment!"
  }
}
```

### List Subscriptions
`GET /subscriptions`

**Query parameters:**
- `mine` — `true`
- `part` — `snippet`, `contentDetails`
- `maxResults` — 1-50

## Common Patterns

### Part Parameter (Resource Decomposition)
YouTube API uses a `part` parameter to specify which resource properties to return. This reduces response size and API quota cost.
- `snippet` — Basic metadata (title, description, thumbnails)
- `contentDetails` — Duration, definition, playlists content
- `statistics` — View count, like count, comment count
- `status` — Privacy status, upload status

Multiple parts: `part=snippet,statistics,contentDetails`

### Pagination
Token-based pagination:
- Response includes `nextPageToken` (and sometimes `prevPageToken`)
- Pass as `pageToken` query parameter
- `pageInfo.totalResults` gives the total count

### Quota System
YouTube API uses a quota system (not simple rate limits):
- Default: 10,000 units per day per project
- Read operations: 1-100 units (search = 100, list = 1-3)
- Write operations: 50-1600 units (upload = 1600)
- Check usage: Google Cloud Console > APIs & Services > Quotas

### Duration Format
Video durations use ISO 8601 duration format:
- `PT5M30S` = 5 minutes 30 seconds
- `PT1H2M3S` = 1 hour 2 minutes 3 seconds
- `P0D` = livestream (no duration)

### Error Format
```json
{
  "error": {
    "code": 403,
    "message": "...",
    "errors": [
      {
        "domain": "youtube.quota",
        "reason": "quotaExceeded",
        "message": "..."
      }
    ]
  }
}
```

## Important Notes
- **Same Google Cloud project** as Gmail/Drive/Sheets — reuse the same OAuth credentials and just enable the YouTube Data API.
- **Quota is per-project, not per-user** — a single project shares 10,000 units/day across all users.
- **Search is expensive** — 100 quota units per call. Use `videos.list` by ID when possible (1 unit).
- **Upload requires separate URL** — `https://www.googleapis.com/upload/youtube/v3/videos` (not the standard base URL).
- **Video processing** — After upload, videos go through processing. Check `status.uploadStatus` for progress.
- **Category IDs** are numeric: `1` = Film & Animation, `10` = Music, `22` = People & Blogs, `24` = Entertainment, `25` = News, `28` = Science & Technology.
- **Statistics are strings** — `viewCount`, `likeCount` etc. are returned as strings, not numbers.
- **Dislike count hidden** — `dislikeCount` is no longer returned in the API (since Nov 2021).
