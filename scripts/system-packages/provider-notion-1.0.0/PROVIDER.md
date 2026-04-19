# Notion API

Base URL: `https://api.notion.com/v1`

Workspace API for pages, databases, and blocks. All requests require a `Notion-Version` header. This package documents `2022-06-28` for compatibility with the current provider surface, but Notion periodically advances the latest supported version and integrations should verify the current version in the official docs.

## Endpoints

### Search
`POST /search`

Search pages and databases by title.

**Request body:**
```json
{
  "query": "Meeting Notes",
  "filter": { "property": "object", "value": "page" },
  "sort": { "direction": "descending", "timestamp": "last_edited_time" },
  "page_size": 10,
  "start_cursor": "..."
}
```

`filter.value` can be `"page"` or `"database"`. Omit `filter` to search both.

### Query Database
`POST /databases/{DATABASE_ID}/query`

Query a database with filters and sorts.

**Request body:**
```json
{
  "filter": {
    "property": "Status",
    "select": { "equals": "Done" }
  },
  "sorts": [
    { "property": "Due Date", "direction": "ascending" }
  ],
  "page_size": 100,
  "start_cursor": "..."
}
```

**Response:**
```json
{
  "results": [
    {
      "id": "...",
      "object": "page",
      "properties": {
        "Name": { "title": [{ "text": { "content": "Task title" } }] },
        "Status": { "select": { "name": "Done" } }
      }
    }
  ],
  "has_more": true,
  "next_cursor": "..."
}
```

### Get Database Schema
`GET /databases/{DATABASE_ID}`

Retrieve database metadata and property definitions. Use this to discover the schema before querying.

### Get Page
`GET /pages/{PAGE_ID}`

Retrieve page properties (not content — use blocks for content).

### Get Page Content (Blocks)
`GET /blocks/{PAGE_ID}/children`

Retrieve the content blocks of a page. The page ID is used as the block_id.

**Query parameters:**
- `page_size` — Max blocks to return (max 100)
- `start_cursor` — Pagination cursor

**Response:**
```json
{
  "results": [
    {
      "id": "...",
      "type": "paragraph",
      "paragraph": {
        "rich_text": [{ "type": "text", "text": { "content": "Hello world" } }]
      }
    }
  ],
  "has_more": false,
  "next_cursor": null
}
```

### Create Page
`POST /pages`

Create a new page in a database or as a child of another page.

**Request body (in a database):**
```json
{
  "parent": { "database_id": "{DATABASE_ID}" },
  "properties": {
    "Name": { "title": [{ "text": { "content": "New Entry" } }] },
    "Status": { "select": { "name": "To Do" } },
    "Priority": { "number": 1 }
  }
}
```

**Request body (as a child page):**
```json
{
  "parent": { "page_id": "{PARENT_PAGE_ID}" },
  "properties": {
    "title": { "title": [{ "text": { "content": "Sub Page" } }] }
  },
  "children": [
    { "object": "block", "type": "paragraph", "paragraph": { "rich_text": [{ "type": "text", "text": { "content": "Page content" } }] } }
  ]
}
```

### Update Page Properties
`PATCH /pages/{PAGE_ID}`

Update page properties or archive a page.

**Request body:**
```json
{
  "properties": {
    "Status": { "select": { "name": "Done" } }
  }
}
```

To archive: `{ "archived": true }`

### Append Blocks
`PATCH /blocks/{PAGE_ID}/children`

Add content blocks to a page.

**Request body:**
```json
{
  "children": [
    {
      "object": "block",
      "type": "paragraph",
      "paragraph": {
        "rich_text": [{ "type": "text", "text": { "content": "New paragraph" } }]
      }
    },
    {
      "object": "block",
      "type": "heading_2",
      "heading_2": {
        "rich_text": [{ "type": "text", "text": { "content": "Section Title" } }]
      }
    }
  ]
}
```

### Update Block
`PATCH /blocks/{BLOCK_ID}`

Update an existing block's content.

### Delete Block
`DELETE /blocks/{BLOCK_ID}`

Delete (archive) a block.

## Common Patterns

### Pagination
Responses include `has_more` and `next_cursor`. Pass `start_cursor` in the next request. Max `page_size` is 100.

### Property Types (for setting values)
- **Title**: `{ "title": [{ "text": { "content": "value" } }] }`
- **Rich text**: `{ "rich_text": [{ "text": { "content": "value" } }] }`
- **Select**: `{ "select": { "name": "Option" } }`
- **Multi-select**: `{ "multi_select": [{ "name": "Tag1" }, { "name": "Tag2" }] }`
- **Number**: `{ "number": 42 }`
- **Date**: `{ "date": { "start": "2024-01-01", "end": "2024-01-31" } }`
- **Checkbox**: `{ "checkbox": true }`
- **URL**: `{ "url": "https://example.com" }`
- **Email**: `{ "email": "user@example.com" }`
- **People**: `{ "people": [{ "id": "{USER_ID}" }] }`
- **Relation**: `{ "relation": [{ "id": "{PAGE_ID}" }] }`

### Filter Syntax (for database queries)
Filters vary by property type:
- **Text**: `{ "property": "Name", "rich_text": { "contains": "search" } }`
- **Select**: `{ "property": "Status", "select": { "equals": "Done" } }`
- **Multi-select**: `{ "property": "Tags", "multi_select": { "contains": "Important" } }`
- **Number**: `{ "property": "Priority", "number": { "greater_than": 3 } }`
- **Date**: `{ "property": "Due", "date": { "on_or_before": "2024-12-31" } }`
- **Checkbox**: `{ "property": "Done", "checkbox": { "equals": true } }`
- **Compound**: `{ "and": [filter1, filter2] }` or `{ "or": [filter1, filter2] }`

### Block Types
Common block types: `paragraph`, `heading_1`, `heading_2`, `heading_3`, `bulleted_list_item`, `numbered_list_item`, `to_do`, `toggle`, `code`, `quote`, `divider`, `callout`, `image`, `table`.

## Important Notes

- Always include the `Notion-Version: 2022-06-28` header on every request.
- Pages and databases must be shared with the integration to be accessible.
- IDs accept both formats: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` or `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` (with or without hyphens).
- Rate limit: 3 requests/second per integration.
- Append block children has a limit of 100 blocks per request.
- Block children are not recursive — nested blocks (e.g. children of a toggle) require separate `GET /blocks/{BLOCK_ID}/children` requests.
- Page content (text, images, etc.) is stored as blocks, not in page properties. To read a page's content, you must fetch its blocks.
