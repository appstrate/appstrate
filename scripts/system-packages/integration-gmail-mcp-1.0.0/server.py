"""
Appstrate Gmail MCP integration — pure-stdlib reference for OAuth2 +
`delivery.http` (Phase 1.5 MITM credential injection).

Exposes three tools backed by the Gmail REST v1 API:

  - list_messages(maxResults?, query?, labelIds?)
  - get_message(id, format?)
  - search_messages(query, maxResults?)   (convenience wrapper)

The bundle NEVER reads the OAuth2 access token. The sidecar's MITM
proxy intercepts the HTTPS connection to `gmail.googleapis.com`, mints
a leaf cert for the SNI host, and injects the `Authorization: Bearer
<accessToken>` header transparently — refreshing the token in place
when it nears expiry, and forcing a refresh on a mid-call 401.

Wire format: JSON-RPC 2.0 one-message-per-line on stdin/stdout. Same
dialect as `@appstrate/dice` and `@appstrate/mitm-test`.
"""

import json
import sys
import urllib.error
import urllib.parse
import urllib.request


SERVER_INFO = {"name": "appstrate-gmail-mcp", "version": "1.0.0"}
PROTOCOL_VERSION = "2024-11-05"
BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me"

TOOLS = [
    {
        "name": "list_messages",
        "description": (
            "List the most recent messages in the authenticated user's "
            "mailbox. Returns the message id + threadId list (use "
            "get_message to fetch payload). Supports a Gmail search "
            "query and label filtering."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "default": 10,
                    "description": "How many messages to list (1-100).",
                },
                "query": {
                    "type": "string",
                    "description": (
                        "Gmail search query (e.g. 'from:foo@bar.com', "
                        "'is:unread', 'subject:invoice newer_than:7d')."
                    ),
                },
                "labelIds": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Restrict to messages carrying every label id "
                        "(e.g. 'INBOX', 'UNREAD', 'STARRED'). "
                        "AND-combined."
                    ),
                },
            },
        },
    },
    {
        "name": "get_message",
        "description": (
            "Fetch a single message by id. Default format 'metadata' "
            "returns From/To/Subject/Date headers + snippet. Use 'full' "
            "for the parsed body, 'raw' for the original RFC 822 source."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["id"],
            "properties": {
                "id": {
                    "type": "string",
                    "description": "Message id returned by list_messages.",
                },
                "format": {
                    "type": "string",
                    "enum": ["minimal", "metadata", "full", "raw"],
                    "default": "metadata",
                    "description": "Gmail API payload shape.",
                },
            },
        },
    },
    {
        "name": "search_messages",
        "description": (
            "Search the mailbox and return message metadata "
            "(From/Subject/snippet) in one round-trip. Convenience "
            "wrapper around list_messages + get_message(format=metadata)."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Gmail search query.",
                },
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 25,
                    "default": 10,
                    "description": "How many results to materialise (1-25).",
                },
            },
        },
    },
]


def _send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def _result(rpc_id, payload):
    _send({"jsonrpc": "2.0", "id": rpc_id, "result": payload})


def _error(rpc_id, code, message):
    _send(
        {
            "jsonrpc": "2.0",
            "id": rpc_id,
            "error": {"code": code, "message": message},
        }
    )


def _text(payload, *, is_error=False):
    out = {"content": [{"type": "text", "text": json.dumps(payload, indent=2)}]}
    if is_error:
        out["isError"] = True
    return out


def _gmail_get(path, query=None):
    """GET against Gmail API. Auth is injected by the sidecar MITM proxy."""
    url = BASE_URL + path
    if query:
        # urlencode strips empty/None values, repeats keys for lists.
        items = []
        for k, v in query.items():
            if v is None:
                continue
            if isinstance(v, (list, tuple)):
                for item in v:
                    items.append((k, str(item)))
            else:
                items.append((k, str(v)))
        if items:
            url = f"{url}?{urllib.parse.urlencode(items)}"
    req = urllib.request.Request(url, method="GET", headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = resp.read()
        return json.loads(body.decode("utf-8"))


def _format_http_error(e):
    body = ""
    try:
        body = e.read(2048).decode("utf-8", errors="replace") if hasattr(e, "read") else ""
    except Exception:  # noqa: BLE001
        body = ""
    return _text(
        {
            "error": "Gmail API error",
            "status": getattr(e, "code", None),
            "body": body[:2048],
        },
        is_error=True,
    )


def _list_messages(args):
    query = {
        "maxResults": max(1, min(100, int(args.get("maxResults", 10)))),
    }
    if args.get("query"):
        query["q"] = str(args["query"])
    label_ids = args.get("labelIds")
    if isinstance(label_ids, list) and label_ids:
        query["labelIds"] = [str(x) for x in label_ids if x]
    try:
        data = _gmail_get("/messages", query)
    except urllib.error.HTTPError as e:
        return _format_http_error(e)
    except Exception as e:  # noqa: BLE001
        return _text({"error": f"{type(e).__name__}: {e}"}, is_error=True)
    return _text(
        {
            "resultSizeEstimate": data.get("resultSizeEstimate", 0),
            "messages": data.get("messages", []),
            "nextPageToken": data.get("nextPageToken"),
        }
    )


def _get_message(args):
    if not isinstance(args, dict) or not args.get("id"):
        return _text({"error": "'id' is required"}, is_error=True)
    message_id = str(args["id"])
    fmt = args.get("format", "metadata")
    if fmt not in ("minimal", "metadata", "full", "raw"):
        return _text({"error": f"invalid format: {fmt}"}, is_error=True)
    query = {"format": fmt}
    if fmt == "metadata":
        # Only the headers we typically care about — keeps payload small.
        query["metadataHeaders"] = ["From", "To", "Cc", "Subject", "Date"]
    try:
        data = _gmail_get(f"/messages/{urllib.parse.quote(message_id)}", query)
    except urllib.error.HTTPError as e:
        return _format_http_error(e)
    except Exception as e:  # noqa: BLE001
        return _text({"error": f"{type(e).__name__}: {e}"}, is_error=True)
    return _text(data)


def _search_messages(args):
    if not isinstance(args, dict) or not args.get("query"):
        return _text({"error": "'query' is required"}, is_error=True)
    query = str(args["query"])
    max_results = max(1, min(25, int(args.get("maxResults", 10))))

    try:
        listing = _gmail_get("/messages", {"q": query, "maxResults": max_results})
    except urllib.error.HTTPError as e:
        return _format_http_error(e)
    except Exception as e:  # noqa: BLE001
        return _text({"error": f"{type(e).__name__}: {e}"}, is_error=True)

    ids = [m.get("id") for m in (listing.get("messages") or []) if m.get("id")]
    materialised = []
    for mid in ids:
        try:
            msg = _gmail_get(
                f"/messages/{urllib.parse.quote(mid)}",
                {
                    "format": "metadata",
                    "metadataHeaders": ["From", "Subject", "Date"],
                },
            )
        except urllib.error.HTTPError:
            continue
        except Exception:  # noqa: BLE001
            continue
        headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
        materialised.append(
            {
                "id": msg.get("id"),
                "threadId": msg.get("threadId"),
                "labelIds": msg.get("labelIds", []),
                "snippet": msg.get("snippet", ""),
                "from": headers.get("From"),
                "subject": headers.get("Subject"),
                "date": headers.get("Date"),
            }
        )

    return _text(
        {
            "query": query,
            "count": len(materialised),
            "messages": materialised,
        }
    )


TOOL_HANDLERS = {
    "list_messages": _list_messages,
    "get_message": _get_message,
    "search_messages": _search_messages,
}


def _handle(message):
    method = message.get("method")
    rpc_id = message.get("id")
    params = message.get("params") or {}

    if method == "initialize":
        return _result(
            rpc_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            },
        )
    if method == "notifications/initialized":
        return

    if method == "tools/list":
        return _result(rpc_id, {"tools": TOOLS})

    if method == "tools/call":
        tool_name = params.get("name")
        handler = TOOL_HANDLERS.get(tool_name)
        if handler is None:
            return _error(rpc_id, -32601, f"Unknown tool: {tool_name}")
        return _result(rpc_id, handler(params.get("arguments") or {}))

    if method == "ping":
        return _result(rpc_id, {})

    if rpc_id is not None:
        _error(rpc_id, -32601, f"Method not found: {method}")


def _main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            _handle(message)
        except Exception as e:  # noqa: BLE001
            rpc_id = message.get("id") if isinstance(message, dict) else None
            if rpc_id is not None:
                _error(rpc_id, -32603, f"Internal error: {type(e).__name__}: {e}")


if __name__ == "__main__":
    _main()
