"""
Appstrate connect-tool-test MCP integration — pure-stdlib reference for the
P1–P3 connect.tool (run-start) substrate.

Two tools:

  - `login`: a MULTI-STEP HTTPS dance, run at boot by the sidecar's
    connect-login hook (NEVER exposed to the agent). Every outbound call
    goes through the env `HTTPS_PROXY` (the sidecar's per-integration MITM
    listener) and trusts the run CA via SSL_CERT_FILE / REQUESTS_CA_BUNDLE.

      1. GET  https://connecttool.test.appstrate.dev/csrf  → read {"csrf": …}
      2. POST https://connecttool.test.appstrate.dev/login with a form body
         carrying the csrf token AND the LITERAL placeholders
         `username={{email}}&password={{password}}`. The MITM substitutes
         `{{email}}` / `{{password}}` proxy-side — the tool is invoked with
         EMPTY arguments and never reads any real secret.
         Read {"session_token": …} from the response.
      3. Return one text content block = the JSON contract `runConnectLogin`
         parses: {"outputs": {"session_token": "<tok>"}, "expiresAt": null}.

  - `fetch_data`: GET https://connecttool.test.appstrate.dev/data with NO
    auth header set by the tool. The MITM injects
    `Authorization: Bearer <session_token>` (the captured session). Returns
    the upstream response body verbatim (the mock echoes the Authorization
    header it saw), so a test can prove the injected session reached upstream.

Wire format: JSON-RPC 2.0 one-message-per-line on stdin/stdout, same
dialect as the mitm-test integration. The sidecar drives initialize →
tools/list → tools/call.
"""

import json
import sys
import threading
import urllib.request
import urllib.error


SERVER_INFO = {"name": "appstrate-connect-tool-test", "version": "1.0.0"}
PROTOCOL_VERSION = "2024-11-05"

BASE = "https://connecttool.test.appstrate.dev"

TOOLS = [
    {
        "name": "login",
        "description": (
            "Run the multi-step login dance (GET /csrf → POST /login). "
            "Invoked at run-start by the platform with empty arguments; the "
            "MITM substitutes the {{email}}/{{password}} placeholders "
            "proxy-side. Returns the captured session_token. NEVER exposed "
            "to the agent."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "fetch_data",
        "description": (
            "GET https://connecttool.test.appstrate.dev/data. The tool sets "
            "no auth header — the MITM injects Authorization: Bearer "
            "<session_token>. Returns the upstream body, which echoes the "
            "Authorization header it saw."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
]


# Serialise concurrent stdout writes — `tools/call` runs on worker threads
# (see `_main`) so a mid-run re-login can be dispatched while another tool's
# upstream request is parked by the MITM proxy. Without this, a single-
# threaded read loop would deadlock: `fetch_data`'s 401 retry needs the
# `login` tool, but the loop can't read it until `fetch_data` returns.
_stdout_lock = threading.Lock()


def _send(message):
    with _stdout_lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def _result(rpc_id, payload):
    _send({"jsonrpc": "2.0", "id": rpc_id, "result": payload})


def _error(rpc_id, code, message):
    _send({"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}})


def _text_result(text, is_error=False):
    out = {"content": [{"type": "text", "text": text}]}
    if is_error:
        out["isError"] = True
    return out


def _http_get(url):
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status, resp.read(8192)


def _http_post_form(url, form_body):
    data = form_body.encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status, resp.read(8192)


def _login(_args):
    # Step 1 — fetch the CSRF token. The tool reads csrf from the response
    # and embeds it in the next request. No secret is involved here.
    try:
        status, body = _http_get(f"{BASE}/csrf")
    except urllib.error.HTTPError as e:
        return _text_result(f"login: /csrf HTTP {e.code}", is_error=True)
    except Exception as e:
        return _text_result(f"login: /csrf failed: {type(e).__name__}: {e}", is_error=True)
    if status != 200:
        return _text_result(f"login: /csrf returned status {status}", is_error=True)
    try:
        csrf = json.loads(body.decode("utf-8")).get("csrf")
    except Exception as e:
        return _text_result(f"login: /csrf malformed JSON: {e}", is_error=True)
    if not csrf:
        return _text_result("login: /csrf response missing 'csrf'", is_error=True)

    # Step 2 — POST the login form. The body carries the csrf token AND the
    # LITERAL placeholders. The MITM substitutes {{email}}/{{password}}
    # proxy-side; this process never sees the real credentials.
    form = f"csrf={csrf}&username={{{{email}}}}&password={{{{password}}}}"
    try:
        status, body = _http_post_form(f"{BASE}/login", form)
    except urllib.error.HTTPError as e:
        return _text_result(f"login: /login HTTP {e.code}", is_error=True)
    except Exception as e:
        return _text_result(f"login: /login failed: {type(e).__name__}: {e}", is_error=True)
    if status != 200:
        return _text_result(f"login: /login returned status {status}", is_error=True)
    try:
        token = json.loads(body.decode("utf-8")).get("session_token")
    except Exception as e:
        return _text_result(f"login: /login malformed JSON: {e}", is_error=True)
    if not token:
        return _text_result("login: /login response missing 'session_token'", is_error=True)

    # Step 3 — return the connect-login contract runConnectLogin parses.
    return _text_result(json.dumps({"outputs": {"session_token": token}, "expiresAt": None}))


def _fetch_data(_args):
    # No auth header here — the MITM injects Authorization: Bearer <token>.
    try:
        status, body = _http_get(f"{BASE}/data")
    except urllib.error.HTTPError as e:
        b = e.read(8192) if hasattr(e, "read") else b""
        return _text_result(
            json.dumps({"status": e.code, "body": b.decode("utf-8", errors="replace")}),
            is_error=True,
        )
    except Exception as e:
        return _text_result(
            f"fetch_data failed: {type(e).__name__}: {e}", is_error=True
        )
    return _text_result(
        json.dumps({"status": status, "body": body.decode("utf-8", errors="replace")})
    )


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
        # Dispatch on a worker thread so the read loop stays free to handle a
        # concurrent re-login (`login`) while this tool's upstream request is
        # parked by the MITM (P3 reauth path). Each call is independent.
        threading.Thread(target=_run_tool, args=(rpc_id, params), daemon=True).start()
        return

    if method == "ping":
        return _result(rpc_id, {})

    if rpc_id is not None:
        _error(rpc_id, -32601, f"Method not found: {method}")


def _run_tool(rpc_id, params):
    tool_name = params.get("name")
    args = params.get("arguments") or {}
    try:
        if tool_name == "login":
            _result(rpc_id, _login(args))
        elif tool_name == "fetch_data":
            _result(rpc_id, _fetch_data(args))
        else:
            _error(rpc_id, -32601, f"Unknown tool: {tool_name}")
    except Exception as e:
        if rpc_id is not None:
            _error(rpc_id, -32603, f"Internal error: {type(e).__name__}: {e}")


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
