"""
Appstrate Dice MCP integration — pure-stdlib reference.

Speaks the MCP JSON-RPC 2.0 stdio dialect directly so the bundle has
no third-party dependencies: no pydantic, no pydantic-core, no wheels
to compile for a specific Python ABI / target OS. The `mcp` Python
SDK would handle this more ergonomically — we skip it to keep this
demonstration of `server.type: "python"` bundle-portable.

Wire format: one JSON-RPC message per line on stdin/stdout. The
client (Appstrate sidecar's integrations-boot MCP client) drives the
`initialize` → `tools/list` → `tools/call` cadence.
"""

import json
import random
import sys


SERVER_INFO = {"name": "appstrate-dice", "version": "1.0.0"}
PROTOCOL_VERSION = "2024-11-05"

TOOLS = [
    {
        "name": "roll_dice",
        "description": (
            "Roll `count` dice with `sides` faces each. Returns the "
            "list of individual rolls and their sum. Pure Python — "
            "uses `random.randint`."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "count": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "default": 1,
                    "description": "Number of dice to roll (1-100).",
                },
                "sides": {
                    "type": "integer",
                    "minimum": 2,
                    "maximum": 1000,
                    "default": 6,
                    "description": "Number of faces per die (2-1000).",
                },
            },
        },
    }
]


def reply(message):
    """Write one JSON-RPC message as a single line on stdout, flush."""
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def handle_call_tool(name, arguments):
    if name != "roll_dice":
        return {
            "isError": True,
            "content": [{"type": "text", "text": f"Unknown tool: {name}"}],
        }
    args = arguments or {}
    count = max(1, min(100, int(args.get("count", 1))))
    sides = max(2, min(1000, int(args.get("sides", 6))))
    rolls = [random.randint(1, sides) for _ in range(count)]
    payload = {"rolls": rolls, "total": sum(rolls), "count": count, "sides": sides}
    return {
        "content": [
            {"type": "text", "text": json.dumps(payload, indent=2)}
        ]
    }


def handle_request(req):
    method = req.get("method")
    req_id = req.get("id")
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            },
        }
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = req.get("params") or {}
        result = handle_call_tool(params.get("name"), params.get("arguments"))
        return {"jsonrpc": "2.0", "id": req_id, "result": result}
    if method and method.startswith("notifications/"):
        # JSON-RPC notifications carry no `id` and expect no response.
        return None
    # Unknown method → JSON-RPC error.
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main():
    sys.stderr.write("[dice] ready\n")
    sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            sys.stderr.write(f"[dice] bad json: {e}\n")
            sys.stderr.flush()
            continue
        try:
            response = handle_request(req)
        except Exception as e:  # noqa: BLE001
            response = {
                "jsonrpc": "2.0",
                "id": req.get("id"),
                "error": {"code": -32000, "message": f"Server error: {e}"},
            }
        if response is not None:
            reply(response)


if __name__ == "__main__":
    main()
