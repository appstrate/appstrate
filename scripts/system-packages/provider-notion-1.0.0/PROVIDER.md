# Notion API

Base URL: `https://api.notion.com/v1`

## Quick Reference

Workspace API for pages, databases, and blocks. All requests require `Notion-Version` header.
Current version: `2022-06-28`.

## Key Endpoints

### Search
POST /search
Search pages and databases by title.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: notion" \
  -H "X-Target: https://api.notion.com/v1/search" \
  -H "Authorization: Bearer {{token}}" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"query": "Meeting Notes", "filter": {"property": "object", "value": "page"}, "page_size": 10}'
```

### Query Database
POST /databases/{database_id}/query
Query a database with filters and sorts.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: notion" \
  -H "X-Target: https://api.notion.com/v1/databases/{DATABASE_ID}/query" \
  -H "Authorization: Bearer {{token}}" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"filter": {"property": "Status", "select": {"equals": "Done"}}, "page_size": 10}'
```

### Get Page
GET /pages/{page_id}
Retrieve page properties (not content -- use blocks for content).

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: notion" \
  -H "X-Target: https://api.notion.com/v1/pages/{PAGE_ID}" \
  -H "Authorization: Bearer {{token}}" \
  -H "Notion-Version: 2022-06-28"
```

### Get Page Content (Blocks)
GET /blocks/{block_id}/children
Retrieve the content blocks of a page. The page ID is used as block_id.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: notion" \
  -H "X-Target: https://api.notion.com/v1/blocks/{PAGE_ID}/children?page_size=100" \
  -H "Authorization: Bearer {{token}}" \
  -H "Notion-Version: 2022-06-28"
```

### Create Page
POST /pages
Create a new page in a database or as a child of another page.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: notion" \
  -H "X-Target: https://api.notion.com/v1/pages" \
  -H "Authorization: Bearer {{token}}" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"parent": {"database_id": "{DATABASE_ID}"}, "properties": {"Name": {"title": [{"text": {"content": "New Entry"}}]}, "Status": {"select": {"name": "To Do"}}}}'
```

### Update Page Properties
PATCH /pages/{page_id}
Update page properties (or archive a page).

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X PATCH \
  -H "X-Provider: notion" \
  -H "X-Target: https://api.notion.com/v1/pages/{PAGE_ID}" \
  -H "Authorization: Bearer {{token}}" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"properties": {"Status": {"select": {"name": "Done"}}}}'
```

### Append Blocks
PATCH /blocks/{block_id}/children
Add content blocks to a page.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X PATCH \
  -H "X-Provider: notion" \
  -H "X-Target: https://api.notion.com/v1/blocks/{PAGE_ID}/children" \
  -H "Authorization: Bearer {{token}}" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"children": [{"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"type": "text", "text": {"content": "Hello from Appstrate!"}}]}}]}'
```

### Get Database Schema
GET /databases/{database_id}
Retrieve database schema (property definitions).

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: notion" \
  -H "X-Target: https://api.notion.com/v1/databases/{DATABASE_ID}" \
  -H "Authorization: Bearer {{token}}" \
  -H "Notion-Version: 2022-06-28"
```

## Common Patterns

### Pagination
Responses include `has_more` and `next_cursor`. Pass `start_cursor` in the next request.
Max `page_size` is 100.

### Property Types
Database properties vary by type. Common patterns:
- Title: `{"title": [{"text": {"content": "value"}}]}`
- Rich text: `{"rich_text": [{"text": {"content": "value"}}]}`
- Select: `{"select": {"name": "Option"}}`
- Multi-select: `{"multi_select": [{"name": "Tag1"}, {"name": "Tag2"}]}`
- Number: `{"number": 42}`
- Date: `{"date": {"start": "2024-01-01"}}`
- Checkbox: `{"checkbox": true}`

### Filter Syntax
Filters vary by property type:
- Text: `{"property": "Name", "rich_text": {"contains": "search"}}`
- Select: `{"property": "Status", "select": {"equals": "Done"}}`
- Date: `{"property": "Due", "date": {"on_or_before": "2024-12-31"}}`
- Compound: `{"and": [filter1, filter2]}` or `{"or": [filter1, filter2]}`

## Important Notes

- Always include `Notion-Version: 2022-06-28` header.
- Pages and databases must be shared with the integration to be accessible.
- IDs can use either format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` or `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.
- Rate limit: 3 requests/second per integration.
- Block children are not recursive -- nested blocks require separate requests per block.
- Page content (text, images, etc.) is stored as blocks, not in page properties.