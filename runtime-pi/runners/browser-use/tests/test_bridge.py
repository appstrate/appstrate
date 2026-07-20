from __future__ import annotations

import asyncio
import unittest

from appstrate_browser_use import AppstrateBrowser, BrowserConfiguration


class _Page:
    def __init__(self, *, block_navigation: bool = False) -> None:
        self.block_navigation = block_navigation
        self.navigated_to: str | None = None

    async def goto(self, url: str) -> None:
        self.navigated_to = url
        if self.block_navigation:
            await asyncio.Event().wait()

    async def evaluate(self, _function: str, *_args: object) -> object:
        return {
            "url": self.navigated_to or "about:blank",
            "title": "Ready",
            "body_text": "Authenticated",
            "frame_urls": [],
            "ready_state": "complete",
        }


class _Session:
    def __init__(self, page: _Page) -> None:
        self.page = page

    async def get_current_page(self) -> _Page:
        return self.page

    async def navigate_to(self, _url: str) -> None:
        raise AssertionError("navigate() must not wait on the Browser Use event bus")


class BridgeNavigationTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def browser_with(page: _Page) -> AppstrateBrowser:
        browser = AppstrateBrowser()
        browser.configure(
            BrowserConfiguration.parse(
                "http://browser:8080",
                "x" * 32,
                ["https://www.leboncoin.fr"],
            )
        )
        browser._session = _Session(page)  # noqa: SLF001 - isolated bridge contract test
        return browser

    async def test_navigation_uses_page_cdp_and_document_readiness(self) -> None:
        page = _Page()
        snapshot = await self.browser_with(page).navigate(
            "https://www.leboncoin.fr/compte/part/mes-annonces"
        )

        self.assertEqual(page.navigated_to, snapshot.url)
        self.assertEqual(snapshot.ready_state, "complete")

    async def test_navigation_timeout_keeps_the_specific_browser_code(self) -> None:
        browser = self.browser_with(_Page(block_navigation=True))

        with self.assertRaisesRegex(RuntimeError, "^BROWSER_NAVIGATION_TIMEOUT:"):
            await browser.navigate("https://www.leboncoin.fr", timeout_seconds=0.01)


if __name__ == "__main__":
    unittest.main()
