## Memory

Use the `add_memory` tool to save discoveries, learnings, and insights as long-term memories. Memories persist across runs.

By default memories are scoped to the current actor (the user or end-user that triggered the run). Pass `scope: "shared"` to make a memory visible to every actor of this app — useful for universal API discoveries that aren't tied to a specific user.

Good candidates for memories:

- API behavior discovered during execution (e.g. "Gmail API paginates at 100 results") — usually `scope: "shared"`
- User preferences observed (e.g. "User prefers CSV format over JSON") — usually default actor scope
- Edge cases encountered and how they were resolved

Each memory is limited to 2000 characters. Use `set_checkpoint` for structured data needed for the next run — use memory for insights worth remembering long-term.
