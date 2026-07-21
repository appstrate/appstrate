"""Small, strict line-delimited MCP server used by first-party browser drivers."""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from .validation import ValidationError, safe_browser_error

PROTOCOL_VERSION = "2024-11-05"


class ProtocolError(ValidationError):
    pass


ToolHandler = Callable[[Mapping[str, object]], Awaitable[object]]


class JsonRpcMcpServer:
    def __init__(
        self,
        *,
        name: str,
        version: str,
        tools: Sequence[Mapping[str, object]],
        handlers: Mapping[str, ToolHandler],
    ) -> None:
        self._server_info = {"name": name, "version": version}
        self._tools = list(tools)
        self._handlers = dict(handlers)
        self._lock = asyncio.Lock()

    async def handle(self, request: object) -> dict[str, object] | None:
        if not isinstance(request, dict):
            return None
        request_id = request.get("id")
        method = request.get("method")
        if method == "initialize":
            return self._ok(
                request_id,
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": self._server_info,
                },
            )
        if method == "tools/list":
            return self._ok(request_id, {"tools": self._tools})
        if method == "ping":
            return self._ok(request_id, {})
        if method != "tools/call":
            if request_id is None:
                return None
            return self._rpc_error(request_id, -32601, f"Method not found: {method}")

        params = request.get("params")
        params = params if isinstance(params, dict) else {}
        name = params.get("name") if isinstance(params.get("name"), str) else ""
        arguments = params.get("arguments")
        arguments = arguments if isinstance(arguments, dict) else {}
        handler = self._handlers.get(name)
        if handler is None:
            return self._rpc_error(request_id, -32602, f"Unknown tool: {name or '<unset>'}")
        try:
            async with self._lock:
                output = await handler(arguments)
            return self._ok(
                request_id,
                {"content": [{"type": "text", "text": json.dumps(output, ensure_ascii=False)}]},
            )
        except (ProtocolError, ValidationError) as error:
            return self._rpc_error(request_id, -32602, str(error))
        except Exception as error:
            # Browser errors use a small, platform-recognized code prefix. Do not
            # serialize tracebacks, URLs with queries, DOM, or secret values.
            message = safe_browser_error(error)
            return self._ok(
                request_id,
                {"isError": True, "content": [{"type": "text", "text": message}]},
            )

    async def run_stdio(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            line = await loop.run_in_executor(None, sys.stdin.buffer.readline)
            if not line:
                return
            try:
                request = json.loads(line)
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            response = await self.handle(request)
            if response is not None:
                sys.stdout.write(json.dumps(response, separators=(",", ":"), ensure_ascii=False) + "\n")
                sys.stdout.flush()

    @staticmethod
    def _ok(request_id: Any, result: object) -> dict[str, object]:
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    @staticmethod
    def _rpc_error(request_id: Any, code: int, message: str) -> dict[str, object]:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": code, "message": message},
        }
