# Appstrate System Tools

System tools are platform-provided tools that agents can use at runtime. They are NOT available by default — each tool must be declared in `dependencies.tools` in the manifest to be activated.

## Discovery

List available tools in the org:

```bash
curl "$APPSTRATE_URL/api/packages/tools"
```

Activate tools for an existing agent via API:

```bash
curl -X PUT "$APPSTRATE_URL/api/agents/@scope/name/tools" \
  -H "Content-Type: application/json" \
  -d '{"toolIds": ["@appstrate/output", "@appstrate/set-state"]}'
```

Or declare in manifest (preferred — activated at import):

```json
"dependencies": {
  "tools": {
    "@appstrate/output": "^1.0.0",
    "@appstrate/set-state": "^1.0.0"
  }
}
```

## Tool Reference

### `@appstrate/output` — Return structured data

Returns data as the run result. Each call is deep-merged into the final output, validated against the output schema (AJV) after the run completes.

**When to use**: Agent has an `output` schema defined in its manifest and needs to return structured JSON results.

**Without this tool**: Run completes with `result: {}` even on success — the agent has no way to submit structured data.

**In prompt.md**: Instruct the agent to call the `output` tool with a `data` parameter matching the output schema. Multiple calls are merged.

```markdown
Use the `output` tool to return results:
output({ "summary": "...", "itemCount": 42 })
```

### `@appstrate/report` — Generate a markdown report

Produces a markdown report included in the run result alongside structured output.

**When to use**: Agent should produce a human-readable narrative (summary, analysis, formatted results) in addition to or instead of structured data.

**In prompt.md**: Instruct the agent to call `report` with markdown content.

### `@appstrate/set-state` — Persist state between runs

Saves state that is injected as `## Previous State` on the next run. Overwrites previous state entirely.

**When to use**: Recurring/scheduled agents that need to track progress — sync cursors, timestamps, pagination tokens.

**In prompt.md**:

```markdown
Check `## Previous State` for `lastSyncTimestamp`.

- First run: process all items from last 7 days.
- Subsequent runs: only items after `lastSyncTimestamp`.
  Call `set-state` with `{ "lastSyncTimestamp": "<now>" }` before finishing.
```

### `@appstrate/add-memory` — Long-term learning

Saves a discovery or learning as a long-term memory. Memories are injected into future runs and persist across versions.

**When to use**: Agent should learn patterns, preferences, or API quirks across runs (e.g., "this endpoint returns dates in UTC", "user prefers bullet points").

**In prompt.md**: Instruct the agent to call `add-memory` when it discovers something worth remembering.

### `@appstrate/log` — Real-time progress messages

Sends progress messages visible to the user in real time (via SSE).

**When to use**: Long-running agents where the user benefits from seeing intermediate progress (e.g., "Processing page 3/10...").

**In prompt.md**: Instruct the agent to call `log` at key milestones.

## Decision Guide

| Agent type                          | Recommended tools                                   |
| ----------------------------------- | --------------------------------------------------- |
| One-shot with structured output     | `output`                                            |
| One-shot with report                | `report` (+ `output` if also needs structured data) |
| Recurring/scheduled (sync, digest)  | `output` + `set-state`                              |
| Learning agent (improves over time) | `output` + `add-memory`                             |
| Long-running (> 30s)                | Add `log` to any of the above                       |
