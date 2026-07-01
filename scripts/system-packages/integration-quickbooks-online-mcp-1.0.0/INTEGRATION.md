# QuickBooks Online (MCP)

QuickBooks Online accounting, exposed through Intuit's **official MCP server**
running locally inside the per-run sandbox. Use this when an agent needs to
read or report on QuickBooks data through typed tools rather than building raw
REST calls (for raw REST, use `@appstrate/quickbooks-online`).

## Connecting

This integration does **not** use Appstrate's OAuth "Connect" flow — Intuit's
server manages its own token refresh. You paste credentials from an existing
Intuit app (one app, created once, reused by everyone):

| Field | Where to get it |
|-------|-----------------|
| `client_id` / `client_secret` | developer.intuit.com → your app → **Keys & credentials** |
| `refresh_token` | Intuit **OAuth Playground** (or your existing OAuth flow). Valid ~100 days. |
| `realm_id` | The QuickBooks **Company ID** (shown in the Playground / company settings) |
| `environment` | `production` (default) or `sandbox` |

The sidecar injects these as `QUICKBOOKS_*` environment variables into the MCP
subprocess. The refresh token is long-lived; rotate the connection when it nears
its 100-day expiry.

## What's exposed

**Read-only by default** (69 tools). The server is launched with
`QUICKBOOKS_DISABLE_WRITE/UPDATE/DELETE=true`, so only `get_*` / `search_*` tools
and the financial reports are available — your books can't be modified.

Includes the 11 reports: `get_balance_sheet`, `get_profit_and_loss`,
`get_cash_flow`, `get_trial_balance`, `get_general_ledger`, `get_aged_receivables`,
`get_aged_payables`, `get_customer_sales`, `get_customer_balance`,
`get_vendor_expenses`, `get_vendor_balance`.

To enable create/update/delete (140 tools total), edit
`@appstrate/quickbooks-online-mcp-server` → `server.mcp_config.env` and remove the
`QUICKBOOKS_DISABLE_*` flags, then re-import.

## Notes

- Source: [intuit/quickbooks-online-mcp-server](https://github.com/intuit/quickbooks-online-mcp-server) (MIT).
- `search_*` tools accept QuickBooks query criteria; IDs returned by `search_*`
  feed the matching `get_*` tool.
- Sandbox vs production is decided by the `environment` field **and** which app the
  credentials belong to — they must match.
