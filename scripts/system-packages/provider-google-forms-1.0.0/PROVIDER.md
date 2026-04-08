# Google Forms API

Base URL: `https://forms.googleapis.com/v1`

Google Forms API for reading form structure, collecting responses, and managing forms programmatically. Forms can be discovered by listing Google Drive files with mimeType `application/vnd.google-apps.form` (requires Drive API scope).

## Endpoints

### Get Form
`GET /forms/{formId}`

Returns the full form structure including title, description, and all questions.

**Response:**
```json
{
  "formId": "1BxiMVs0XRA5nFMdLHPCLR...",
  "info": {
    "title": "Customer Satisfaction Survey",
    "description": "Please share your feedback",
    "documentTitle": "Customer Survey"
  },
  "revisionId": "00000042",
  "responderUri": "https://docs.google.com/forms/d/e/1FAIpQL.../viewform",
  "items": [
    {
      "itemId": "3a4b5c6d",
      "title": "How satisfied are you?",
      "description": "Rate from 1 to 5",
      "questionItem": {
        "question": {
          "questionId": "7e8f9a0b",
          "required": true,
          "scaleQuestion": {
            "low": 1,
            "high": 5,
            "lowLabel": "Not satisfied",
            "highLabel": "Very satisfied"
          }
        }
      }
    },
    {
      "itemId": "1c2d3e4f",
      "title": "Additional comments",
      "questionItem": {
        "question": {
          "questionId": "5g6h7i8j",
          "required": false,
          "textQuestion": {
            "paragraph": true
          }
        }
      }
    }
  ]
}
```

### Create Form
`POST /forms`

Creates a new empty form with a title. Add questions using batchUpdate. Requires `forms.body` scope.

**Request body (JSON):**
```json
{
  "info": {
    "title": "New Survey",
    "documentTitle": "New Survey Form"
  }
}
```

**Response:**
```json
{
  "formId": "1BxiMVs0XRA5nFMdLHPCLR...",
  "info": {
    "title": "New Survey",
    "documentTitle": "New Survey Form"
  },
  "revisionId": "00000001",
  "responderUri": "https://docs.google.com/forms/d/e/1FAIpQL.../viewform",
  "items": []
}
```

### Update Form (Batch)
`POST /forms/{formId}:batchUpdate`

Update form structure: add, update, move, or delete items. Requires `forms.body` scope.

**Request body (JSON):**
```json
{
  "includeFormInResponse": true,
  "requests": [
    {
      "createItem": {
        "item": {
          "title": "What is your name?",
          "questionItem": {
            "question": {
              "required": true,
              "textQuestion": {
                "paragraph": false
              }
            }
          }
        },
        "location": {
          "index": 0
        }
      }
    },
    {
      "createItem": {
        "item": {
          "title": "Select your department",
          "questionItem": {
            "question": {
              "required": true,
              "choiceQuestion": {
                "type": "RADIO",
                "options": [
                  { "value": "Engineering" },
                  { "value": "Marketing" },
                  { "value": "Sales" }
                ]
              }
            }
          }
        },
        "location": {
          "index": 1
        }
      }
    }
  ]
}
```

### List Responses
`GET /forms/{formId}/responses`

Returns all form responses. Requires `forms.responses.readonly` scope.

**Query parameters:**
- `pageSize` — Maximum responses per page (max 5000)
- `pageToken` — Token for next page
- `filter` — Filter by timestamp: `timestamp >= 2024-01-01T00:00:00Z`

**Response:**
```json
{
  "responses": [
    {
      "responseId": "ACYDBNi3abc...",
      "createTime": "2024-06-15T10:30:00.000Z",
      "lastSubmittedTime": "2024-06-15T10:32:00.000Z",
      "respondentEmail": "user@example.com",
      "answers": {
        "7e8f9a0b": {
          "questionId": "7e8f9a0b",
          "textAnswers": {
            "answers": [
              { "value": "4" }
            ]
          }
        },
        "5g6h7i8j": {
          "questionId": "5g6h7i8j",
          "textAnswers": {
            "answers": [
              { "value": "Great service overall!" }
            ]
          }
        }
      },
      "totalScore": null
    }
  ],
  "nextPageToken": "..."
}
```

### Get Single Response
`GET /forms/{formId}/responses/{responseId}`

Returns a single form response by ID.

### Create Watch
`POST /forms/{formId}/watches`

Subscribe to notifications when new responses are submitted or the form schema changes. Requires a Cloud Pub/Sub topic.

**Request body (JSON):**
```json
{
  "watch": {
    "target": {
      "topic": {
        "topicName": "projects/my-project/topics/form-responses"
      }
    },
    "eventType": "RESPONSES"
  }
}
```

**Response:**
```json
{
  "id": "watch-id-123",
  "createTime": "2024-06-15T10:00:00.000Z",
  "expireTime": "2024-06-22T10:00:00.000Z",
  "target": {
    "topic": {
      "topicName": "projects/my-project/topics/form-responses"
    }
  },
  "eventType": "RESPONSES",
  "state": "ACTIVE"
}
```

### Delete Watch
`DELETE /forms/{formId}/watches/{watchId}`

Deletes a watch subscription.

## Common Patterns

### Pagination
Token-based pagination:
- Response includes `nextPageToken`
- Pass as `pageToken` query parameter
- When no `nextPageToken` in response, no more pages

### Question Types
- `textQuestion` — Short text (`paragraph: false`) or long text (`paragraph: true`)
- `choiceQuestion` — Radio (`RADIO`), Checkbox (`CHECKBOX`), or Dropdown (`DROP_DOWN`)
- `scaleQuestion` — Linear scale with `low`, `high`, and optional labels
- `dateQuestion` — Date picker (with optional time)
- `timeQuestion` — Time picker
- `fileUploadQuestion` — File upload
- `grading` — Quiz grading with correct answers and point values

### Batch Update Operations
The `batchUpdate` endpoint supports these request types:
- `createItem` — Add a new question/section/page break
- `updateItem` — Modify an existing item
- `moveItem` — Change item position
- `deleteItem` — Remove an item
- `updateFormInfo` — Update form title/description
- `updateSettings` — Update form settings (quiz mode, etc.)

### Error Format
```json
{
  "error": {
    "code": 404,
    "message": "Requested entity was not found.",
    "status": "NOT_FOUND"
  }
}
```

## Important Notes
- Form IDs are found in the Google Forms URL: `https://docs.google.com/forms/d/{formId}/edit`.
- To list all forms, use the Google Drive API with `mimeType = 'application/vnd.google-apps.form'` (requires `drive.readonly` scope).
- The `respondentEmail` field in responses is only populated if the form requires sign-in.
- Watches expire after 7 days and must be renewed.
- Rate limit: 300 read requests per minute per project, 60 write requests per minute.
- The `batchUpdate` endpoint processes requests sequentially — a failure stops remaining requests.
- Answers are keyed by `questionId` (not `itemId`) in response objects.
