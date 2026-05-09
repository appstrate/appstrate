## run_history

Use `run_history({ limit?, fields? })` to fetch metadata about recent past runs of this agent (the current run is excluded). Returned entries always include core metadata (run id, timestamps, status, trigger). To include heavier payloads, opt-in via `fields`:

- `fields: ["checkpoint"]` — include each run's saved checkpoint snapshot.
- `fields: ["result"]` — include each run's structured output (`output` tool payload).
- Pass both for the full picture.

`limit` defaults to a small number; bump it (max 50) to look further back.

Common uses: deciding whether a prior run already processed something, diagnosing an unexpected state by inspecting prior outputs, replaying logic against a previous checkpoint shape during migrations.
