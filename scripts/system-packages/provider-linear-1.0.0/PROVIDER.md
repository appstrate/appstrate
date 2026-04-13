# Linear API

Base URL: `https://api.linear.app/graphql`

Modern issue tracking for software teams. Uses a GraphQL API exclusively. All requests are `POST /graphql` with a JSON body containing `query` and optional `variables`. Uses Relay-style pagination with `nodes`, `pageInfo.hasNextPage`, and `pageInfo.endCursor`.

## Endpoints

All queries and mutations are sent to:

`POST /graphql`

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
  viewer {
    id
    name
    email
    displayName
    organization { id name }
  }
}
```

**Response:**
```json
{
  "data": {
    "viewer": {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "name": "John Doe",
      "email": "john@example.com",
      "displayName": "John",
      "organization": { "id": "org-uuid", "name": "My Company" }
    }
  }
}
```

### List Issues
```graphql
query($first: Int, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter) {
    nodes {
      id
      identifier
      title
      description
      priority
      priorityLabel
      state { id name color }
      assignee { id name }
      team { id key name }
      project { id name }
      labels { nodes { id name color } }
      createdAt
      updatedAt
      url
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

**Variables:**
```json
{
  "first": 50,
  "filter": {
    "team": { "key": { "eq": "ENG" } },
    "state": { "name": { "eq": "In Progress" } }
  }
}
```

**Response:**
```json
{
  "data": {
    "issues": {
      "nodes": [
        {
          "id": "issue-uuid",
          "identifier": "ENG-123",
          "title": "Fix login page bug",
          "priority": 2,
          "priorityLabel": "High",
          "state": { "id": "state-uuid", "name": "In Progress", "color": "#f2c94c" },
          "assignee": { "id": "user-uuid", "name": "John Doe" },
          "team": { "id": "team-uuid", "key": "ENG", "name": "Engineering" },
          "createdAt": "2024-01-15T09:30:00.000Z",
          "url": "https://linear.app/myco/issue/ENG-123"
        }
      ],
      "pageInfo": {
        "hasNextPage": true,
        "endCursor": "WyIyMDI0LTAxLTE1VDA5OjMwOjAwLjAwMFoiXQ"
      }
    }
  }
}
```

### Get Issue by ID
```graphql
query($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    priority
    priorityLabel
    state { id name }
    assignee { id name }
    team { id key name }
    project { id name }
    comments { nodes { id body user { name } createdAt } }
    labels { nodes { id name } }
    estimate
    dueDate
    url
  }
}
```

### Create Issue
```graphql
mutation($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      title
      url
    }
  }
}
```

**Variables:**
```json
{
  "input": {
    "teamId": "team-uuid",
    "title": "Implement OAuth flow",
    "description": "Add OAuth2 support for the new integration",
    "priority": 2,
    "assigneeId": "user-uuid",
    "stateId": "state-uuid",
    "labelIds": ["label-uuid"],
    "dueDate": "2024-03-15"
  }
}
```

### Update Issue
```graphql
mutation($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      id
      identifier
      title
      state { name }
    }
  }
}
```

**Variables:**
```json
{
  "id": "issue-uuid",
  "input": {
    "stateId": "done-state-uuid",
    "priority": 3
  }
}
```

### Delete Issue
```graphql
mutation($id: String!) {
  issueDelete(id: $id) {
    success
  }
}
```

### Add Comment
```graphql
mutation($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment {
      id
      body
      user { name }
      createdAt
    }
  }
}
```

**Variables:**
```json
{
  "input": {
    "issueId": "issue-uuid",
    "body": "Looks good! Ready for review."
  }
}
```

### List Teams
```graphql
query {
  teams {
    nodes {
      id
      key
      name
      members { nodes { id name } }
    }
  }
}
```

### List Projects
```graphql
query($first: Int) {
  projects(first: $first) {
    nodes {
      id
      name
      state
      startDate
      targetDate
      teams { nodes { id key name } }
      lead { id name }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

### List Workflow States
```graphql
query {
  workflowStates {
    nodes {
      id
      name
      color
      type
      team { id key }
    }
  }
}
```

State types: `triage`, `backlog`, `unstarted`, `started`, `completed`, `cancelled`.

### List Labels
```graphql
query {
  issueLabels {
    nodes { id name color }
  }
}
```

### List Cycles (Sprints)
```graphql
query($teamId: String!) {
  team(id: $teamId) {
    cycles {
      nodes {
        id
        number
        name
        startsAt
        endsAt
        issues { nodes { id identifier title } }
      }
    }
  }
}
```

## Common Patterns

### Pagination
Relay-style. Use `first` (max 250) and `after` (cursor) parameters. Check `pageInfo.hasNextPage` and pass `pageInfo.endCursor` as `after` for the next page.

### Filtering
Issues support rich filtering:
```graphql
issues(filter: {
  team: { key: { eq: "ENG" } }
  state: { type: { in: ["started", "unstarted"] } }
  assignee: { name: { contains: "John" } }
  priority: { gte: 2 }
  createdAt: { gte: "2024-01-01T00:00:00Z" }
})
```

### Priority Levels
- `0` — No priority
- `1` — Urgent
- `2` — High
- `3` — Medium
- `4` — Low

### Error Format
```json
{
  "errors": [
    {
      "message": "Entity not found",
      "extensions": { "type": "unknown entity", "userPresentableMessage": "Issue not found" }
    }
  ]
}
```

### Rate Limits
1500 requests per hour. Complexity-based for heavy queries. Headers: `X-RateLimit-Requests-Remaining`, `X-RateLimit-Requests-Reset`.

## Important Notes
- **GraphQL only** — All requests are `POST /graphql`. No REST endpoints.
- **Markdown descriptions** — Issue descriptions use standard Markdown (unlike Jira's ADF).
- **Token refresh** — Access tokens expire after 24 hours. Rotating refresh tokens (30-minute grace period).
- **UUIDs** — All IDs are UUIDs (e.g. `a1b2c3d4-e5f6-7890-abcd-ef1234567890`).
- **Identifiers** — Issues have both `id` (UUID) and `identifier` (human-readable like `ENG-123`). API operations use `id`.
- **Scope separator** — Linear uses commas to separate scopes.
- **Team-scoped** — Issues belong to teams. Always provide `teamId` when creating issues.
