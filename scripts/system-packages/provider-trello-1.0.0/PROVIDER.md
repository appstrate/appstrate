# Trello API

Base URL: `https://api.trello.com/1`

## Quick Reference

Project management boards API. Manage boards, lists, cards, and members.
Hierarchy: Member -> Board -> List -> Card.

Authentication: Trello uses OAuth1. The sidecar provides `consumer_key` and `access_token` as credential fields. Pass them as query parameters `key` and `token`.

## Key Endpoints

### Get Boards
GET /members/me/boards
List all boards for the authenticated user.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: trello" \
  -H "X-Target: https://api.trello.com/1/members/me/boards?key={{consumer_key}}&token={{access_token}}&fields=name,url,dateLastActivity"
```

### Get Board
GET /boards/{id}
Get a specific board with details.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: trello" \
  -H "X-Target: https://api.trello.com/1/boards/{BOARD_ID}?key={{consumer_key}}&token={{access_token}}&fields=name,desc,url"
```

### Get Lists on Board
GET /boards/{id}/lists
Get all lists on a board.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: trello" \
  -H "X-Target: https://api.trello.com/1/boards/{BOARD_ID}/lists?key={{consumer_key}}&token={{access_token}}&fields=name,pos"
```

### Get Cards on Board
GET /boards/{id}/cards
Get all cards on a board.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: trello" \
  -H "X-Target: https://api.trello.com/1/boards/{BOARD_ID}/cards?key={{consumer_key}}&token={{access_token}}&fields=name,desc,idList,due,labels"
```

### Get Cards on List
GET /lists/{id}/cards
Get all cards in a specific list.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: trello" \
  -H "X-Target: https://api.trello.com/1/lists/{LIST_ID}/cards?key={{consumer_key}}&token={{access_token}}&fields=name,desc,due,labels"
```

### Create Card
POST /cards
Create a new card on a list.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: trello" \
  -H "X-Target: https://api.trello.com/1/cards?key={{consumer_key}}&token={{access_token}}" \
  -H "Content-Type: application/json" \
  -d '{"name": "New Card", "desc": "Description", "idList": "{LIST_ID}", "due": "2024-12-31T00:00:00.000Z"}'
```

### Update Card
PUT /cards/{id}
Update card properties (name, description, list, due date, etc.).

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X PUT \
  -H "X-Provider: trello" \
  -H "X-Target: https://api.trello.com/1/cards/{CARD_ID}?key={{consumer_key}}&token={{access_token}}" \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated Card", "idList": "{NEW_LIST_ID}"}'
```

### Add Comment to Card
POST /cards/{id}/actions/comments
Add a comment to a card.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: trello" \
  -H "X-Target: https://api.trello.com/1/cards/{CARD_ID}/actions/comments?key={{consumer_key}}&token={{access_token}}" \
  -H "Content-Type: application/json" \
  -d '{"text": "Comment from Appstrate"}'
```

### Get Card Actions
GET /cards/{id}/actions
Get activity log for a card (comments, moves, etc.).

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: trello" \
  -H "X-Target: https://api.trello.com/1/cards/{CARD_ID}/actions?key={{consumer_key}}&token={{access_token}}&filter=commentCard"
```

## Common Patterns

### Fields Parameter
Use `fields` to limit returned properties:
- Boards: `name,url,dateLastActivity,desc`
- Cards: `name,desc,idList,due,labels,pos,closed`
- Lists: `name,pos,closed`

### Pagination
Some endpoints support `limit` (max 1000) and `before`/`since` (date or action ID).
Cards default to max 50 per request on list endpoints.

### Moving Cards
Update a card's `idList` to move it between lists:
`PUT /cards/{id}?idList={newListId}`

### Labels
Labels are board-scoped. Get with `GET /boards/{id}/labels`.
Add to card: `POST /cards/{id}/idLabels?value={labelId}`.

### Search
GET /search?query={text}&modelTypes=cards,boards
Search across boards and cards.

## Important Notes

- Auth uses query params `key` (consumer_key) and `token` (access_token), not headers.
- Rate limit: 100 requests per 10 seconds per token, 300 per 10 seconds per API key.
- Card positions (`pos`) are floats. To move between cards, use a value between their positions.
- Archived (closed) items are hidden by default. Use `filter=all` to include them.
- Webhooks: POST /webhooks to register, requires `callbackURL` and `idModel`.