"""Appstrate's deterministic Browser Use bridge for trusted system drivers."""

from .bridge import AppstrateBrowser, BrowserConfiguration, BrowserSnapshot
from .mcp import JsonRpcMcpServer, ProtocolError
from .validation import (
    bounded_cookie_header,
    canonical_browser_endpoint,
    canonical_https_origins,
    detect_datadome_challenge,
    required_string,
)

__all__ = [
    "AppstrateBrowser",
    "BrowserConfiguration",
    "BrowserSnapshot",
    "JsonRpcMcpServer",
    "ProtocolError",
    "bounded_cookie_header",
    "canonical_browser_endpoint",
    "canonical_https_origins",
    "detect_datadome_challenge",
    "required_string",
]
