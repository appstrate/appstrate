# Trello API

Base URL: `https://api.trello.com/1`

Project management boards API. Manage boards, lists, cards, and members. Hierarchy: Member -> Board -> List -> Card.

## Endpoints

### Get Boards
`GET /1/members/me/boards`

List all boards for the authenticated user.

**Query parameters:**
- `fields` — comma-separated fields (e.g. `name,url,dateLastActivity`)
- `filter` — `all`, `open`, `closed`, `members`, `organization`, `public`, `starred`

### Get Board
`GET /1/boards/{BOARD_ID}`

**Query parameters:**
- `fields` — e.g. `name,desc,url`

### Get Lists on Board
`GET /1/boards/{BOARD_ID}/lists`

**Query parameters:**
- `fields` — e.g. `name,pos`
- `filter` — `all`, `open`, `closed`

### Get Cards on Board
`GET /1/boards/{BOARD_ID}/cards`

**Query parameters:**
- `fields` — e.g. `name,desc,idList,due,labels`
- `filter` — `all`, `open`, `closed`, `visible`

### Get Cards on List
`GET /1/lists/{LIST_ID}/cards`

**Query parameters:**
- `fields` — e.g. `name,desc,due,labels`

### Create Card
`POST /1/cards`

**Request body:**
```json
{
  "name": "New Card",
  "desc": "Description",
  "idList": "{LIST_ID}",
  "due": "2024-12-31T00:00:00.000Z",
  "idLabels": ["label-id-1", "label-id-2"],
  "pos": "bottom"
}
```

### Update Card
`PUT /1/cards/{CARD_ID}`

Update card properties (name, description, list, due date, etc.).

**Request body:**
```json
{
  "name": "Updated Card",
  "idList": "{NEW_LIST_ID}"
}
```

### Add Comment to Card
`POST /1/cards/{CARD_ID}/actions/comments`

**Request body:**
```json
{
  "text": "This is a comment"
}
```

### Get Card Actions
`GET /1/cards/{CARD_ID}/actions`

Get activity log for a card (comments, moves, etc.).

**Query parameters:**
- `filter` — e.g. `commentCard`, `updateCard`
- `limit` — max results (default 50, max 1000)

### Get Board Labels
`GET /1/boards/{BOARD_ID}/labels`

### Add Label to Card
`POST /1/cards/{CARD_ID}/idLabels`

**Request body:**
```json
{
  "value": "{LABEL_ID}"
}
```

### Search
`GET /1/search`

Search across boards and cards.

**Query parameters:**
- `query` — search text
- `modelTypes` — comma-separated: `cards`, `boards`, `organizations`, `members`
- `cards_limit`, `boards_limit` — max results per type

## Common Patterns

### Fields Parameter
Use `fields` to limit returned properties:
- Boards: `name,url,dateLastActivity,desc`
- Cards: `name,desc,idList,due,labels,pos,closed`
- Lists: `name,pos,closed`

### Pagination
Some endpoints support `limit` (max 1000) and `before`/`since` (date or action ID). Use `limit` parameter to control result count (max 1000).

### Moving Cards
Update a card's `idList` to move it between lists.

### Date Format
ISO 8601: `2024-12-31T00:00:00.000Z`

## Important Notes

- Rate limit: 100 requests per 10 seconds per token, 300 per 10 seconds per API key.
- Card positions (`pos`) are floats. To insert between cards, use a value between their positions. Use `"top"` or `"bottom"` for simple placement.
- Archived (closed) items are hidden by default. Use `filter=all` to include them.
- `/1/search` has a stricter rate limit: 100 requests per 900 seconds.
- Webhooks: `POST /1/webhooks` to register, requires `callbackURL` and `idModel`.
