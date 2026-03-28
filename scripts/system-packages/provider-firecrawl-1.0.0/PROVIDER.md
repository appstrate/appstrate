# Firecrawl API

Base URL: `https://api.firecrawl.dev/v2`

Web scraping and crawling API. Scrape single pages, crawl entire websites, discover URLs, extract structured data, and search the web. All requests use JSON bodies. All responses are JSON.

## Endpoints

### Scrape a URL
`POST /v2/scrape`

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

### Scrape with Structured JSON Extraction
`POST /v2/scrape`

Extract structured data from a page using an inline JSON format specification.

**Request body:**
```json
{
  "url": "https://example.com/pricing",
  "formats": [
    {
      "type": "json",
      "schema": {
        "type": "object",
        "properties": {
          "plans": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": { "type": "string" },
                "price": { "type": "string" },
                "features": { "type": "array", "items": { "type": "string" } }
              }
            }
          }
        }
      },
      "prompt": "Extract all pricing plans with their names, prices, and feature lists."
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "json": {
      "plans": [
        { "name": "Starter", "price": "$9/mo", "features": ["5 users", "10GB storage"] }
      ]
    },
    "metadata": { "title": "Pricing", "sourceURL": "https://example.com/pricing", "statusCode": 200 }
  }
}
```

### Crawl a Website
`POST /v2/crawl`

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
  "url": "https://api.firecrawl.dev/v2/crawl/crawl-job-id"
}
```

### Check Crawl Status
`GET /v2/crawl/{ID}`

Poll a crawl job for progress and results.

**Response:**
```json
{
  "success": true,
  "status": "completed",
  "total": 50,
  "completed": 50,
  "data": [
    { "markdown": "...", "metadata": { "sourceURL": "...", "title": "..." } }
  ]
}
```

### Map a Website
`POST /v2/map`

Quickly discover all URLs on a website without scraping content. Supports up to 100,000 URLs.

**Request body:**
```json
{ "url": "https://docs.example.com" }
```

**Response:**
```json
{
  "success": true,
  "links": [
    { "url": "https://docs.example.com", "title": "Docs Home", "description": "Documentation homepage" },
    { "url": "https://docs.example.com/getting-started", "title": "Getting Started", "description": "Quick start guide" },
    { "url": "https://docs.example.com/api-reference", "title": "API Reference", "description": "Full API docs" }
  ]
}
```

### Extract (Multi-URL LLM Extraction)
`POST /v2/extract`

Extract structured data from one or more URLs using LLM-powered extraction. Useful for pulling data across multiple pages.

**Request body:**
```json
{
  "urls": ["https://example.com/pricing", "https://example.com/features"],
  "schema": {
    "type": "object",
    "properties": {
      "company": { "type": "string" },
      "plans": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "price": { "type": "string" }
          }
        }
      }
    }
  },
  "prompt": "Extract the company name and all pricing plans."
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "company": "Example Inc",
    "plans": [
      { "name": "Free", "price": "$0" },
      { "name": "Pro", "price": "$29/mo" }
    ]
  }
}
```

### Search the Web
`POST /v2/search`

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
`POST /v2/batch/scrape`

Scrape multiple URLs in parallel. Returns a job ID like crawl.

**Request body:**
```json
{
  "urls": ["https://example.com/page1", "https://example.com/page2"],
  "formats": ["markdown"]
}
```

## Output Formats

The `formats` array controls what data is returned. String values for simple formats, object values for structured extraction:

- `"markdown"` -- Clean markdown content (recommended for AI processing)
- `"html"` -- Cleaned HTML
- `"rawHtml"` -- Unprocessed HTML
- `"links"` -- Extracted links from the page
- `"screenshot"` -- Page screenshot (base64, expires in 24h)
- `"images"` -- Extracted image URLs from the page
- `"summary"` -- AI-generated summary of the page content
- `"branding"` -- Extracted branding information (logos, colors, fonts)
- `"audio"` -- Extracted audio content
- `{ "type": "json", "schema": {...}, "prompt": "..." }` -- Structured JSON extraction with a JSON Schema and optional prompt

Default is `["markdown"]`.

## Scrape Options

Common options for scrape, crawl, and batch endpoints:

- `onlyMainContent`: `true` (default) -- strips navbars, footers, sidebars
- `waitFor`: milliseconds to wait after page load (for JS-heavy pages)
- `timeout`: request timeout in ms (1-300000)
- `mobile`: `true` to emulate mobile device
- `includeTags`: CSS selectors to include (e.g. `["article", ".content"]`)
- `excludeTags`: CSS selectors to exclude (e.g. `["nav", "footer"]`)
- `removeBase64Images`: `true` to strip inline base64 images from output
- `blockAds`: `true` to block ads during page rendering
- `headers`: custom HTTP headers to send with the request (e.g. `{ "Accept-Language": "en-US" }`)
- `actions`: array of browser actions to perform before scraping (click, scroll, wait, type, etc.)
- `proxy`: proxy mode -- `"stealth"` for residential proxies, `"none"` to disable
- `location`: geolocation settings for the browser (country, languages)

## Crawl Options

- `limit`: max pages to crawl (default 10000)
- `maxDiscoveryDepth`: max link depth from starting URL
- `includePaths`: URL path patterns to include (e.g. `["/blog/*"]`)
- `excludePaths`: URL path patterns to exclude
- `allowExternalLinks`: `false` (default) -- stay on same domain
- `webhook`: URL to receive a POST callback when crawl completes
- `sitemap`: URL of a sitemap to use for URL discovery
- `delay`: delay in milliseconds between scraping each page
- `maxConcurrency`: max number of pages to scrape concurrently
- `ignoreQueryParameters`: `true` to treat URLs with different query params as the same page

## Async Job Polling

Crawl and batch scrape are asynchronous:
1. POST to start the job -- receive `id`
2. GET `/v2/crawl/{ID}` or `/v2/batch/scrape/{ID}` to poll
3. Status values: `scraping`, `completed`, `failed`
4. Poll until `status === "completed"`

## Rate Limits

| Plan     | /scrape, /map | /crawl   | Concurrent browsers |
|----------|---------------|----------|---------------------|
| Free     | 10/min        | 1/min    | 2                   |
| Hobby    | 100/min       | 15/min   | 5                   |
| Standard | 500/min       | 50/min   | 50                  |
| Growth   | 5000/min      | 250/min  | 100                 |

## Error Codes

- `402` -- Insufficient credits
- `429` -- Rate limit exceeded (retry after backoff)
- `408` -- Timeout (increase `timeout` parameter)
- `500` -- Server error (retry with exponential backoff)

## Important Notes

- Free tier: 500 credits. Each scrape costs 1 credit. JS rendering and extraction cost more.
- Failed requests typically do not consume credits.
- `onlyMainContent: true` (default) is recommended for clean, AI-readable content.
- Crawl results may be paginated -- check the `next` field in the response.
- Screenshots expire after 24 hours.
- The `/v2/search` endpoint combines web search + scraping in one call -- useful for research tasks.
- The `/v2/extract` endpoint uses LLM extraction across multiple URLs -- useful for aggregating data from several pages.
