"""Authenticated Browser Use adapter over Appstrate's guarded CDP worker."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from .validation import (
    ChallengeSnapshot,
    canonical_browser_endpoint,
    canonical_https_origins,
    cookie_domain_is_allowed,
)

MAX_STORAGE_STATE_BYTES = 480_000
FILE_UPLOAD_MODES = frozenset({"shared-filesystem", "unsupported"})


def context_file_upload_mode(value: object) -> str:
    mode = value.get("fileUploadMode") if isinstance(value, dict) else None
    if mode not in FILE_UPLOAD_MODES:
        raise RuntimeError("BROWSER_UNAVAILABLE: browser context upload mode is unsupported")
    return str(mode)


def context_captcha_solver(value: object) -> bool:
    enabled = value.get("captchaSolver") if isinstance(value, dict) else None
    if not isinstance(enabled, bool):
        raise RuntimeError("BROWSER_UNAVAILABLE: browser context captcha policy was malformed")
    return enabled


@dataclass(frozen=True)
class BrowserConfiguration:
    endpoint: str
    token: str
    allowed_origins: tuple[str, ...]

    @classmethod
    def parse(cls, endpoint: object, token: object, origins: object) -> "BrowserConfiguration":
        canonical_endpoint = canonical_browser_endpoint(endpoint)
        if not isinstance(token, str) or len(token.encode("utf-8")) < 32 or len(token) > 4096:
            raise ValueError("browser_token is invalid")
        return cls(canonical_endpoint, token, canonical_https_origins(origins))


@dataclass(frozen=True)
class BrowserSnapshot(ChallengeSnapshot):
    ready_state: str


def _load_browser_use() -> tuple[type[Any], type[Any]]:
    # Browser Use probes AppKit at import time on macOS. Process-mode local
    # drivers are headless CDP clients and must not initialize a GUI framework.
    if sys.platform == "darwin":
        sys.modules.setdefault("AppKit", None)
    os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
    os.environ.setdefault("BROWSER_USE_DISABLE_EXTENSIONS", "1")
    os.environ.setdefault("BROWSER_USE_CONFIG_DIR", "/tmp/appstrate-browser-use")
    logging.getLogger("browser_use").setLevel(logging.WARNING)
    from browser_use.browser.session import BrowserSession
    from browser_use.tools.service import Tools

    return BrowserSession, Tools


class AppstrateBrowser:
    """One serialized Browser Use session attached to one Appstrate worker."""

    def __init__(self) -> None:
        self._configuration: BrowserConfiguration | None = None
        self._session: Any | None = None
        self._tools: Any | None = None
        self._file_upload_mode: str | None = None
        self._captcha_solver = False
        self._storage_init_scripts: list[tuple[Any, str, str]] = []
        self._restored_origins: list[dict[str, object]] = []

    @property
    def configured(self) -> bool:
        return self._configuration is not None

    def configure(self, configuration: BrowserConfiguration) -> None:
        if self._configuration == configuration:
            return
        if self._session is not None:
            raise RuntimeError("BROWSER_STATE_CONFLICT: browser configuration changed while active")
        self._configuration = configuration

    async def start(self) -> None:
        if self._session is not None:
            return
        configuration = self._require_configuration()
        headers = {"Authorization": f"Bearer {configuration.token}"}
        import httpx

        async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
            response = await client.post(f"{configuration.endpoint}/v1/context", headers=headers)
        if response.status_code not in (200, 409):
            raise RuntimeError(
                f"BROWSER_UNAVAILABLE: browser context creation returned {response.status_code}"
            )
        try:
            context_metadata = response.json()
        except (ValueError, TypeError) as error:
            raise RuntimeError("BROWSER_UNAVAILABLE: browser context metadata was malformed") from error
        file_upload_mode = context_file_upload_mode(context_metadata)
        captcha_solver = context_captcha_solver(context_metadata)
        BrowserSession, Tools = _load_browser_use()
        domains = [urlsplit(origin).hostname for origin in configuration.allowed_origins]
        try:
            session = BrowserSession(
                cdp_url=configuration.endpoint,
                headers=headers,
                allowed_domains=[domain for domain in domains if domain],
                use_cloud=False,
                is_local=False,
                keep_alive=True,
                enable_default_extensions=False,
                # Browser Use Cloud emits private BrowserUse.* CDP events while
                # its managed solver is active. Local workers explicitly return
                # false from /v1/context, so an untrusted/self-hosted endpoint
                # can never opt itself into cloud-only solver semantics.
                captcha_solver=captcha_solver,
                cross_origin_iframes=True,
                max_iframes=16,
                max_iframe_depth=3,
                minimum_wait_page_load_time=0.25,
                wait_for_network_idle_page_load_time=0.75,
                wait_between_actions=0.1,
                highlight_elements=False,
                dom_highlight_elements=False,
            )
            await session.start()
        except Exception as error:
            raise RuntimeError(
                "BROWSER_DRIVER_ATTACH_FAILED: Browser Use could not attach to CDP"
            ) from error
        self._session = session
        self._tools = Tools(exclude_actions=["search", "done"])
        self._file_upload_mode = file_upload_mode
        self._captcha_solver = captcha_solver

    async def close(self) -> None:
        session, self._session = self._session, None
        self._tools = None
        self._file_upload_mode = None
        self._captcha_solver = False
        await self._clear_storage_init_scripts()
        if session is not None:
            try:
                await session.stop()
            except Exception:
                pass

    async def wait_for_captcha_solver(self, timeout_seconds: float = 45.0) -> bool:
        """Wait for a managed cloud solver event without weakening local policy.

        The event can arrive just after the deterministic driver observes the
        challenge DOM, so briefly poll for the watchdog to enter its solving
        state. Once it does, Browser Use owns the bounded wait and reports the
        authenticated success/failure result.
        """
        if not 0.0 < timeout_seconds <= 120.0:
            raise ValueError("captcha solver timeout must be between 0 and 120 seconds")
        await self.start()
        if not self._captcha_solver:
            return False
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return False
            result = await self._session.wait_if_captcha_solving(timeout=remaining)
            if result is not None:
                return result.result == "success"
            await asyncio.sleep(min(0.1, remaining))

    async def navigate(self, url: str, timeout_seconds: float = 30.0) -> BrowserSnapshot:
        self._assert_allowed_url(url)
        await self.start()
        page = await self._session.get_current_page()
        if page is None:
            raise RuntimeError("BROWSER_UNAVAILABLE: browser page is unavailable")
        try:
            async with asyncio.timeout(timeout_seconds):
                # BrowserSession.navigate_to() waits on Browser Use's full
                # event bus. Remote cloud pages can already be interactive
                # while that event remains pending until its fixed 30-second
                # timeout, turning a successful login handoff into a false
                # BROWSER_UNAVAILABLE. The attached Page API issues the same
                # guarded CDP Page.navigate command without that second
                # lifecycle, then wait_ready() verifies the document itself.
                await page.goto(url)
                return await self.wait_ready(timeout_seconds=min(timeout_seconds, 15.0))
        except TimeoutError as error:
            raise RuntimeError("BROWSER_NAVIGATION_TIMEOUT: page did not become ready") from error
        except RuntimeError:
            raise
        except Exception as error:
            raise RuntimeError("BROWSER_PAGE_TRANSITION_FAILED: navigation failed") from error
        finally:
            # Storage restoration runs before the first authenticated
            # navigation. Once it has reached a stable document, do not keep
            # replaying the captured values over changes made by the site.
            await self._clear_storage_init_scripts()

    async def wait_ready(self, timeout_seconds: float = 15.0) -> BrowserSnapshot:
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        last_unavailable: RuntimeError | None = None
        while True:
            try:
                latest = await self.snapshot()
                last_unavailable = None
                if latest.ready_state in ("interactive", "complete"):
                    return latest
            except RuntimeError as error:
                # Page.evaluate can race with an authenticated redirect or a
                # managed challenge replacing its target. Reacquire the page
                # until the bounded navigation deadline instead of surfacing a
                # transient lifecycle state as BROWSER_UNAVAILABLE.
                if not str(error).startswith("BROWSER_UNAVAILABLE:"):
                    raise
                last_unavailable = error
            if asyncio.get_running_loop().time() >= deadline:
                raise RuntimeError(
                    "BROWSER_NAVIGATION_TIMEOUT: page did not become ready"
                ) from last_unavailable
            await asyncio.sleep(0.15)

    async def snapshot(self) -> BrowserSnapshot:
        raw = await self.evaluate(
            "() => ({url: location.href, title: document.title || '', "
            "body_text: (document.body?.innerText || '').slice(0, 20000), "
            "frame_urls: [...document.querySelectorAll('iframe')].map(f => f.src).filter(Boolean).slice(0, 20), "
            "ready_state: document.readyState})"
        )
        if not isinstance(raw, dict):
            raise RuntimeError("BROWSER_UNAVAILABLE: malformed browser snapshot")
        return BrowserSnapshot(
            url=str(raw.get("url", "")),
            title=str(raw.get("title", ""))[:1000],
            body_text=str(raw.get("body_text", ""))[:20000],
            frame_urls=tuple(str(item) for item in raw.get("frame_urls", [])[:20]),
            ready_state=str(raw.get("ready_state", "")),
        )

    async def evaluate(self, function: str, *args: object) -> object:
        await self.start()
        page = await self._session.get_current_page()
        if page is None:
            raise RuntimeError("BROWSER_UNAVAILABLE: browser page is unavailable")
        try:
            raw = await page.evaluate(function, *args)
            if raw is None:
                return None
            if isinstance(raw, (dict, list, bool, int, float)):
                return raw
            try:
                return json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                if raw == "True":
                    return True
                if raw == "False":
                    return False
                return raw
        except Exception as error:
            raise RuntimeError("BROWSER_UNAVAILABLE: page evaluation failed") from error

    async def cookies(self) -> list[dict[str, object]]:
        await self.start()
        return await self._read_browser_cookies()

    async def export_storage_state_json(self) -> str:
        await self.start()
        raw_cookies = await self._read_browser_cookies()
        cookies = [
            {
                "name": cookie.get("name"),
                "value": cookie.get("value"),
                "domain": cookie.get("domain"),
                "path": cookie.get("path", "/"),
                "expires": cookie.get("expires", -1),
                "httpOnly": cookie.get("httpOnly", False),
                "secure": cookie.get("secure", False),
                "sameSite": cookie.get("sameSite", "Lax"),
            }
            for cookie in raw_cookies
        ]
        # Browser Use 0.13 currently exports cookies but drops origins. Keep
        # the companion-captured origin state so a successful cloud proof does
        # not silently degrade the portable session saved for future runs.
        origins = self._restored_origins
        configuration = self._require_configuration()
        allowed_hosts = {urlsplit(origin).hostname for origin in configuration.allowed_origins}
        if not isinstance(cookies, list) or len(cookies) > 256:
            raise RuntimeError("BROWSER_RESOURCE_LIMIT: browser state has too many cookies")
        for cookie in cookies:
            domain = (
                str(cookie.get("domain", "")).lower().lstrip(".")
                if isinstance(cookie, dict)
                else ""
            )
            if not domain or domain not in allowed_hosts:
                raise RuntimeError("BROWSER_POLICY_DENIED: browser state contains a foreign cookie")
        if not isinstance(origins, list) or len(origins) > 64:
            raise RuntimeError("BROWSER_RESOURCE_LIMIT: browser state has too many origins")
        for origin_state in origins:
            origin = origin_state.get("origin") if isinstance(origin_state, dict) else None
            if origin not in configuration.allowed_origins:
                raise RuntimeError("BROWSER_POLICY_DENIED: browser state contains a foreign origin")
        encoded = json.dumps(
            {"version": 1, "cookies": cookies, "origins": origins},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        # The state is nested as a JSON string inside the MCP result, where
        # quotes and backslashes are escaped a second time. Keep enough headroom
        # for that envelope to remain below the sidecar's 1 MiB result ceiling.
        if len(encoded.encode("utf-8")) > MAX_STORAGE_STATE_BYTES:
            raise RuntimeError("BROWSER_RESOURCE_LIMIT: browser state is too large")
        return encoded

    async def _read_browser_cookies(self, timeout_seconds: float = 5.0) -> list[dict[str, object]]:
        """Read browser-wide cookies without depending on the focused page.

        Authentication redirects and managed challenge solvers may replace the
        active target after a successful navigation. Storage.getCookies is a
        browser-level CDP command, so it remains valid across that transition.
        """
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        last_error: Exception | None = None
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise RuntimeError(
                    "BROWSER_STATE_READ_FAILED: browser cookies could not be read"
                ) from last_error
            try:
                result = await asyncio.wait_for(
                    self._session.cdp_client.send.Storage.getCookies(),
                    timeout=remaining,
                )
                cookies = result.get("cookies") if isinstance(result, dict) else None
                if not isinstance(cookies, list):
                    raise RuntimeError("browser cookie response was malformed")
                return [cookie for cookie in cookies if isinstance(cookie, dict)]
            except Exception as error:
                last_error = error
                await asyncio.sleep(min(0.1, max(0.0, remaining)))

    async def restore_storage_state_json(self, encoded: str) -> None:
        if not encoded or len(encoded.encode("utf-8")) > MAX_STORAGE_STATE_BYTES:
            raise RuntimeError("BROWSER_AUTH_REQUIRED: stored browser state is invalid")
        try:
            state = json.loads(encoded)
        except json.JSONDecodeError as error:
            raise RuntimeError("BROWSER_AUTH_REQUIRED: stored browser state is invalid") from error
        if not isinstance(state, dict) or state.get("version") != 1:
            raise RuntimeError("BROWSER_AUTH_REQUIRED: stored browser state version is unsupported")
        cookies = state.get("cookies")
        origins = state.get("origins", [])
        if not isinstance(cookies, list) or not isinstance(origins, list):
            raise RuntimeError("BROWSER_AUTH_REQUIRED: stored browser state is malformed")
        configuration = self._require_configuration()
        if len(cookies) > 256 or len(origins) > 64:
            raise RuntimeError("BROWSER_RESOURCE_LIMIT: stored browser state is too large")
        for cookie in cookies:
            if (
                not isinstance(cookie, dict)
                or not cookie_domain_is_allowed(cookie.get("domain"), configuration.allowed_origins)
                or not isinstance(cookie.get("name"), str)
                or not isinstance(cookie.get("value"), str)
                or not 1 <= len(cookie["name"]) <= 256
                or len(cookie["value"]) > 262_144
            ):
                raise RuntimeError("BROWSER_POLICY_DENIED: stored browser state contains an invalid cookie")
        for origin_state in origins:
            if not isinstance(origin_state, dict) or origin_state.get("origin") not in configuration.allowed_origins:
                raise RuntimeError("BROWSER_POLICY_DENIED: stored browser state contains a foreign origin")
            entries = origin_state.get("localStorage", [])
            if not isinstance(entries, list) or len(entries) > 256:
                raise RuntimeError("BROWSER_RESOURCE_LIMIT: stored local storage is too large")
            for entry in entries:
                if (
                    not isinstance(entry, dict)
                    or not isinstance(entry.get("name"), str)
                    or not isinstance(entry.get("value"), str)
                    or len(entry["name"]) > 1024
                    or len(entry["value"]) > 262_144
                ):
                    raise RuntimeError("BROWSER_AUTH_REQUIRED: stored local storage is malformed")
        await self.start()
        try:
            await self._session.cdp_client.send.Storage.setCookies(params={"cookies": cookies})
        except Exception as error:
            raise RuntimeError("BROWSER_AUTH_REQUIRED: stored browser cookies were rejected") from error
        if origins:
            await self._install_local_storage_state(origins)
        self._restored_origins = [
            {
                "origin": str(origin_state["origin"]),
                "localStorage": [
                    {"name": entry["name"], "value": entry["value"]}
                    for entry in origin_state.get("localStorage", [])
                ],
            }
            for origin_state in origins
        ]

    async def _install_local_storage_state(self, origins: list[dict[str, object]]) -> None:
        """Restore origin storage before site scripts run, without navigation.

        Navigating the live page through every stored origin can race with auth
        redirects, DataDome target replacement, and Browser Use's focus recovery.
        A target-scoped init script applies only when one of the captured origins
        actually loads, including intermediate authentication redirects.
        """
        await self._clear_storage_init_scripts()
        try:
            cdp_session = await self._session.get_or_create_cdp_session(
                target_id=None,
                focus=False,
            )
            state_by_origin = {
                str(origin_state["origin"]): [
                    [entry["name"], entry["value"]]
                    for entry in origin_state.get("localStorage", [])
                ]
                for origin_state in origins
            }
            serialized = json.dumps(
                state_by_origin,
                ensure_ascii=True,
                separators=(",", ":"),
            )
            script = (
                "(() => { try {"
                f"const entries = ({serialized})[location.origin];"
                "if (!entries) return;"
                "localStorage.clear();"
                "for (const [key, value] of entries) localStorage.setItem(key, value);"
                "} catch (_) {} })();"
            )
            result = await cdp_session.cdp_client.send.Page.addScriptToEvaluateOnNewDocument(
                params={"source": script, "runImmediately": True},
                session_id=cdp_session.session_id,
            )
            identifier = result.get("identifier") if isinstance(result, dict) else None
            if not isinstance(identifier, str) or not identifier:
                raise RuntimeError("storage init script identifier was missing")
            self._storage_init_scripts.append(
                (cdp_session.cdp_client, cdp_session.session_id, identifier)
            )
        except Exception as error:
            raise RuntimeError("BROWSER_AUTH_REQUIRED: stored local storage was rejected") from error

    async def _clear_storage_init_scripts(self) -> None:
        scripts, self._storage_init_scripts = self._storage_init_scripts, []
        for cdp_client, session_id, identifier in scripts:
            try:
                await cdp_client.send.Page.removeScriptToEvaluateOnNewDocument(
                    params={"identifier": identifier},
                    session_id=session_id,
                )
            except Exception:
                # Target replacement and browser shutdown can invalidate the
                # original session. The script disappears with that target.
                pass

    async def current_url(self) -> str:
        await self.start()
        return str(await self._session.get_current_page_url())

    async def find_semantic_index(
        self,
        labels: tuple[str, ...],
        *,
        tags: tuple[str, ...] = (),
        input_types: tuple[str, ...] = (),
    ) -> int | None:
        await self.start()
        state = await self._session.get_browser_state_summary(include_screenshot=False, cached=False)
        wanted = tuple(label.casefold() for label in labels if label)
        best: tuple[int, int] | None = None
        for index, node in state.dom_state.selector_map.items():
            tag = str(getattr(node, "tag_name", "")).lower()
            attrs = getattr(node, "attributes", {}) or {}
            input_type = str(attrs.get("type", "")).lower()
            if tags and tag not in tags:
                continue
            if input_types and input_type not in input_types:
                continue
            ax = getattr(node, "ax_node", None)
            fields = [
                attrs.get("aria-label", ""),
                attrs.get("placeholder", ""),
                attrs.get("name", ""),
                attrs.get("autocomplete", ""),
                attrs.get("title", ""),
                getattr(ax, "name", "") if ax else "",
                getattr(ax, "role", "") if ax else "",
                node.get_all_children_text(max_depth=2),
            ]
            text = " ".join(str(value) for value in fields if value).casefold()
            score = max(
                (100 if text.strip() == label else 60 if label in text else 0)
                for label in wanted
            ) if wanted else 1
            if input_types and input_type in input_types:
                score += 30
            if tags and tag in tags:
                score += 10
            if getattr(node, "is_visible", True) is False:
                score -= 100
            if score > 0 and (best is None or score > best[0]):
                best = (score, int(index))
        return best[1] if best else None

    async def fill_semantic(
        self,
        labels: tuple[str, ...],
        value: str,
        *,
        secret_name: str | None = None,
        input_types: tuple[str, ...] = (),
    ) -> bool:
        index = await self.find_semantic_index(
            labels,
            tags=("input", "textarea"),
            input_types=input_types,
        )
        if index is None:
            return False
        params_value = value
        sensitive: dict[str, dict[str, str]] | None = None
        if secret_name:
            configuration = self._require_configuration()
            params_value = f"<secret>{secret_name}</secret>"
            current = urlsplit(await self.current_url())
            current_origin = f"{current.scheme}://{current.netloc}"
            if current_origin not in configuration.allowed_origins:
                raise RuntimeError("BROWSER_POLICY_DENIED: secret input page is not authorized")
            sensitive = {current_origin: {secret_name: value}}
        result = await self._tools.registry.execute_action(
            "input",
            {"index": index, "text": params_value, "clear": True},
            browser_session=self._session,
            sensitive_data=sensitive,
        )
        return not bool(getattr(result, "error", None))

    async def click_semantic(self, labels: tuple[str, ...], required: bool = False) -> bool:
        index = await self.find_semantic_index(
            labels,
            tags=("button", "a", "input", "div", "span"),
        )
        if index is None:
            if required:
                return False
            return False
        result = await self._tools.registry.execute_action(
            "click", {"index": index}, browser_session=self._session
        )
        if getattr(result, "error", None):
            if required:
                return False
            return False
        await asyncio.sleep(0.3)
        return True

    async def press(self, key: str) -> None:
        await self.start()
        page = await self._session.get_current_page()
        if page is None:
            raise RuntimeError("BROWSER_UNAVAILABLE: browser page is unavailable")
        await page.press(key)

    async def upload_files(self, paths: tuple[str, ...]) -> None:
        """Set one visible file input using Browser Use's attached CDP session."""

        await self.start()
        if self._file_upload_mode != "shared-filesystem":
            raise RuntimeError(
                "BROWSER_UNAVAILABLE: selected browser provider cannot access workspace files"
            )
        selector_map = await self._session.get_selector_map()
        node = next(
            (
                candidate
                for candidate in selector_map.values()
                if str(getattr(candidate, "tag_name", "")).lower() == "input"
                and str((getattr(candidate, "attributes", {}) or {}).get("type", "")).lower()
                == "file"
                and getattr(candidate, "is_visible", True) is not False
            ),
            None,
        )
        if node is None:
            node = next(
                (
                    candidate
                    for candidate in selector_map.values()
                    if str(getattr(candidate, "tag_name", "")).lower() == "input"
                    and str((getattr(candidate, "attributes", {}) or {}).get("type", "")).lower()
                    == "file"
                ),
                None,
            )
        if node is None:
            raise RuntimeError("BROWSER_STATE_CONFLICT: file input is unavailable")
        cdp_session = await self._session.get_or_create_cdp_session()
        try:
            await self._session.cdp_client.send.DOM.setFileInputFiles(
                params={"files": list(paths), "backendNodeId": node.backend_node_id},
                session_id=node.session_id or cdp_session.session_id,
            )
        except Exception as error:
            raise RuntimeError("BROWSER_STATE_CONFLICT: file upload failed") from error
        await asyncio.sleep(0.5)

    def _require_configuration(self) -> BrowserConfiguration:
        if self._configuration is None:
            raise RuntimeError("BROWSER_UNAVAILABLE: browser driver is not configured")
        return self._configuration

    def _assert_allowed_url(self, raw: str) -> None:
        configuration = self._require_configuration()
        try:
            parsed = urlsplit(raw)
        except ValueError as error:
            raise RuntimeError("BROWSER_POLICY_DENIED: invalid navigation URL") from error
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if parsed.scheme != "https" or origin not in configuration.allowed_origins:
            raise RuntimeError("BROWSER_POLICY_DENIED: navigation origin is not allowed")
