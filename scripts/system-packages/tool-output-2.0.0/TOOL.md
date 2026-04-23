## Output

You MUST call the `output` tool exactly once before the run ends with the complete output object. This is how you return data to the platform — without an `output` call, the run has no result.

Calling `output` again replaces the previous output (no merge). If an output schema is defined, the data is validated against it on every call: missing required fields or type mismatches return an error so you can retry.

If no schema is defined and you have nothing specific to return, call `output({})`.

Do NOT write a JSON code block instead — always use the `output` tool call.
