# X (Twitter) API

Base URL: `https://api.x.com/2`

Microblogging and real-time social platform. Read and post tweets, manage followers, search conversations, and send direct messages. Uses API v2 with JSON responses.

## Endpoints

### Get Authenticated User
`GET /users/me`

Returns the authenticated user's profile. Requires `users.read` scope.

**Query parameters:**
- `user.fields` — Comma-separated fields: `id`, `name`, `username`, `description`, `profile_image_url`, `public_metrics`, `created_at`, `location`, `url`, `verified`

**Response:**
```json
{
  "data": {
    "id": "12345",
    "name": "John Doe",
    "username": "johndoe",
    "description": "Developer",
    "profile_image_url": "https://pbs.twimg.com/...",
    "public_metrics": {
      "followers_count": 1234,
      "following_count": 567,
      "tweet_count": 890,
      "listed_count": 42
    }
  }
}
```

### Get User by Username
`GET /users/by/username/{USERNAME}`

Lookup a user by their username (handle).

**Query parameters:**
- `user.fields` — Same as above

### Get Tweet
`GET /tweets/{TWEET_ID}`

Get a single tweet by ID. Requires `tweet.read` scope.

**Query parameters:**
- `tweet.fields` — `id`, `text`, `created_at`, `author_id`, `public_metrics`, `entities`, `attachments`, `conversation_id`
- `expansions` — `author_id`, `attachments.media_keys`, `referenced_tweets.id`
- `media.fields` — `url`, `preview_image_url`, `width`, `height`, `type`

### Search Recent Tweets
`GET /tweets/search/recent`

Search tweets from the last 7 days. Requires `tweet.read` scope.

**Query parameters:**
- `query` — Search query (required, max 512 chars). Supports operators: `from:`, `to:`, `#hashtag`, `"exact phrase"`, `-exclude`, `is:retweet`, `has:media`, `lang:`
- `max_results` — Results per page (10-100, default 10)
- `next_token` — Pagination token
- `start_time` — ISO 8601 start time
- `end_time` — ISO 8601 end time
- `tweet.fields` — Fields to include
- `expansions` — Expand referenced objects (`author_id`, `attachments.media_keys`)

**Response:**
```json
{
  "data": [
    {
      "id": "1234567890",
      "text": "Hello world!",
      "author_id": "12345",
      "created_at": "2026-01-15T12:00:00.000Z",
      "public_metrics": {
        "retweet_count": 5,
        "reply_count": 2,
        "like_count": 42,
        "quote_count": 1,
        "bookmark_count": 3,
        "impression_count": 1500
      }
    }
  ],
  "meta": {
    "next_token": "abc123",
    "result_count": 10
  }
}
```

### Create Tweet
`POST /tweets`

Post a new tweet. Requires `tweet.write` scope.

**Request body (JSON):**
```json
{
  "text": "Hello from the API!",
  "reply": {
    "in_reply_to_tweet_id": "1234567890"
  },
  "media": {
    "media_ids": ["12345"]
  },
  "poll": {
    "options": ["Yes", "No"],
    "duration_minutes": 1440
  }
}
```

At minimum, `text` is required (max 280 characters).

### Delete Tweet
`DELETE /tweets/{TWEET_ID}`

Delete a tweet. Requires `tweet.write` scope.

### Get User's Followers
`GET /users/{USER_ID}/followers`

Returns users who follow the specified user. Requires `follows.read` scope.

**Query parameters:**
- `max_results` — Results per page (1-1000, default 100)
- `pagination_token` — Token for next page
- `user.fields` — Fields to include

### Follow User
`POST /users/{USER_ID}/following`

Follow a user. Requires `follows.write` scope. `{USER_ID}` is the authenticated user's ID.

**Request body (JSON):**
```json
{
  "target_user_id": "67890"
}
```

### Unfollow User
`DELETE /users/{USER_ID}/following/{TARGET_USER_ID}`

Unfollow a user. Requires `follows.write` scope.

### Like Tweet
`POST /users/{USER_ID}/likes`

Like a tweet. Requires `like.write` scope. `{USER_ID}` is the authenticated user's ID.

**Request body (JSON):**
```json
{
  "tweet_id": "1234567890"
}
```

### Unlike Tweet
`DELETE /users/{USER_ID}/likes/{TWEET_ID}`

Unlike a tweet. Requires `like.write` scope.

### Get User's Liked Tweets
`GET /users/{USER_ID}/liked_tweets`

Returns tweets liked by a user. Requires `like.read` scope.

**Query parameters:**
- `max_results` — Results per page (10-100, default 100)
- `pagination_token` — Token for next page
- `tweet.fields` — Fields to include

### Get User's Bookmarks
`GET /users/{USER_ID}/bookmarks`

Returns user's bookmarks. Requires `bookmark.read` scope.

**Query parameters:**
- `max_results` — Results per page (1-100, default 100)
- `pagination_token` — Token for next page
- `tweet.fields` — Fields to include

### Add Bookmark
`POST /users/{USER_ID}/bookmarks`

Bookmark a tweet. Requires `bookmark.write` scope.

**Request body (JSON):**
```json
{
  "tweet_id": "1234567890"
}
```

### Remove Bookmark
`DELETE /users/{USER_ID}/bookmarks/{TWEET_ID}`

Remove a bookmark. Requires `bookmark.write` scope.

### Send Direct Message
`POST /dm_conversations/with/{PARTICIPANT_ID}/messages`

Send a DM to a user. Requires `dm.write` scope.

**Request body (JSON):**
```json
{
  "text": "Hello via DM!"
}
```

### Get DM Events
`GET /dm_conversations/with/{PARTICIPANT_ID}/dm_events`

Get DMs with a specific user. Requires `dm.read` scope.

**Query parameters:**
- `max_results` — Results per page (1-100, default 100)
- `dm_event.fields` — Fields: `id`, `text`, `created_at`, `sender_id`, `dm_conversation_id`
- `pagination_token` — Token for next page

## Common Patterns

### Field Expansion System
X API v2 uses an expansion system instead of returning all data by default:
- `tweet.fields` — Additional tweet data (`created_at`, `public_metrics`, `entities`, `attachments`)
- `user.fields` — Additional user data (`description`, `profile_image_url`, `public_metrics`)
- `media.fields` — Media data (`url`, `preview_image_url`, `width`, `height`)
- `expansions` — Expand referenced objects (`author_id`, `attachments.media_keys`, `referenced_tweets.id`)

Expanded objects are returned in a top-level `includes` field (not nested in `data`).

### Pagination
Uses token-based pagination:
- Response includes `meta.next_token`
- Pass as `next_token` (tweets) or `pagination_token` (users) query parameter
- When no `next_token` in response, no more pages

### Search Query Operators
- `from:username` — Tweets from a specific user
- `to:username` — Tweets replying to a user
- `#hashtag` — Tweets with a hashtag
- `"exact phrase"` — Exact text match
- `-keyword` — Exclude keyword
- `is:retweet` / `-is:retweet` — Include/exclude retweets
- `has:media` / `has:images` / `has:videos` — Media filters
- `lang:en` — Language filter
- `conversation_id:12345` — All tweets in a conversation

### Rate Limits
Rate limits vary by endpoint and API tier:
- **Free**: 1 app, read-only (very limited)
- **Basic** ($200/month): 100 POST /tweets per user/month, 10K GET tweets/month
- **Pro** ($5000/month): 1M GET tweets/month

Response headers: `x-rate-limit-limit`, `x-rate-limit-remaining`, `x-rate-limit-reset` (Unix timestamp)

### Error Format
```json
{
  "errors": [
    {
      "message": "...",
      "type": "https://api.x.com/2/problems/...",
      "title": "Not Found Error",
      "detail": "Could not find tweet with id: [12345]",
      "status": 404
    }
  ]
}
```

## Important Notes
- **API v2 is the current version.** API v1.1 is deprecated.
- **Tweet text** is limited to 280 characters.
- The **`offline.access` scope is REQUIRED** to get a refresh token. Without it, the access token expires after ~2 hours with no way to renew.
- **PKCE** (code_challenge) is mandatory for the OAuth2 authorization flow.
- The **Free API tier** is severely limited (read-only, 1 app). Most use cases require the Basic tier ($200/month) or higher.
- **Media upload** uses a separate endpoint (`POST https://upload.x.com/2/media/upload`) — not covered by the standard API base URL.
- **User IDs** are numeric strings, not usernames. Use `/users/by/username/{username}` to resolve.
- The **`data` wrapper**: all responses wrap results in a `data` field. Lists return `data[]`, single items return `data{}`. Expanded objects are in `includes`.
