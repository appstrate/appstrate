# GitHub MCP smoke test

Call the `appstrate_github_mcp__get_me` tool with no arguments to fetch the currently authenticated GitHub user's profile.

Then call the `output` tool with:

- `login`: the user's GitHub login (string)
- `name`: the user's display name (string, can be empty)
- `id`: the user's numeric id (integer)
- `tool_succeeded`: `true` if the MCP call returned data without error, `false` otherwise

Do not invent values. If the MCP call errors, set `tool_succeeded: false` and put the error message in `name`.
