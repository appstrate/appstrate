# Monday.com API

Base URL: `https://api.monday.com/v2`

Work operating system with a GraphQL API. All requests are `POST /v2` with a JSON body containing `query` and optional `variables`. Responses are wrapped in `{ "data": { ... } }`.

## Endpoints

All queries and mutations are sent to:

`POST /v2`

**Headers:**
- `Content-Type: application/json`

**Body format:**
```json
{
  "query": "{ ... }",
  "variables": { ... }
}
```

### Get Current User
```graphql
query {
  me {
    id
    name
    email
    account { id name }
  }
}
```

**Response:**
```json
{
  "data": {
    "me": {
      "id": "12345678",
      "name": "John Doe",
      "email": "john@example.com",
      "account": { "id": "9876543", "name": "My Company" }
    }
  }
}
```

### List Boards
```graphql
query {
  boards(limit: 25) {
    id
    name
    state
    board_kind
    columns { id title type }
    groups { id title color }
    owners { id name }
  }
}
```

**Response:**
```json
{
  "data": {
    "boards": [
      {
        "id": "1234567890",
        "name": "Sprint Board",
        "state": "active",
        "board_kind": "public",
        "columns": [
          { "id": "name", "title": "Name", "type": "name" },
          { "id": "status", "title": "Status", "type": "color" },
          { "id": "person", "title": "Assignee", "type": "multiple-person" },
          { "id": "date4", "title": "Due Date", "type": "date" }
        ],
        "groups": [
          { "id": "topics", "title": "To Do", "color": "#579BFC" },
          { "id": "group_title", "title": "In Progress", "color": "#FDAB3D" }
        ]
      }
    ]
  }
}
```

### List Items (with pagination)
```graphql
query {
  boards(ids: [1234567890]) {
    items_page(limit: 50) {
      cursor
      items {
        id
        name
        group { id title }
        column_values {
          id
          text
          value
          type
        }
        created_at
        updated_at
      }
    }
  }
}
```

To get the next page, use the cursor:
```graphql
query {
  next_items_page(limit: 50, cursor: "MSw5NjY2NDUwMTEsaV9...") {
    cursor
    items {
      id
      name
      column_values { id text value type }
    }
  }
}
```

### Get Item by ID
```graphql
query {
  items(ids: [5566778899]) {
    id
    name
    group { id title }
    board { id name }
    column_values { id title text value type }
    subitems { id name }
    updates(limit: 5) { id text_body creator { name } created_at }
  }
}
```

### Create Item
```graphql
mutation {
  create_item(
    board_id: 1234567890
    group_id: "topics"
    item_name: "New task"
    column_values: "{\"status\": {\"label\": \"Working on it\"}, \"date4\": {\"date\": \"2024-03-15\"}, \"person\": {\"personsAndTeams\": [{\"id\": 12345, \"kind\": \"person\"}]}}"
  ) {
    id
    name
  }
}
```

### Update Column Values
```graphql
mutation {
  change_multiple_column_values(
    board_id: 1234567890
    item_id: 5566778899
    column_values: "{\"status\": {\"label\": \"Done\"}, \"date4\": {\"date\": \"2024-03-20\"}}"
  ) {
    id
    name
  }
}
```

### Move Item to Group
```graphql
mutation {
  move_item_to_group(item_id: 5566778899, group_id: "group_title") {
    id
  }
}
```

### Archive Item
```graphql
mutation {
  archive_item(item_id: 5566778899) {
    id
  }
}
```

### Delete Item
```graphql
mutation {
  delete_item(item_id: 5566778899) {
    id
  }
}
```

### Create Update (Comment)
```graphql
mutation {
  create_update(item_id: 5566778899, body: "This is a comment on the item.") {
    id
    body
    created_at
  }
}
```

### List Users
```graphql
query {
  users {
    id
    name
    email
    enabled
    is_admin
  }
}
```

### List Workspaces
```graphql
query {
  workspaces {
    id
    name
    kind
  }
}
```

### Create Board
```graphql
mutation {
  create_board(board_name: "New Board", board_kind: public) {
    id
    name
  }
}
```

### Create Group
```graphql
mutation {
  create_group(board_id: 1234567890, group_name: "New Group") {
    id
    title
  }
}
```

## Common Patterns

### Pagination
Items use cursor-based pagination. First query uses `items_page(limit: N)` which returns a `cursor`. Subsequent pages use `next_items_page(limit: N, cursor: "...")`. When `cursor` is `null`, there are no more pages. Max limit is 500.

### Column Values Format
Column values in mutations use a JSON string. Each column type has its own format:
- **Status**: `{"label": "Done"}` or `{"index": 1}`
- **Date**: `{"date": "2024-03-15"}`
- **Person**: `{"personsAndTeams": [{"id": 12345, "kind": "person"}]}`
- **Text**: `"Simple text value"`
- **Number**: `"42"`
- **Email**: `{"email": "john@example.com", "text": "John"}`
- **Link**: `{"url": "https://example.com", "text": "Example"}`

### Complexity & Rate Limits
Monday.com uses complexity-based rate limiting instead of request counting. Each query has a complexity cost based on the data requested. Standard accounts: 5,000,000 complexity points per minute. Check complexity in responses:
```json
{
  "data": { ... },
  "account_id": 12345,
  "complexity": { "before": 4999900, "query": 100, "after": 4999800 }
}
```

### Error Format
```json
{
  "errors": [
    {
      "message": "Field 'invalid_field' doesn't exist on type 'Item'",
      "locations": [{ "line": 3, "column": 5 }]
    }
  ],
  "account_id": 12345
}
```

## Important Notes
- **GraphQL only** — All requests are `POST /v2` with a GraphQL query body. No REST endpoints.
- **No refresh token** — Access tokens are permanent (no expiration). Token is revoked only manually.
- **Column values as JSON strings** — Mutations require `column_values` as a stringified JSON object, not a native JSON object.
- **Column IDs** — Columns are referenced by their `id` (e.g. `status`, `date4`, `person`). Use the board query to discover column IDs.
- **Board kinds** — `public` (visible to all), `private` (invite only), `share` (shareable).
- **Subitems** — Items can have subitems (subtasks). Query them with `subitems { id name }`.
