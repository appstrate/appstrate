# Reddit API

Base URL: `https://oauth.reddit.com`

Social news aggregation and discussion platform. Read posts, submit content, vote, manage subreddits, and interact with the community. All authenticated API requests must go to `oauth.reddit.com` (not `www.reddit.com`).

## Endpoints

### Get My Identity
`GET /api/v1/me`

Returns the identity of the authenticated user. Requires `identity` scope.

**Response:**
```json
{
  "name": "username",
  "id": "t2_abc123",
  "created_utc": 1234567890.0,
  "link_karma": 1234,
  "comment_karma": 5678,
  "icon_img": "https://...",
  "subreddit": { "display_name": "u_username", "subscribers": 0 }
}
```

### Get Subreddit Posts (Hot)
`GET /r/{SUBREDDIT}/hot`

Returns the hot posts from a subreddit.

**Query parameters:**
- `limit` — Number of posts (1-100, default 25)
- `after` — Fullname of the post to start after (for pagination)
- `before` — Fullname of the post to start before
- `count` — Number of items already seen (for pagination)

**Response:**
```json
{
  "kind": "Listing",
  "data": {
    "after": "t3_abc123",
    "children": [
      {
        "kind": "t3",
        "data": {
          "id": "abc123",
          "name": "t3_abc123",
          "title": "Post title",
          "selftext": "Post body (markdown)",
          "author": "username",
          "subreddit": "programming",
          "score": 42,
          "num_comments": 15,
          "url": "https://...",
          "created_utc": 1234567890.0,
          "permalink": "/r/programming/comments/abc123/..."
        }
      }
    ]
  }
}
```

Other listing variants: `GET /r/{SUBREDDIT}/new`, `GET /r/{SUBREDDIT}/top`, `GET /r/{SUBREDDIT}/rising`, `GET /best`

For `/top`, add `t` parameter: `hour`, `day`, `week`, `month`, `year`, `all`

### Get Post Comments
`GET /comments/{ARTICLE_ID}`

Returns a post and its comment tree. `ARTICLE_ID` is the post ID without the `t3_` prefix.

**Query parameters:**
- `sort` — Comment sort: `confidence` (best), `top`, `new`, `controversial`, `old`, `random`, `qa`
- `limit` — Max number of comments
- `depth` — Max depth of comment tree

### Submit Post
`POST /api/submit`

Submit a new post to a subreddit. Requires `submit` scope.

**Request body (form-encoded):**
- `sr` — Subreddit name (without /r/)
- `kind` — `self` (text), `link` (URL), `image`, `video`
- `title` — Post title (required)
- `text` — Post body for self posts (markdown)
- `url` — URL for link posts
- `resubmit` — `true` to allow resubmitting a URL
- `sendreplies` — `true` to send reply notifications
- `api_type` — `json` (recommended for JSON error responses)

### Post Comment
`POST /api/comment`

Post a reply to a post or comment. Requires `submit` scope.

**Request body (form-encoded):**
- `thing_id` — Fullname of the parent (e.g. `t3_abc123` for a post, `t1_xyz789` for a comment)
- `text` — Comment text (markdown)
- `api_type` — `json`

### Vote
`POST /api/vote`

Cast a vote on a post or comment. Requires `vote` scope.

**Request body (form-encoded):**
- `id` — Fullname of the target (e.g. `t3_abc123`)
- `dir` — Vote direction: `1` (upvote), `0` (unvote), `-1` (downvote)

### Edit Post/Comment
`POST /api/editusertext`

Edit a self post or comment. Requires `edit` scope.

**Request body (form-encoded):**
- `thing_id` — Fullname of the post/comment
- `text` — New text (markdown)
- `api_type` — `json`

### Delete Post/Comment
`POST /api/del`

Delete a post or comment.

**Request body (form-encoded):**
- `id` — Fullname of the post/comment

### List My Subreddits
`GET /subreddits/mine/subscriber`

List subreddits the user is subscribed to. Requires `mysubreddits` scope.

**Query parameters:**
- `limit` — Number of results (1-100, default 25)
- `after` — Fullname for pagination

### Get Subreddit Info
`GET /r/{SUBREDDIT}/about`

Returns information about a subreddit.

**Response:**
```json
{
  "kind": "t5",
  "data": {
    "display_name": "programming",
    "title": "programming",
    "subscribers": 5000000,
    "active_user_count": 12000,
    "description": "Subreddit description (markdown)",
    "public_description": "Short description",
    "created_utc": 1234567890.0
  }
}
```

### Subscribe/Unsubscribe
`POST /api/subscribe`

Subscribe to or unsubscribe from a subreddit. Requires `subscribe` scope.

**Request body (form-encoded):**
- `sr_name` — Subreddit name
- `action` — `sub` or `unsub`

### Search
`GET /search`

Search Reddit globally.

**Query parameters:**
- `q` — Search query (required)
- `sort` — `relevance`, `hot`, `top`, `new`, `comments`
- `t` — Time filter: `hour`, `day`, `week`, `month`, `year`, `all`
- `type` — Content type: `link`, `sr` (subreddit), `user`
- `limit` — Results per page (1-100, default 25)
- `after` — Pagination cursor

### Get Messages (Inbox)
`GET /message/inbox`

Get the user's message inbox. Requires `privatemessages` scope.

**Query parameters:**
- `limit` — Number of messages (1-100)
- `after` — Pagination cursor

### Send Private Message
`POST /api/compose`

Send a private message. Requires `privatemessages` scope.

**Request body (form-encoded):**
- `to` — Recipient username
- `subject` — Message subject
- `text` — Message body (markdown)
- `api_type` — `json`

## Common Patterns

### Pagination (Listings)
Reddit uses cursor-based pagination with "fullnames" (type prefix + ID).
- `after` — Start after this item (forward pagination)
- `before` — Start before this item (backward pagination)
- `limit` — Items per page (1-100, default 25)
- `count` — Number of items already seen (helps Reddit's algorithm)

Fullname prefixes:
- `t1_` — Comment
- `t2_` — Account
- `t3_` — Link/Post
- `t4_` — Message
- `t5_` — Subreddit

### Request Format
Most POST endpoints expect `application/x-www-form-urlencoded` body, NOT JSON.
Include `api_type=json` in POST requests to get JSON error responses.

### Rate Limits
- 100 requests per minute per OAuth token
- Rate limit info in headers: `X-Ratelimit-Used`, `X-Ratelimit-Remaining`, `X-Ratelimit-Reset`

### Error Format
```json
{
  "error": 403,
  "message": "Forbidden",
  "reason": "description"
}
```

For form-based errors:
```json
{
  "json": {
    "errors": [["FIELD", "error description", "field_name"]]
  }
}
```

## Important Notes
- API requests MUST go to `https://oauth.reddit.com`, NOT `https://www.reddit.com`.
- Reddit strongly recommends a descriptive `User-Agent` header (format: `platform:app_id:version (by /u/username)`).
- Access tokens expire after **1 hour**. The `duration=permanent` authorization parameter ensures a refresh token is issued for automatic renewal.
- All content IDs ("fullnames") include a type prefix (e.g. `t3_` for posts). Always use the full name in API calls.
- Markdown is used for all text content (posts, comments, messages).
- Subreddit names are case-insensitive and used without `/r/` prefix in API calls.
- POST endpoints use `application/x-www-form-urlencoded`, not JSON.
