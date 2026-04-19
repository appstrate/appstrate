# LinkedIn API

Base URL: `https://api.linkedin.com/v2`

Professional networking platform API. Post content, read profiles, manage company pages, and access ads analytics. Uses REST-Li 2.0 protocol. Most write operations require Partner verification.

## Important: Headers

All requests should include:
- `Authorization: Bearer {access_token}` (injected automatically by the sidecar)
- `X-Restli-Protocol-Version: 2.0.0` (required for many endpoints)
- `Content-Type: application/json`

## Important: URN Format

LinkedIn uses URN (Uniform Resource Name) format for IDs:
- Person: `urn:li:person:{id}`
- Organization: `urn:li:organization:{id}`
- UGC Post: `urn:li:ugcPost:{id}`
- Share: `urn:li:share:{id}`

URNs must be URL-encoded when used in URL paths: `urn:li:ugcPost:12345` → `urn%3Ali%3AugcPost%3A12345`

## Endpoints

### Get My Profile
`GET /me`

Returns the authenticated user's profile.

**Query parameters:**
- `projection` — Fields to return: `(id,firstName,lastName,profilePicture(displayImage~:playableStreams))`

**Response:**
```json
{
  "id": "ABC123def",
  "localizedFirstName": "John",
  "localizedLastName": "Doe",
  "profilePicture": {
    "displayImage~": {
      "elements": [
        {
          "identifiers": [{ "identifier": "https://media.licdn.com/..." }]
        }
      ]
    }
  }
}
```

### Get My Email
`GET /emailAddress?q=members&projection=(elements*(handle~))`

Returns the user's primary email. Requires `email` scope.

**Response:**
```json
{
  "elements": [
    {
      "handle~": { "emailAddress": "john@example.com" },
      "handle": "urn:li:emailAddress:1234567890"
    }
  ]
}
```

### Create Text Post
`POST /ugcPosts`

Create a post on the user's feed. Requires `w_member_social` scope.

**Request body (JSON):**
```json
{
  "author": "urn:li:person:{PERSON_ID}",
  "lifecycleState": "PUBLISHED",
  "specificContent": {
    "com.linkedin.ugc.ShareContent": {
      "shareCommentary": {
        "text": "Excited to share our latest product launch! 🚀"
      },
      "shareMediaCategory": "NONE"
    }
  },
  "visibility": {
    "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
  }
}
```

### Create Post with Image
`POST /ugcPosts`

Two-step process: upload media first, then create post.

**Step 1: Register upload**
`POST /assets?action=registerUpload`

```json
{
  "registerUploadRequest": {
    "recipes": ["urn:li:digitalmediaRecipe:feedshare-image"],
    "owner": "urn:li:person:{PERSON_ID}",
    "serviceRelationships": [
      { "relationshipType": "OWNER", "identifier": "urn:li:userGeneratedContent" }
    ]
  }
}
```

Response contains `value.uploadMechanism...uploadUrl` and `value.asset` (URN).

**Step 2: Upload binary**
`PUT {uploadUrl}` with `Content-Type: application/octet-stream` and image bytes as body.

**Step 3: Create post** with `shareMediaCategory: "IMAGE"` and the asset URN in `media[].media`:

```json
{
  "author": "urn:li:person:{PERSON_ID}",
  "lifecycleState": "PUBLISHED",
  "specificContent": {
    "com.linkedin.ugc.ShareContent": {
      "shareCommentary": { "text": "Check out this image!" },
      "shareMediaCategory": "IMAGE",
      "media": [
        {
          "status": "READY",
          "media": "urn:li:digitalmediaAsset:ABC123"
        }
      ]
    }
  },
  "visibility": {
    "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
  }
}
```

### Create Post on Company Page
`POST /ugcPosts`

Same as personal post, but `author` is `urn:li:organization:{ORG_ID}`. Requires `w_organization_social` scope.

### Delete Post
`DELETE /ugcPosts/{UGC_POST_URN}`

URL-encode the URN: `/ugcPosts/urn%3Ali%3AugcPost%3A12345`

### Get Organization Info
`GET /organizations/{ORG_ID}`

Returns company page details. Requires `r_organization_social` scope.

**Query parameters:**
- `projection` — `(id,localizedName,vanityName,logoV2(original~:playableStreams),description,staffCountRange,followerCount,website)`

### Get Organization Follower Stats
`GET /organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=urn:li:organization:{ORG_ID}`

Returns follower count and demographics for a company page.

### Get Post Comments
`GET /socialActions/{ACTIVITY_URN}/comments`

Returns comments on a post.

**Query parameters:**
- `start` — Offset (0-indexed)
- `count` — Items per page (default 10, max 100)

### Post Comment
`POST /socialActions/{ACTIVITY_URN}/comments`

Post a comment on a post.

**Request body (JSON):**
```json
{
  "actor": "urn:li:person:{PERSON_ID}",
  "message": {
    "text": "Great post!"
  }
}
```

### Get Post Likes
`GET /socialActions/{ACTIVITY_URN}/likes`

Returns the list of likes on a post.

**Query parameters:**
- `start` — Offset (0-indexed)
- `count` — Items per page (default 10, max 100)

## Common Patterns

### Media Upload Flow
1. `POST /assets?action=registerUpload` → get `uploadUrl` + `asset` URN
2. `PUT {uploadUrl}` with binary data (`Content-Type: application/octet-stream`)
3. Use `asset` URN in post creation

Media specs:
- Images: JPG, PNG, GIF — max 8 MB
- Videos: MP4, MOV — max 5 GB, max 15 min
- Documents: PDF, PPT, DOC — max 100 MB

### Pagination
LinkedIn uses offset-based pagination:
- `start` — Starting index (0-based)
- `count` — Items per page
- Response includes `paging.start`, `paging.count`, `paging.total`

### Rate Limits
LinkedIn has very low daily rate limits. Cache aggressively.
- Profile API: 100 requests/day per app
- UGC Posts: 50 posts/day per app
- Company Admin: 500 requests/day per app
- Ads API: 100 requests/minute
- Headers: `X-Restli-Quota-Remaining`, `X-Restli-Quota-Reset`

### Error Format
```json
{
  "status": 403,
  "serviceErrorCode": 100,
  "code": "ACCESS_DENIED",
  "message": "Not enough permissions to access..."
}
```

## Important Notes
- **Refresh tokens** — LinkedIn supports programmatic refresh tokens for approved Marketing Developer Platform (MDP) partners. If the app is not approved for that program, users will need to re-authenticate when the access token expires.
- **Partner verification required** — Most write permissions (`w_member_social`, `w_organization_social`, `rw_ads`) require LinkedIn Partner verification. Apply via the Products tab in your app settings.
- **REST-Li protocol** — Always include `X-Restli-Protocol-Version: 2.0.0` header in requests.
- **URN format** — All entity references use URNs (`urn:li:person:ABC`). URL-encode URNs when used in URL paths.
- **Post editing not supported** — LinkedIn does not support editing published posts via API. Delete and re-create instead.
- **Connections API removed** — LinkedIn removed access to connections data for most apps (privacy changes).
- **Daily rate limits** — LinkedIn has very low rate limits (100-500 requests/day). Plan for aggressive caching.
- **Person ID** — Get the authenticated user's person ID from `GET /me` (the `id` field). Use it in URNs for posting.
