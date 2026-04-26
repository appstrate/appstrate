## Note

Use the `note` tool to save discoveries, learnings, and insights as long-term archive memories. Archive memories persist across runs but are **not** injected into the system prompt — retrieve them on demand with `recall_memory({ q?, limit? })`.

By default notes are scoped to the current actor (the user or end-user that triggered the run). Pass `scope: "shared"` to make a note visible to every actor of this app — useful for universal API discoveries that aren't tied to a specific user.

Good candidates for notes:

- API behavior discovered during execution (e.g. "Gmail API paginates at 100 results") — usually `scope: "shared"`
- User preferences observed (e.g. "User prefers CSV format over JSON") — usually default actor scope
- Edge cases encountered and how they were resolved

Each note is limited to 2000 characters. Use `pin({ key: "checkpoint", content })` for structured carry-over data needed for the next run — use `note` for free-form insights worth remembering long-term.
