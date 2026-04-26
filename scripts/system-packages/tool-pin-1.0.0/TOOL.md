## Pin

Use the `pin` tool to upsert a named slot rendered into the system prompt on every run. Last-write-wins per `(scope, key)` — the most recent call fully replaces the previous value. Design each pinned slot to be self-contained.

The `key` identifies the slot:

- `key: "checkpoint"` — the legacy carry-over checkpoint slot. Use for cursors, timestamps, counters, or any data needed to resume work next time.
- Any other key (e.g. `"persona"`, `"goals"`, `"user_preferences"`) — additional named pinned blocks rendered alongside the checkpoint. Useful for stable agent context the LLM should always see.

By default the slot is scoped to the current actor (the user or end-user that triggered the run). Pass `scope: "shared"` to make the slot app-wide — useful for cron-scheduled syncs that have no actor of their own.

Good candidates for pinned slots:

- `checkpoint` — pagination cursors, last-processed timestamps, incremental sync state
- `persona` — stable agent identity / role description
- `goals` — current objectives or success criteria

Use `note({ content })` for free-form insights worth remembering long-term in the archive (NOT injected into the prompt — retrievable via `recall_memory`). Use `pin` for structured data that must be visible on every run.
