# Scheduling

Flows can be scheduled to run automatically via cron expressions.

## Create a Schedule

**First check existing schedules** to avoid duplicates:

```
GET /api/flows/{flowId}/schedules
Authorization: Bearer ask_...
```

Then create:

```
POST /api/flows/{flowId}/schedules
Authorization: Bearer ask_...
Content-Type: application/json

{
  "name": "Daily report",
  "cronExpression": "0 9 * * *",
  "timezone": "Europe/Paris",
  "enabled": true,
  "input": { "query": "daily summary" }
}
```

## List Schedules

```
GET /api/schedules
Authorization: Bearer ask_...
```

Returns all schedules across all flows, or filter by flow:

```
GET /api/flows/{flowId}/schedules
Authorization: Bearer ask_...
```

## Update a Schedule

```
PUT /api/schedules/{scheduleId}
Authorization: Bearer ask_...
Content-Type: application/json

{ "enabled": false }
```

Updatable fields: `cronExpression`, `timezone`, `enabled`, `input`, `name`.

## Delete a Schedule

```
DELETE /api/schedules/{scheduleId}
Authorization: Bearer ask_...
```

## Cron Expression Format

Standard 5-field cron: `minute hour day-of-month month day-of-week`

| Expression     | Meaning                 |
| -------------- | ----------------------- |
| `* * * * *`    | Every minute            |
| `0 * * * *`    | Every hour              |
| `0 9 * * *`    | Every day at 9:00       |
| `0 9 * * 1-5`  | Weekdays at 9:00        |
| `*/15 * * * *` | Every 15 minutes        |
| `0 0 1 * *`    | First day of each month |
