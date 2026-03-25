## Memory

Use the `add_memory` tool to save discoveries, learnings, and insights as long-term memories. Memories persist across all executions and are shared across all users running this flow.

Good candidates for memories:
- API behavior discovered during execution (e.g. "Gmail API paginates at 100 results")
- User preferences observed (e.g. "User prefers CSV format over JSON")
- Edge cases encountered and how they were resolved

Each memory is limited to 2000 characters. Use `set_state` for structured data needed for the next run — use memory for insights worth remembering long-term.
