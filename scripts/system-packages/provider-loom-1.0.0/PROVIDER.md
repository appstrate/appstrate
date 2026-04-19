# Loom Provider

Base URL: `https://developer.loom.com`

## Limited API Surface

Loom's public REST API is **limited**. The platform primarily offers SDKs (Record SDK, Embed SDK) rather than a comprehensive REST API. The available endpoints focus on video metadata and embed information.

## Key Endpoints

### Get oEmbed Data

```
GET https://www.loom.com/v1/oembed?url=https://www.loom.com/share/{videoId}
```

Returns embed metadata (title, thumbnail, HTML embed code, dimensions). No authentication required.

### List Videos

```
POST https://developer.loom.com/v1/videos
Content-Type: application/json

{}
```

Returns a paginated list of videos in the workspace. Supports cursor-based pagination.

### Get Video

```
GET https://developer.loom.com/v1/videos/{videoId}
```

Returns video details including title, created date, duration, thumbnail URL, and transcript (if available).

### Get Video Transcript

```
GET https://developer.loom.com/v1/videos/{videoId}/transcript
```

Returns the video transcript as timestamped segments.

### Delete Video

```
DELETE https://developer.loom.com/v1/videos/{videoId}
```

## Notes

- The Loom API is primarily designed for SDK integrations (recording, embedding)
- REST endpoints are limited compared to full-featured APIs
- oEmbed endpoint is public (no auth needed) and works for any public Loom video
- Video transcripts may not be available for all videos
- Rate limits are not publicly documented — use reasonable request intervals
