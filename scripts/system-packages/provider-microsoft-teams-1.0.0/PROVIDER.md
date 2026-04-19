# Microsoft Teams API

Base URL: `https://graph.microsoft.com/v1.0`

Microsoft Teams API via Microsoft Graph for managing teams, channels, chats, and messages. Supports OData query parameters for filtering and field selection. Some operations require admin consent.

## Endpoints

### Get Current User
`GET /me`

Returns the authenticated user's profile.

**Response:**
```json
{
  "id": "48d31887-5fad-4d73-a9f5-3c356e68a038",
  "displayName": "John Doe",
  "mail": "john@contoso.com",
  "userPrincipalName": "john@contoso.com"
}
```

### List Joined Teams
`GET /me/joinedTeams`

Returns teams the current user is a member of. Requires `Team.ReadBasic.All` scope.

**Response:**
```json
{
  "value": [
    {
      "id": "13be6971-79db-4f33-9d41-b25589ca25af",
      "displayName": "Engineering",
      "description": "Engineering team workspace",
      "isArchived": false
    }
  ]
}
```

### Get Team
`GET /teams/{teamId}`

Returns details for a specific team.

**Response:**
```json
{
  "id": "13be6971-79db-4f33-9d41-b25589ca25af",
  "displayName": "Engineering",
  "description": "Engineering team workspace",
  "isArchived": false,
  "memberSettings": { "allowCreateUpdateChannels": true },
  "messagingSettings": { "allowUserEditMessages": true },
  "webUrl": "https://teams.microsoft.com/l/team/..."
}
```

### List Channels
`GET /teams/{teamId}/channels`

Returns channels in a team. Requires `Channel.ReadBasic.All` scope.

**Response:**
```json
{
  "value": [
    {
      "id": "19:561ebfb2256f4b6585c4e36e2aaeb9cc@thread.tacv2",
      "displayName": "General",
      "description": "General discussion",
      "membershipType": "standard"
    },
    {
      "id": "19:82abc123@thread.tacv2",
      "displayName": "Frontend",
      "description": "Frontend development",
      "membershipType": "standard"
    }
  ]
}
```

### List Channel Messages
`GET /teams/{teamId}/channels/{channelId}/messages`

Returns messages in a channel. Requires `ChannelMessage.Read.All` scope.

**Query parameters:**
- `$top` — Messages per page (default 20, max 50)

**Response:**
```json
{
  "value": [
    {
      "id": "1616990032035",
      "messageType": "message",
      "createdDateTime": "2024-06-15T10:30:00.000Z",
      "from": {
        "user": {
          "id": "48d31887-...",
          "displayName": "John Doe"
        }
      },
      "body": {
        "contentType": "html",
        "content": "<p>Hey team, the release is scheduled for Friday.</p>"
      },
      "attachments": [],
      "reactions": []
    }
  ],
  "@odata.nextLink": "https://graph.microsoft.com/v1.0/teams/.../messages?$skiptoken=..."
}
```

### Send Channel Message
`POST /teams/{teamId}/channels/{channelId}/messages`

Posts a message to a channel. Requires `ChannelMessage.Send` scope.

**Request body (JSON):**
```json
{
  "body": {
    "contentType": "html",
    "content": "<p>The deployment is complete! 🚀</p>"
  }
}
```

### List Chats
`GET /me/chats`

Returns the user's chats. Requires `Chat.Read` scope.

**Query parameters:**
- `$top` — Chats per page (default 20, max 50)
- `$expand` — Expand related resources (e.g. `members`)

**Response:**
```json
{
  "value": [
    {
      "id": "19:abc123@thread.v2",
      "topic": "Project Alpha",
      "chatType": "group",
      "createdDateTime": "2024-06-10T08:00:00.000Z",
      "lastUpdatedDateTime": "2024-06-15T10:30:00.000Z"
    }
  ]
}
```

### List Chat Messages
`GET /chats/{chatId}/messages`

Returns messages in a chat. Requires `Chat.Read` scope.

**Query parameters:**
- `$top` — Messages per page (default 20, max 50)

### Send Chat Message
`POST /chats/{chatId}/messages`

Sends a message in a chat. Requires `ChatMessage.Send` scope.

**Request body (JSON):**
```json
{
  "body": {
    "contentType": "text",
    "content": "Hi Alice, can you review the PR?"
  }
}
```

### List Team Members
`GET /teams/{teamId}/members`

Returns members of a team.

**Response:**
```json
{
  "value": [
    {
      "id": "abc-123",
      "displayName": "John Doe",
      "email": "john@contoso.com",
      "roles": ["owner"]
    },
    {
      "id": "def-456",
      "displayName": "Alice Martin",
      "email": "alice@contoso.com",
      "roles": ["member"]
    }
  ]
}
```

## Common Patterns

### Pagination
Cursor-based pagination with `@odata.nextLink`:
- Response includes `@odata.nextLink` URL for next page
- Follow the URL directly (includes all params)
- When no `@odata.nextLink`, no more pages
- Use `$top` to control page size

### OData Query Parameters
- `$select` — Choose fields: `$select=displayName,description`
- `$filter` — Filter results (limited support for Teams endpoints)
- `$expand` — Expand related resources: `$expand=members`
- `$top` — Page size
- `$orderby` — Sort (limited support)

### Error Format
```json
{
  "error": {
    "code": "Forbidden",
    "message": "You do not have permission to perform this action.",
    "innerError": {
      "date": "2024-06-15T10:30:00",
      "request-id": "abc123-def456"
    }
  }
}
```

## Important Notes
- `offline_access` scope is required for refresh tokens.
- Channel IDs use the format `19:{hash}@thread.tacv2`.
- Some Teams permissions require **admin consent** (e.g. `ChannelMessage.Read.All`). Admin must approve in Azure portal.
- Message body supports `text` or `html` content types.
- `chatType` values: `oneOnOne`, `group`, `meeting`.
- Rate limit: 10,000 requests per 10 minutes per app per tenant.
- To mention a user in a message, use `<at id="0">John</at>` in HTML body and include `mentions` array.
- Teams API requires a Microsoft 365 organizational account (not personal Microsoft accounts).
