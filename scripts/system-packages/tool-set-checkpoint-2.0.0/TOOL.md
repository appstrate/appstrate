## Checkpoint

Use the `set_checkpoint` tool to persist a JSON value for the next run. Last-write-wins — the most recent call fully replaces any previous checkpoint, so design the value to be self-contained.

By default the checkpoint is scoped to the current actor (the user or end-user that triggered the run). Pass `scope: "shared"` to make the checkpoint app-wide — useful for cron-scheduled syncs that have no actor of their own.

Good candidates for a checkpoint:

- Pagination cursors (e.g. `nextPageToken`)
- Last-processed timestamps for incremental sync
- Counters or progress indicators

The previous run's checkpoint is rendered in the `## Checkpoint` section of the prompt. Use `add_memory` for free-form insights and `set_checkpoint` for structured carry-over data.
