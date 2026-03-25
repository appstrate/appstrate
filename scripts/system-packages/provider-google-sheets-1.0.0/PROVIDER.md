# Google Sheets API

Base URL: `https://sheets.googleapis.com/v4/spreadsheets`

## Quick Reference

Read and write data in Google Sheets. Supports cell ranges (A1 notation), batch operations, and formatting.

## Key Endpoints

### Get Spreadsheet Metadata
GET /spreadsheets/{spreadsheetId}
Returns spreadsheet properties, sheet names, and structure.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: google-sheets" \
  -H "X-Target: https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}?fields=properties,sheets.properties" \
  -H "Authorization: Bearer {{token}}"
```

### Read Cell Range
GET /spreadsheets/{spreadsheetId}/values/{range}
Read values from a cell range using A1 notation.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: google-sheets" \
  -H "X-Target: https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/Sheet1!A1:D10" \
  -H "Authorization: Bearer {{token}}"
```

### Write Cell Range
PUT /spreadsheets/{spreadsheetId}/values/{range}
Write values to a cell range. Requires `valueInputOption` parameter.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X PUT \
  -H "X-Provider: google-sheets" \
  -H "X-Target: https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/Sheet1!A1:B2?valueInputOption=USER_ENTERED" \
  -H "Authorization: Bearer {{token}}" \
  -H "Content-Type: application/json" \
  -d '{"values": [["Name", "Score"], ["Alice", 95]]}'
```

### Append Rows
POST /spreadsheets/{spreadsheetId}/values/{range}:append
Append rows after the last row with data.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: google-sheets" \
  -H "X-Target: https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/Sheet1!A:B:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS" \
  -H "Authorization: Bearer {{token}}" \
  -H "Content-Type: application/json" \
  -d '{"values": [["Bob", 88], ["Carol", 92]]}'
```

### Batch Read
GET /spreadsheets/{spreadsheetId}/values:batchGet
Read multiple ranges in one request.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: google-sheets" \
  -H "X-Target: https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values:batchGet?ranges=Sheet1!A1:B5&ranges=Sheet2!A1:C3" \
  -H "Authorization: Bearer {{token}}"
```

### Batch Update
POST /spreadsheets/{spreadsheetId}/values:batchUpdate
Write to multiple ranges in one request.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: google-sheets" \
  -H "X-Target: https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values:batchUpdate" \
  -H "Authorization: Bearer {{token}}" \
  -H "Content-Type: application/json" \
  -d '{"valueInputOption": "USER_ENTERED", "data": [{"range": "Sheet1!A1", "values": [["Updated"]]}, {"range": "Sheet2!B2", "values": [[42]]}]}'
```

### Clear Range
POST /spreadsheets/{spreadsheetId}/values/{range}:clear
Clear values from a range (keeps formatting).

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: google-sheets" \
  -H "X-Target: https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/Sheet1!A1:D10:clear" \
  -H "Authorization: Bearer {{token}}"
```

## Common Patterns

### A1 Notation
- `Sheet1!A1:B5` -- range on specific sheet
- `A1:B5` -- range on first sheet
- `Sheet1!A:A` -- entire column A
- `Sheet1!1:3` -- rows 1 through 3
- `Sheet1` -- entire sheet

### valueInputOption
- `USER_ENTERED` -- Parses input as if typed by a user (dates, formulas, numbers auto-detected)
- `RAW` -- Stores values as-is (no parsing)

### Response Format
Read responses contain `values` as a 2D array: `[["A1", "B1"], ["A2", "B2"]]`.
Empty cells are omitted from trailing positions.

## Important Notes

- Spreadsheet ID is in the URL: `https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit`
- Sheet names with spaces must be quoted in ranges: `'My Sheet'!A1:B5`
- Rate limit: 300 requests per minute per project, 60 per minute per user.
- Use `fields` parameter to limit response size.
- Maximum 10 million cells per spreadsheet.