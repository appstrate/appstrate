from __future__ import annotations

import importlib.util
import asyncio
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from appstrate_browser_use.bridge import (
    AppstrateBrowser,
    context_captcha_solver,
    context_file_upload_mode,
)


def _source_root() -> Path:
    configured = os.environ.get("APPSTRATE_BROWSER_DRIVER_SOURCE_ROOT")
    if configured:
        root = Path(configured).resolve()
        if not root.is_dir():
            raise RuntimeError("APPSTRATE_BROWSER_DRIVER_SOURCE_ROOT is not a directory")
        return root
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "scripts" / "system-packages"
        if candidate.is_dir():
            return candidate
    return Path("/nonexistent/appstrate-system-packages")


SOURCE_ROOT = _source_root()
LEBONCOIN_SOURCE = (
    SOURCE_ROOT / "mcp-server-leboncoin-browser-1.0.0" / "server" / "index.py"
)
VINTED_SOURCE = SOURCE_ROOT / "mcp-server-vinted-browser-1.0.0" / "server" / "index.py"
DRIVER_SOURCES_AVAILABLE = LEBONCOIN_SOURCE.is_file() and VINTED_SOURCE.is_file()


def _load_driver(name: str, path: Path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load driver source at {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    # Python 3.9 eagerly binds asyncio primitives constructed by the MCP
    # server's module-level instance. Production is pinned to 3.12, but keep
    # the source-level tests runnable on developer Macs with the system Python.
    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        spec.loader.exec_module(module)
    finally:
        asyncio.set_event_loop(None)
        loop.close()
    return module


class BrowserBridgeTests(unittest.IsolatedAsyncioTestCase):
    def test_context_upload_mode_is_fail_closed(self) -> None:
        self.assertEqual(
            context_file_upload_mode({"fileUploadMode": "shared-filesystem"}),
            "shared-filesystem",
        )
        self.assertEqual(
            context_file_upload_mode({"fileUploadMode": "unsupported"}), "unsupported"
        )
        for malformed in ({}, {"fileUploadMode": "remote-magic"}, None):
            with self.assertRaisesRegex(RuntimeError, "BROWSER_UNAVAILABLE"):
                context_file_upload_mode(malformed)

    def test_context_captcha_solver_is_fail_closed(self) -> None:
        self.assertTrue(context_captcha_solver({"captchaSolver": True}))
        self.assertFalse(context_captcha_solver({"captchaSolver": False}))
        for malformed in ({}, {"captchaSolver": "true"}, None):
            with self.assertRaisesRegex(RuntimeError, "BROWSER_UNAVAILABLE"):
                context_captcha_solver(malformed)

    async def test_managed_captcha_solver_waits_for_a_late_success_event(self) -> None:
        class Result:
            result = "success"

        class Session:
            def __init__(self) -> None:
                self.calls = 0

            async def wait_if_captcha_solving(self, timeout: float) -> object | None:
                self.calls += 1
                return None if self.calls == 1 else Result()

        browser = AppstrateBrowser()
        browser._session = Session()
        browser._captcha_solver = True
        self.assertTrue(await browser.wait_for_captcha_solver(1.0))
        self.assertEqual(browser._session.calls, 2)

        browser._captcha_solver = False
        self.assertFalse(await browser.wait_for_captcha_solver(1.0))

    async def test_remote_browser_rejects_workspace_upload_before_cdp(self) -> None:
        browser = AppstrateBrowser()
        browser._session = object()
        browser._file_upload_mode = "unsupported"
        with self.assertRaisesRegex(RuntimeError, "cannot access workspace files"):
            await browser.upload_files(("/workspace/photo.jpg",))


@unittest.skipUnless(DRIVER_SOURCES_AVAILABLE, "marketplace driver sources are outside image context")
class MarketplaceValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.leboncoin = _load_driver("appstrate_test_leboncoin_driver", LEBONCOIN_SOURCE)
        cls.vinted = _load_driver("appstrate_test_vinted_driver", VINTED_SOURCE)

    def test_leboncoin_urls_and_cookie_domains_are_exact(self) -> None:
        self.assertEqual(
            self.leboncoin.normalize_listing_url(
                "https://www.leboncoin.fr/ad/velos/123?foo=bar#fragment"
            ),
            "https://www.leboncoin.fr/ad/velos/123?foo=bar",
        )
        for url in (
            "https://www.leboncoin.fr.evil.test/ad/123",
            "https://user@www.leboncoin.fr/ad/123",
            "https://www.leboncoin.fr:443/ad/123",
            "https://www.leboncoin.fr/not-an-ad/123",
        ):
            with self.assertRaises(self.leboncoin.ProtocolError):
                self.leboncoin.normalize_listing_url(url)
        self.assertTrue(self.leboncoin.cookie_domain_matches(".leboncoin.fr", "leboncoin.fr"))
        self.assertTrue(
            self.leboncoin.cookie_domain_matches("auth.leboncoin.fr", "leboncoin.fr")
        )
        self.assertFalse(
            self.leboncoin.cookie_domain_matches("evilleboncoin.fr", "leboncoin.fr")
        )
        self.assertFalse(self.leboncoin.cookie_domain_matches("..leboncoin.fr", "leboncoin.fr"))
        self.assertFalse(
            self.leboncoin.has_session(
                [
                    {
                        "name": self.leboncoin.LOGIN_COOKIE,
                        "value": "secret",
                        "domain": "evilleboncoin.fr",
                    }
                ]
            )
        )

    def test_vinted_urls_prices_and_cookie_domains_are_bounded(self) -> None:
        self.assertEqual(
            self.vinted.normalize_item_url("https://www.vinted.fr/items/123-blue-shirt/?x=1"),
            "https://www.vinted.fr/items/123-blue-shirt",
        )
        for url in (
            "https://www.vinted.fr.evil.test/items/123",
            "https://user@www.vinted.fr/items/123",
            "https://www.vinted.fr:443/items/123",
            "https://www.vinted.fr/member/123",
        ):
            with self.assertRaises(self.vinted.ProtocolError):
                self.vinted.normalize_item_url(url)
        self.assertEqual(self.vinted.normalize_price("12,5"), "12.50")
        for price in ("0", "-1", "1.234", "1000000"):
            with self.assertRaises(self.vinted.ProtocolError):
                self.vinted.normalize_price(price)
        self.assertTrue(self.vinted.cookie_domain_matches("www.vinted.fr", "vinted.fr"))
        self.assertFalse(self.vinted.cookie_domain_matches("evilvinted.fr", "vinted.fr"))

    def test_vinted_workspace_images_reject_escape_and_invalid_content(self) -> None:
        with tempfile.TemporaryDirectory() as workspace_value, tempfile.TemporaryDirectory() as outside:
            workspace = Path(workspace_value)
            valid = workspace / "photo.jpg"
            valid.write_bytes(b"\xff\xd8\xff" + b"image")
            invalid = workspace / "text.jpg"
            invalid.write_text("not an image", encoding="utf-8")
            external = Path(outside) / "outside.jpg"
            external.write_bytes(b"\xff\xd8\xff" + b"outside")
            (workspace / "escape.jpg").symlink_to(external)
            with mock.patch.dict(os.environ, {"APPSTRATE_WORKSPACE": workspace_value}):
                self.assertEqual(
                    self.vinted.resolve_workspace_images(["photo.jpg"]),
                    (str(valid.resolve()),),
                )
                for path in ("../outside.jpg", "escape.jpg", "text.jpg"):
                    with self.assertRaises(self.vinted.ProtocolError):
                        self.vinted.resolve_workspace_images([path])


@unittest.skipUnless(DRIVER_SOURCES_AVAILABLE, "marketplace driver sources are outside image context")
class MarketplaceBehaviorTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.leboncoin = _load_driver("appstrate_test_leboncoin_behavior", LEBONCOIN_SOURCE)
        cls.vinted = _load_driver("appstrate_test_vinted_behavior", VINTED_SOURCE)

    async def test_leboncoin_session_proof_requires_account_page_and_cookie(self) -> None:
        module = self.leboncoin

        class Browser:
            def __init__(self, url: str, domain: str) -> None:
                self.url = url
                self.domain = domain

            async def navigate(self, url: str) -> object:
                self.requested = url
                return types.SimpleNamespace(
                    url=self.url, title="Account", body_text="Mes annonces", frame_urls=()
                )

            async def cookies(self) -> list[dict[str, object]]:
                return [{"name": module.LOGIN_COOKIE, "value": "session", "domain": self.domain}]

        driver = module.LeboncoinDriver()
        driver.browser = Browser(module.LEBONCOIN_ACCOUNT_URL, ".leboncoin.fr")
        self.assertTrue(await driver._prove_session())
        self.assertEqual(driver.browser.requested, module.LEBONCOIN_ACCOUNT_URL)

        driver.browser = Browser("https://auth.leboncoin.fr/login", ".leboncoin.fr")
        self.assertFalse(await driver._prove_session())
        driver.browser = Browser(module.LEBONCOIN_ACCOUNT_URL, "evilleboncoin.fr")
        self.assertFalse(await driver._prove_session())

    async def test_leboncoin_waits_for_managed_datadome_solver(self) -> None:
        module = self.leboncoin
        challenged = types.SimpleNamespace(
            url="https://www.leboncoin.fr/",
            title="Pardon the interruption",
            body_text="DataDome",
            frame_urls=("https://geo.captcha-delivery.com/captcha",),
        )
        cleared = types.SimpleNamespace(
            url="https://www.leboncoin.fr/",
            title="Leboncoin",
            body_text="Bienvenue",
            frame_urls=(),
        )

        class Browser:
            async def wait_for_captcha_solver(self, timeout: float) -> bool:
                self.timeout = timeout
                return True

            async def snapshot(self) -> object:
                return cleared

        driver = module.LeboncoinDriver()
        driver.browser = Browser()
        self.assertIs(await driver._assert_no_challenge(challenged), cleared)
        self.assertEqual(driver.browser.timeout, module.CHALLENGE_WAIT_SECONDS)

    async def test_leboncoin_resumes_after_human_clears_datadome(self) -> None:
        module = self.leboncoin
        challenged = types.SimpleNamespace(
            url="https://www.leboncoin.fr/",
            title="DataDome",
            body_text="Verify you are human",
            frame_urls=(),
        )
        cleared = types.SimpleNamespace(
            url="https://www.leboncoin.fr/",
            title="Leboncoin",
            body_text="Bienvenue",
            frame_urls=(),
        )

        class Browser:
            async def wait_for_captcha_solver(self, _timeout: float) -> bool:
                return False

            async def snapshot(self) -> object:
                return cleared

        driver = module.LeboncoinDriver()
        driver.browser = Browser()
        self.assertIs(await driver._assert_no_challenge(challenged), cleared)

    async def test_leboncoin_fails_closed_when_managed_solver_cannot_clear_challenge(self) -> None:
        module = self.leboncoin
        challenged = types.SimpleNamespace(
            url="https://geo.captcha-delivery.com/captcha",
            title="DataDome",
            body_text="Verify you are human",
            frame_urls=(),
        )

        class Browser:
            async def wait_for_captcha_solver(self, _timeout: float) -> bool:
                return False

            async def snapshot(self) -> object:
                return challenged

        driver = module.LeboncoinDriver()
        driver.browser = Browser()
        with mock.patch.object(module, "CHALLENGE_WAIT_SECONDS", 0.001):
            with self.assertRaisesRegex(RuntimeError, "BROWSER_INTERACTION_REQUIRED"):
                await driver._assert_no_challenge(challenged)

    async def test_vinted_publish_token_is_consumed_before_click(self) -> None:
        module = self.vinted

        class Browser:
            click_count = 0

            async def snapshot(self) -> object:
                return types.SimpleNamespace(
                    url="https://www.vinted.fr/items/new",
                    title="Draft",
                    body_text="",
                    frame_urls=(),
                )

            async def click_semantic(self, _labels: object, required: bool = False) -> bool:
                self.click_count += 1
                return False

        draft = module.Draft(
            token="x" * 43,
            title="Jacket",
            description="Blue jacket",
            price="12.00",
            category="Women > Jackets",
            condition="Good",
            brand=None,
            size=None,
            parcel_size=None,
            image_paths=("/workspace/photo.jpg",),
        )
        driver = module.VintedDriver()
        driver.browser = Browser()
        driver.draft = draft
        with self.assertRaises(module.ProtocolError):
            await driver.publish("wrong-token".ljust(43, "x"))
        self.assertEqual(driver.browser.click_count, 0)
        self.assertIs(driver.draft, draft)

        with self.assertRaisesRegex(RuntimeError, "publish action is unavailable"):
            await driver.publish(draft.token)
        self.assertIsNone(driver.draft)
        self.assertEqual(driver.browser.click_count, 1)
        with self.assertRaises(module.ProtocolError):
            await driver.publish(draft.token)
        self.assertEqual(driver.browser.click_count, 1)

    async def test_vinted_waits_for_human_verification_redirect(self) -> None:
        module = self.vinted

        class Browser:
            def __init__(self) -> None:
                self.snapshots = [
                    types.SimpleNamespace(
                        url="https://www.vinted.fr/member/login",
                        title="Verification",
                        body_text="Enter the code sent by email",
                        frame_urls=(),
                    ),
                    types.SimpleNamespace(
                        url="https://www.vinted.fr/items/new",
                        title="New item",
                        body_text="Sell an item",
                        frame_urls=(),
                    ),
                ]

            async def current_url(self) -> str:
                return "https://www.vinted.fr/member/login"

            async def navigate(self, _url: str) -> object:
                return self.snapshots[0]

            async def snapshot(self) -> object:
                return self.snapshots.pop(0)

            async def evaluate(self, _expression: str) -> bool:
                return len(self.snapshots) == 0

        async def no_sleep(_seconds: float) -> None:
            return None

        driver = module.VintedDriver()
        driver.browser = Browser()
        with mock.patch.object(module.asyncio, "sleep", new=no_sleep):
            self.assertTrue(await driver._wait_for_listing_form(1.0))

    async def test_vinted_publish_accepts_only_exact_item_confirmation(self) -> None:
        module = self.vinted

        class Browser:
            def __init__(self) -> None:
                self.snapshots = [
                    types.SimpleNamespace(
                        url="https://www.vinted.fr/items/new",
                        title="Draft",
                        body_text="",
                        frame_urls=(),
                    ),
                    types.SimpleNamespace(
                        url="https://www.vinted.fr/items/123-blue-jacket?ref=publish",
                        title="Blue jacket",
                        body_text="Published",
                        frame_urls=(),
                    ),
                ]

            async def snapshot(self) -> object:
                return self.snapshots.pop(0)

            async def click_semantic(self, _labels: object, required: bool = False) -> bool:
                return True

        draft = module.Draft(
            token="y" * 43,
            title="Blue jacket",
            description="As new",
            price="25.00",
            category="Women > Jackets",
            condition="Very good",
            brand=None,
            size=None,
            parcel_size=None,
            image_paths=("/workspace/photo.jpg",),
        )
        driver = module.VintedDriver()
        driver.browser = Browser()
        driver.draft = draft

        async def no_sleep(_seconds: float) -> None:
            return None

        with mock.patch.object(module.asyncio, "sleep", new=no_sleep):
            result = await driver.publish(draft.token)
        self.assertEqual(
            result,
            {
                "published": True,
                "url": "https://www.vinted.fr/items/123-blue-jacket",
                "title": "Blue jacket",
                "price_eur": "25.00",
            },
        )
        self.assertIsNone(driver.draft)


if __name__ == "__main__":
    unittest.main()
