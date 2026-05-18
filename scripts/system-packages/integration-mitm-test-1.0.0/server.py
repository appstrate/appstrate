"""
Appstrate MITM-test MCP integration — pure-stdlib reference for Phase 1.5.

Exposes one tool, `call_upstream`, that issues an HTTPS GET to the
upstream the manifest's `authorizedUris` declares. The integration
itself NEVER reads the API key — the sidecar's MITM proxy intercepts
the connection, mints a leaf cert for the SNI host, and injects the
`X-Mitm-Test-Token: <apiKey>` header transparently.

The tool returns the upstream response status + body so test assertions
can verify the header reached the destination (when the upstream is a
mock that echoes received headers).

Wire format: JSON-RPC 2.0 one-message-per-line on stdin/stdout, same
dialect as the dice integration. Sidecar drives initialize → tools/list
→ tools/call.
"""

import json
import sys
import urllib.request
import urllib.error


SERVER_INFO = {"name": "appstrate-mitm-test", "version": "1.0.0"}
PROTOCOL_VERSION = "2024-11-05"

TOOLS = [
    {
        "name": "call_upstream",
        "description": (
            "GET https://api.test.appstrate.dev/<path>. The sidecar's "
            "MITM proxy adds the X-Mitm-Test-Token header before the "
            "request leaves the integration container — the bundle "
            "itself sends no auth header. Returns the upstream status "
            "code + first 1 KiB of body."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "default": "/echo",
                    "description": "Path under the upstream host (must start with /).",
                },
            },
        },
    }
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


def _call_upstream(args):
    path = args.get("path", "/echo") if isinstance(args, dict) else "/echo"
    if not isinstance(path, str) or not path.startswith("/"):
        return {
            "content": [
                {"type": "text", "text": "error: 'path' must be a string starting with '/'."}
            ],
            "isError": True,
        }
    url = f"https://api.test.appstrate.dev{path}"
    # IMPORTANT: no headers added here. The MITM proxy is the only place
    # the credential is injected. If we set our own Authorization-shaped
    # header AND the manifest's `allowServerOverride` is false (the
    # default), the proxy strips it before forwarding.
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read(1024)
            return {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(
                            {
                                "status": resp.status,
                                "url": url,
                                "body": body.decode("utf-8", errors="replace"),
                            }
                        ),
                    }
                ]
            }
    except urllib.error.HTTPError as e:
        body = e.read(1024) if hasattr(e, "read") else b""
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "status": e.code,
                            "url": url,
                            "body": body.decode("utf-8", errors="replace"),
                        }
                    ),
                }
            ],
            "isError": True,
        }
    except Exception as e:
        return {
            "content": [
                {
                    "type": "text",
                    "text": f"call_upstream failed: {type(e).__name__}: {e}",
                }
            ],
            "isError": True,
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
        return  # notifications carry no id; no reply expected

    if method == "tools/list":
        return _result(rpc_id, {"tools": TOOLS})

    if method == "tools/call":
        tool_name = params.get("name")
        if tool_name != "call_upstream":
            return _error(rpc_id, -32601, f"Unknown tool: {tool_name}")
        return _result(rpc_id, _call_upstream(params.get("arguments") or {}))

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
        except Exception as e:
            rpc_id = message.get("id") if isinstance(message, dict) else None
            if rpc_id is not None:
                _error(rpc_id, -32603, f"Internal error: {type(e).__name__}: {e}")


if __name__ == "__main__":
    _main()
