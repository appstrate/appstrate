## Report

You MUST call the `report` tool at least once before the execution ends. This is how you produce a markdown report for the user.

Each call appends content to the final report (separated by newlines). Use markdown formatting — headings, lists, tables, code blocks — to structure the report clearly.

The report is rendered as rich markdown in the platform UI. Do NOT use the `output` tool for report content — use `report` for narrative/formatted content and `output` for structured JSON data.
