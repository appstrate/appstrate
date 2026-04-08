# Google Sheets API

Base URL: `https://sheets.googleapis.com`

Read and write data in Google Sheets. Supports cell ranges (A1 notation), batch operations, and formatting. All spreadsheet endpoints are under the `/v4/spreadsheets` path.

## Endpoints

### Get Spreadsheet Metadata
`GET /v4/spreadsheets/{SPREADSHEET_ID}`

Returns spreadsheet properties, sheet names, and structure.

**Query parameters:**
- `fields` — limit response fields (e.g. `properties,sheets.properties`)

**Response:**
```json
{
  "spreadsheetId": "...",
  "properties": { "title": "My Spreadsheet" },
  "sheets": [
    { "properties": { "sheetId": 0, "title": "Sheet1", "index": 0 } }
  ]
}
```

### Read Cell Range
`GET /v4/spreadsheets/{SPREADSHEET_ID}/values/{RANGE}`

Read values from a cell range using A1 notation.

**Response:**
```json
{
  "range": "Sheet1!A1:D10",
  "majorDimension": "ROWS",
  "values": [
    ["Name", "Score"],
    ["Alice", "95"]
  ]
}
```

### Write Cell Range
`PUT /v4/spreadsheets/{SPREADSHEET_ID}/values/{RANGE}`

Write values to a cell range.

**Query parameters:**
- `valueInputOption` (required) — `USER_ENTERED` or `RAW`

**Request body:**
```json
{
  "values": [["Name", "Score"], ["Alice", 95]]
}
```

### Append Rows
`POST /v4/spreadsheets/{SPREADSHEET_ID}/values/{RANGE}:append`

Append rows after the last row with data.

**Query parameters:**
- `valueInputOption` (required) — `USER_ENTERED` or `RAW`
- `insertDataOption` — `INSERT_ROWS` or `OVERWRITE`

**Request body:**
```json
{
  "values": [["Bob", 88], ["Carol", 92]]
}
```

### Batch Read
`GET /v4/spreadsheets/{SPREADSHEET_ID}/values:batchGet`

Read multiple ranges in one request.

**Query parameters:**
- `ranges` (repeated) — e.g. `ranges=Sheet1!A1:B5&ranges=Sheet2!A1:C3`

### Batch Update
`POST /v4/spreadsheets/{SPREADSHEET_ID}/values:batchUpdate`

Write to multiple ranges in one request.

**Request body:**
```json
{
  "valueInputOption": "USER_ENTERED",
  "data": [
    { "range": "Sheet1!A1", "values": [["Updated"]] },
    { "range": "Sheet2!B2", "values": [[42]] }
  ]
}
```

### Clear Range
`POST /v4/spreadsheets/{SPREADSHEET_ID}/values/{RANGE}:clear`

Clear values from a range (keeps formatting). No request body required.

## Common Patterns

### A1 Notation
- `Sheet1!A1:B5` — range on specific sheet
- `A1:B5` — range on first sheet
- `Sheet1!A:A` — entire column A
- `Sheet1!1:3` — rows 1 through 3
- `Sheet1` — entire sheet

### valueInputOption
- `USER_ENTERED` — Parses input as if typed by a user (dates, formulas, numbers auto-detected)
- `RAW` — Stores values as-is (no parsing)

### Response Format
Read responses contain `values` as a 2D array: `[["A1", "B1"], ["A2", "B2"]]`.
Empty cells are omitted from trailing positions.

## Important Notes

- Spreadsheet ID is in the URL: `https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit`
- Sheet names with spaces must be quoted in ranges: `'My Sheet'!A1:B5`
- Rate limits: 300 read and 300 write requests per minute per project (counted separately), 60 read and 60 write per minute per user.
- Use `fields` parameter to limit response size.
- Maximum 10 million cells per spreadsheet.
