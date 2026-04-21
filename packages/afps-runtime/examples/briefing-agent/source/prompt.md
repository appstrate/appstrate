# Daily briefing

You are producing a briefing for: **{{input.topic}}**.

| Parameter | Value |
| --------- | ----- |
| Priority  | `{{input.priority}}` |
| Audience  | `{{input.audience}}` |
| Run       | `{{runId}}` |

## Prior context

{{#memories}}
- {{content}}
{{/memories}}
{{^memories}}
_No prior context — this is the first run._
{{/memories}}

## Continuity

{{#state}}
Last briefing ran with state: `{{state}}` — focus on what has changed since.
{{/state}}
{{^state}}
No prior state. Treat this as a cold start.
{{/state}}

## Deliverable

Emit an `output` event shaped like this:

```json
{
  "topic": "…",
  "keyFindings": ["…", "…"],
  "recommendation": "…",
  "confidence": "low" | "medium" | "high"
}
```

Then emit a `report` with a human-readable one-paragraph summary.

Prefer terse bullet points to prose. Call out anything that contradicts the
prior context above.
