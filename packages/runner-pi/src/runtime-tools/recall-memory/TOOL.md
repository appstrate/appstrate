## recall_memory

Use `recall_memory({ q?, limit? })` to search the agent's archive memory store. Archive memories are durable facts and learnings written via `note({ content })` — they persist across runs but are NOT injected into the system prompt by default (only pinned memories are, and only when the platform's `## Memory` section is rendered).

- `q` — case-insensitive substring filter. Omit it to get the most recent archive entries.
- `limit` — cap on results (max 50).

Pair with `note` (from `@appstrate/note`) to write new entries: `note` saves to the archive, `recall_memory` searches it. Use `pin({ key, content })` (from `@appstrate/pin`) instead when the data must be visible on every run rather than fetched on demand.
