from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace

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


class _CommandRecorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object, object]] = []
        self.cookie_result: list[dict[str, object]] = []
        self.Storage = SimpleNamespace(
            setCookies=self._record("Storage.setCookies"),
            getCookies=self._get_cookies,
        )
        self.Page = SimpleNamespace(
            addScriptToEvaluateOnNewDocument=self._record("Page.addInitScript"),
            removeScriptToEvaluateOnNewDocument=self._record("Page.removeInitScript"),
        )

    def _record(self, name: str):
        async def call(params: object = None, session_id: object = None) -> dict[str, object]:
            self.calls.append((name, params, session_id))
            return {"identifier": "storage-script"} if name == "Page.addInitScript" else {}

        return call

    async def _get_cookies(
        self,
        params: object = None,
        session_id: object = None,
    ) -> dict[str, object]:
        self.calls.append(("Storage.getCookies", params, session_id))
        return {"cookies": self.cookie_result}


class _StorageSession(_Session):
    def __init__(self, page: _Page) -> None:
        super().__init__(page)
        self.commands = _CommandRecorder()
        self.cdp_client = SimpleNamespace(send=self.commands)

    async def get_or_create_cdp_session(
        self,
        target_id: object = None,
        focus: bool = True,
    ) -> object:
        self.requested_session = (target_id, focus)
        return SimpleNamespace(
            cdp_client=self.cdp_client,
            session_id="target-session",
        )


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

    async def test_storage_restore_uses_one_shot_init_script_without_navigation(self) -> None:
        page = _Page()
        browser = self.browser_with(page)
        browser._session = _StorageSession(page)  # noqa: SLF001 - isolated bridge contract test

        await browser.restore_storage_state_json(
            '{"version":1,"cookies":[],"origins":['
            '{"origin":"https://www.leboncoin.fr","localStorage":['
            '{"name":"session-key","value":"session-value"}]}'
            ']}'
        )

        self.assertIsNone(page.navigated_to)
        self.assertEqual(browser._session.requested_session, (None, False))
        self.assertEqual(
            [name for name, _params, _session_id in browser._session.commands.calls],
            [
                "Storage.setCookies",
                "Page.addInitScript",
            ],
        )
        add_script = browser._session.commands.calls[1]
        self.assertIn(
            '"https://www.leboncoin.fr":[["session-key","session-value"]]',
            add_script[1]["source"],
        )
        self.assertEqual(add_script[2], "target-session")

        await browser.navigate("https://www.leboncoin.fr")
        self.assertEqual(
            [name for name, _params, _session_id in browser._session.commands.calls],
            ["Storage.setCookies", "Page.addInitScript", "Page.removeInitScript"],
        )
        self.assertEqual(browser._session.commands.calls[2][2], "target-session")

    async def test_wait_ready_retries_transient_page_replacement(self) -> None:
        page = _Page()
        browser = self.browser_with(page)
        calls = 0
        original_snapshot = browser.snapshot

        async def transient_snapshot():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("BROWSER_UNAVAILABLE: page evaluation failed")
            return await original_snapshot()

        browser.snapshot = transient_snapshot  # type: ignore[method-assign]
        snapshot = await browser.wait_ready(timeout_seconds=1.0)

        self.assertEqual(snapshot.ready_state, "complete")
        self.assertEqual(calls, 2)

    async def test_state_export_reads_browser_scope_and_preserves_local_storage(self) -> None:
        page = _Page()
        browser = self.browser_with(page)
        session = _StorageSession(page)
        session.commands.cookie_result = [
            {
                "name": "login_token",
                "value": "updated-cookie",
                "domain": "www.leboncoin.fr",
                "path": "/",
                "secure": True,
                "httpOnly": True,
                "sameSite": "Lax",
            }
        ]
        browser._session = session  # noqa: SLF001 - isolated bridge contract test
        await browser.restore_storage_state_json(
            '{"version":1,"cookies":[],"origins":['
            '{"origin":"https://www.leboncoin.fr","localStorage":['
            '{"name":"session-key","value":"session-value"}]}'
            ']}'
        )

        exported = await browser.export_storage_state_json()

        self.assertIn('"value":"updated-cookie"', exported)
        self.assertIn('"name":"session-key","value":"session-value"', exported)
        get_cookies = session.commands.calls[-1]
        self.assertEqual(get_cookies, ("Storage.getCookies", None, None))


if __name__ == "__main__":
    unittest.main()
