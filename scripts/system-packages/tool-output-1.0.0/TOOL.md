## Output

You MUST call the `output` tool at least once before the run ends. This is how you return data to the platform — without an `output` call, the run has no result.

Each call is deep-merged into the final output. If an output schema is defined, the merged result is validated against it. Structure the data in whatever way best serves the task.

If you have nothing specific to return, call `output` with an empty object `{}` or a summary of what you did.

Do NOT write a JSON code block instead — always use the `output` tool call.
