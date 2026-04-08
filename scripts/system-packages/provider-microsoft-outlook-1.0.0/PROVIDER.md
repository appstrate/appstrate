# Microsoft Outlook API

Base URL: `https://graph.microsoft.com/v1.0`

Microsoft Graph Mail API for reading, sending, and managing emails. Uses the Microsoft Graph unified endpoint. Supports OData query parameters for filtering, sorting, and field selection.

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
  "userPrincipalName": "john@contoso.com",
  "jobTitle": "Software Engineer",
  "officeLocation": "Paris"
}
```

### List Messages
`GET /me/messages`

Returns messages from the user's mailbox. Requires `Mail.Read` scope.

**Query parameters:**
- `$top` — Number of items per page (default 10, max 1000)
- `$skip` — Number of items to skip
- `$select` — Comma-separated fields to return (e.g. `subject,from,receivedDateTime`)
- `$filter` — OData filter (e.g. `isRead eq false`)
- `$orderby` — Sort field and direction (e.g. `receivedDateTime desc`)
- `$search` — Search query in KQL format (e.g. `"subject:invoice"`)
- `$count` — Include total count (`true`)

**Response:**
```json
{
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#users('...')/messages",
  "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skip=10",
  "value": [
    {
      "id": "AAMkAGI2TG93AAA=",
      "subject": "Project Update",
      "bodyPreview": "Hi team, here's the latest update...",
      "from": {
        "emailAddress": {
          "name": "Alice Martin",
          "address": "alice@contoso.com"
        }
      },
      "toRecipients": [
        {
          "emailAddress": {
            "name": "John Doe",
            "address": "john@contoso.com"
          }
        }
      ],
      "receivedDateTime": "2024-06-15T10:30:00Z",
      "isRead": false,
      "hasAttachments": true,
      "importance": "normal",
      "flag": { "flagStatus": "notFlagged" }
    }
  ]
}
```

### Get Message
`GET /me/messages/{messageId}`

Returns a single message by ID.

**Query parameters:**
- `$select` — Fields to return

### Send Mail
`POST /me/sendMail`

Sends an email. Requires `Mail.Send` scope.

**Request body (JSON):**
```json
{
  "message": {
    "subject": "Meeting Tomorrow",
    "body": {
      "contentType": "HTML",
      "content": "<p>Hi Alice,</p><p>Reminder about our meeting tomorrow at 2pm.</p>"
    },
    "toRecipients": [
      {
        "emailAddress": {
          "address": "alice@contoso.com"
        }
      }
    ],
    "ccRecipients": [],
    "importance": "normal"
  },
  "saveToSentItems": true
}
```

### Create Draft
`POST /me/messages`

Creates a draft message. Requires `Mail.ReadWrite` scope.

**Request body (JSON):**
```json
{
  "subject": "Draft: Q3 Report",
  "body": {
    "contentType": "Text",
    "content": "Draft content here..."
  },
  "toRecipients": [
    {
      "emailAddress": {
        "address": "bob@contoso.com"
      }
    }
  ]
}
```

### Update Message
`PATCH /me/messages/{messageId}`

Updates a message (mark as read, flag, move to folder). Requires `Mail.ReadWrite` scope.

**Request body (JSON):**
```json
{
  "isRead": true,
  "flag": { "flagStatus": "flagged" },
  "categories": ["Red Category"]
}
```

### Delete Message
`DELETE /me/messages/{messageId}`

Moves a message to Deleted Items folder. Requires `Mail.ReadWrite` scope.

### Reply to Message
`POST /me/messages/{messageId}/reply`

Replies to a message. Requires `Mail.Send` scope.

**Request body (JSON):**
```json
{
  "message": {
    "toRecipients": [
      {
        "emailAddress": {
          "address": "alice@contoso.com"
        }
      }
    ]
  },
  "comment": "Thanks for the update, Alice!"
}
```

### List Mail Folders
`GET /me/mailFolders`

Returns all mail folders.

**Response:**
```json
{
  "value": [
    {
      "id": "AAMkAGI2...",
      "displayName": "Inbox",
      "parentFolderId": "AAMkAGI2...",
      "childFolderCount": 2,
      "unreadItemCount": 5,
      "totalItemCount": 42
    }
  ]
}
```

### List Messages in Folder
`GET /me/mailFolders/{folderId}/messages`

Returns messages in a specific folder. Same query parameters as List Messages.

### Move Message
`POST /me/messages/{messageId}/move`

Moves a message to a different folder. Requires `Mail.ReadWrite` scope.

**Request body (JSON):**
```json
{
  "destinationId": "AAMkAGI2..."
}
```

### List Attachments
`GET /me/messages/{messageId}/attachments`

Returns attachments for a message.

**Response:**
```json
{
  "value": [
    {
      "@odata.type": "#microsoft.graph.fileAttachment",
      "id": "AAMkAGI2...",
      "name": "report.pdf",
      "contentType": "application/pdf",
      "size": 45678,
      "contentBytes": "<base64-encoded>"
    }
  ]
}
```

## Common Patterns

### Pagination
Offset-based pagination with `@odata.nextLink`:
- Response includes `@odata.nextLink` URL for next page
- Follow the URL directly (includes all query params)
- When no `@odata.nextLink`, no more pages
- Use `$top` to control page size

### OData Query Parameters
- `$select` — Choose specific fields: `$select=subject,from,receivedDateTime`
- `$filter` — Filter results: `$filter=isRead eq false`
- `$orderby` — Sort: `$orderby=receivedDateTime desc`
- `$search` — KQL search: `$search="subject:invoice"`
- `$top` — Page size
- `$skip` — Skip items (offset)
- `$count=true` — Include total count in response

### Error Format
```json
{
  "error": {
    "code": "ErrorItemNotFound",
    "message": "The specified object was not found in the store.",
    "innerError": {
      "date": "2024-06-15T10:30:00",
      "request-id": "abc123-def456"
    }
  }
}
```

## Important Notes
- `offline_access` scope is required to get refresh tokens — without it, tokens expire after ~1 hour with no renewal.
- Message body can be `Text` or `HTML` (set `contentType` accordingly).
- The `/common` tenant endpoint works for both personal Microsoft accounts and organizational accounts.
- Use `$select` to reduce response size — full messages with body and attachments can be very large.
- Well-known folder names can be used as IDs: `inbox`, `drafts`, `sentitems`, `deleteditems`, `junkemail`.
- Rate limit: 10,000 API requests per 10 minutes per app per mailbox.
- Large attachments (>3MB): use upload sessions via `POST /me/messages/{id}/attachments/createUploadSession`.
