# Firecrawl API

Base URL: `https://api.firecrawl.dev/v1`

## Quick Reference

Web scraping and crawling API. Scrape single pages, crawl entire websites, discover URLs, and extract structured data.
All requests use JSON bodies. All responses are JSON. Authentication via Bearer token in the Authorization header.

## Authentication

All requests require a Bearer token:
```
Authorization: Bearer fc-YOUR_API_KEY
```

## Key Endpoints

### Scrape a URL
`POST /v1/scrape`

Extract clean content from a single URL. Supports JavaScript rendering and multiple output formats.

**Request body:**
```json
{
  "url": "https://example.com",
  "formats": ["markdown"]
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "markdown": "# Page Title\n\nPage content...",
    "metadata": {
      "title": "Example",
      "description": "Page description",
      "sourceURL": "https://example.com",
      "statusCode": 200
    }
  }
}
```

### Scrape with Structured Extraction
`POST /v1/scrape`

Extract structured data from a page using a JSON Schema.

**Request body:**
```json
{
  "url": "https://example.com/pricing",
  "formats": ["extract"],
  "extract": {
    "schema": {
      "type": "object",
      "properties": {
        "plans": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {"type": "string"},
              "price": {"type": "string"},
              "features": {"type": "array", "items": {"type": "string"}}
            }
          }
        }
      }
    }
  }
}
```

### Crawl a Website
`POST /v1/crawl`

Start an asynchronous crawl of an entire website. Returns a job ID for status polling.

**Request body:**
```json
{
  "url": "https://docs.example.com",
  "limit": 50,
  "scrapeOptions": {
    "formats": ["markdown"]
  }
}
```

**Response:**
```json
{
  "success": true,
  "id": "crawl-job-id",
  "url": "https://api.firecrawl.dev/v1/crawl/crawl-job-id"
}
```

### Check Crawl Status
`GET /v1/crawl/{id}`

Poll a crawl job for progress and results.

**Response:**
```json
{
  "success": true,
  "status": "completed",
  "total": 50,
  "completed": 50,
  "data": [
    {"markdown": "...", "metadata": {"sourceURL": "...", "title": "..."}}
  ]
}
```

### Map a Website
`POST /v1/map`

Quickly discover all URLs on a website without scraping content. Supports up to 5,000 URLs.

**Request body:**
```json
{"url": "https://docs.example.com"}
```

**Response:**
```json
{
  "success": true,
  "links": [
    "https://docs.example.com",
    "https://docs.example.com/getting-started",
    "https://docs.example.com/api-reference"
  ]
}
```

### Search the Web
`POST /v1/search`

Search the web and get full page content for each result in a single API call.

**Request body:**
```json
{
  "query": "web scraping best practices",
  "limit": 5,
  "scrapeOptions": {
    "formats": ["markdown"]
  }
}
```

### Batch Scrape
`POST /v1/batch/scrape`

Scrape multiple URLs in parallel. Returns a job ID like crawl.

**Request body:**
```json
{
  "urls": ["https://example.com/page1", "https://example.com/page2"],
  "formats": ["markdown"]
}
```

## Output Formats

The `formats` array controls what data is returned:
- `"markdown"` — Clean markdown content (recommended for AI processing)
- `"html"` — Cleaned HTML
- `"rawHtml"` — Unprocessed HTML
- `"links"` — Extracted links from the page
- `"screenshot"` — Page screenshot (base64, expires in 24h)
- `"extract"` — Structured data extraction (requires `extract.schema`)

Default is `["markdown"]`.

## Scrape Options

Common options for scrape, crawl, and batch endpoints:
- `onlyMainContent`: `true` (default) — strips navbars, footers, sidebars
- `waitFor`: milliseconds to wait after page load (for JS-heavy pages)
- `timeout`: request timeout in ms (1–300000)
- `mobile`: `true` to emulate mobile device
- `includeTags`: CSS selectors to include (e.g. `["article", ".content"]`)
- `excludeTags`: CSS selectors to exclude (e.g. `["nav", "footer"]`)

## Crawl Options

- `limit`: max pages to crawl (default 10)
- `maxDepth`: max link depth from starting URL
- `includePaths`: URL path patterns to include (e.g. `["/blog/*"]`)
- `excludePaths`: URL path patterns to exclude
- `allowExternalLinks`: `false` (default) — stay on same domain

## Async Job Polling

Crawl and batch scrape are asynchronous:
1. POST to start the job → receive `id`
2. GET `/v1/crawl/{id}` or `/v1/batch/scrape/{id}` to poll
3. Status values: `scraping`, `completed`, `failed`
4. Poll until `status === "completed"`

## Rate Limits

| Plan | /scrape, /map | /crawl | Concurrent browsers |
|------|---------------|--------|---------------------|
| Free | 10/min | 1/min | 2 |
| Hobby | 30/min | 3/min | 5 |
| Standard | 60/min | 10/min | 10 |
| Growth | 300/min | 50/min | 50 |

## Error Codes

- `402` — Insufficient credits
- `429` — Rate limit exceeded (retry after backoff)
- `408` — Timeout (increase `timeout` parameter)
- `500` — Server error (retry with exponential backoff)

## Important Notes

- API keys start with `fc-`.
- Free tier: 500 credits. Each scrape costs 1 credit. JS rendering and extraction cost more.
- Failed requests typically do not consume credits.
- `onlyMainContent: true` (default) is recommended for clean, AI-readable content.
- Crawl results may be paginated — check the `next` field in the response.
- Screenshots expire after 24 hours.
- The `/v1/search` endpoint combines web search + scraping in one call — useful for research tasks.
