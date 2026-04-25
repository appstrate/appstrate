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

{{#checkpoint}}
Last briefing ran with checkpoint: `{{checkpoint}}` — focus on what has changed since.
{{/checkpoint}}
{{^checkpoint}}
No prior checkpoint. Treat this as a cold start.
{{/checkpoint}}

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
