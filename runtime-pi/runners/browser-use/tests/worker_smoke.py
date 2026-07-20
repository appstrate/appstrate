#!/usr/bin/env python3
"""Live Browser Use smoke against an authenticated Appstrate browser worker."""

from __future__ import annotations

import asyncio
import json
import sys
from urllib.parse import urlsplit

import httpx

from appstrate_browser_use import (
    AppstrateBrowser,
    BrowserConfiguration,
    detect_datadome_challenge,
)


async def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("usage: worker_smoke.py ENDPOINT TOKEN ORIGINS_JSON URL")
    endpoint, token, origins_json, target_url = sys.argv[1:]
    origins = json.loads(origins_json)
    async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
        unauthorized = await client.get(f"{endpoint}/json/version")
    if unauthorized.status_code != 401:
        raise AssertionError(f"unauthenticated discovery returned {unauthorized.status_code}")

    browser = AppstrateBrowser()
    browser.configure(BrowserConfiguration.parse(endpoint, token, origins))
    try:
        await browser.start()
        snapshot = await browser.navigate(target_url, timeout_seconds=45.0)
        state = await browser._session.get_browser_state_summary(  # noqa: SLF001 - live contract probe
            include_screenshot=False,
            cached=False,
        )
        if not snapshot.url.startswith("https://"):
            raise AssertionError(f"unexpected final URL: {snapshot.url}")
        if not isinstance(state.dom_state.selector_map, dict):
            raise AssertionError("Browser Use did not return a selector map")
        smoke_domain = urlsplit(target_url).hostname
        if not smoke_domain:
            raise AssertionError("target URL has no hostname")
        await browser.restore_storage_state_json(
            json.dumps(
                {
                    "version": 1,
                    "cookies": [
                        {
                            "name": "appstrate_browser_use_smoke",
                            "value": "restored",
                            "domain": smoke_domain,
                            "path": "/",
                            "secure": True,
                            "httpOnly": False,
                        }
                    ],
                    "origins": [],
                }
            )
        )
        restored = await browser.cookies()
        if not any(cookie.get("name") == "appstrate_browser_use_smoke" for cookie in restored):
            raise AssertionError("storage-state restore did not reach Chromium")
        policy_denied = False
        try:
            await browser.navigate("https://example.invalid/")
        except RuntimeError as error:
            policy_denied = str(error).startswith("BROWSER_POLICY_DENIED:")
        if not policy_denied:
            raise AssertionError("off-origin navigation did not fail closed")
        print(
            json.dumps(
                {
                    "ok": True,
                    "url": snapshot.url,
                    "title": snapshot.title,
                    "interactive_elements": len(state.dom_state.selector_map),
                    "datadome_challenge": detect_datadome_challenge(snapshot),
                    "storage_state_restore": True,
                    "engine": "browser-use",
                },
                ensure_ascii=False,
            )
        )
    finally:
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
