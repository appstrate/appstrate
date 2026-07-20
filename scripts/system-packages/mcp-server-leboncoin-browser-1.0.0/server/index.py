# SPDX-License-Identifier: Apache-2.0
"""Deterministic Browser Use MCP driver for the system Leboncoin integration."""

from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from collections.abc import Mapping
from urllib.parse import urlencode, urlsplit, urlunsplit

from appstrate_browser_use import (
    AppstrateBrowser,
    BrowserConfiguration,
    JsonRpcMcpServer,
    ProtocolError,
    detect_datadome_challenge,
    required_string,
)

LEBONCOIN_ORIGIN = "https://www.leboncoin.fr"
LOGIN_COOKIE = "__Secure-login"

TOOLS = [
    {
        "name": "acquire_session",
        "description": "Private Appstrate connect hook. Signs in or restores a bounded browser state and returns an authenticated proof. Never exposed to the agent.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["browser_endpoint", "browser_token", "inputs", "allowed_origins", "session_mode"],
            "properties": {
                "browser_endpoint": {"type": "string"},
                "browser_token": {"type": "string"},
                "inputs": {
                    "type": "object",
                    "additionalProperties": {"type": "string"},
                },
                "allowed_origins": {"type": "array", "items": {"type": "string"}},
                "session_mode": {"const": "exportable"},
            },
        },
    },
    {
        "name": "search_listings",
        "description": "Search Leboncoin in the authenticated isolated browser and return a bounded list of visible listing summaries. Read-only.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["query"],
            "properties": {
                "query": {"type": "string", "minLength": 1, "maxLength": 120},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 10},
            },
        },
    },
    {
        "name": "get_listing",
        "description": "Open one canonical https://www.leboncoin.fr/ad/... URL and return bounded visible details. Read-only.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["url"],
            "properties": {"url": {"type": "string", "format": "uri"}},
        },
    },
    {
        "name": "session_status",
        "description": "Report whether the browser holds an authenticated Leboncoin cookie. Cookie values are never returned.",
        "inputSchema": {"type": "object", "additionalProperties": False, "properties": {}},
    },
]


def normalize_listing_url(value: object) -> str:
    raw = required_string(value, "url", 2048)
    parsed = urlsplit(raw)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "www.leboncoin.fr"
        or not parsed.path.startswith("/ad/")
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ProtocolError("url must use https://www.leboncoin.fr/ad/...")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def has_session(cookies: list[dict[str, object]]) -> bool:
    return any(
        cookie.get("name") == LOGIN_COOKIE
        and isinstance(cookie.get("value"), str)
        and bool(cookie.get("value"))
        and isinstance(cookie.get("domain"), str)
        and str(cookie["domain"]).lower().lstrip(".").endswith("leboncoin.fr")
        for cookie in cookies
    )


def credentials_rejected(text: str) -> bool:
    lowered = text.casefold()
    return any(
        marker in lowered
        for marker in (
            "adresse email ou mot de passe incorrect",
            "email ou mot de passe incorrect",
            "mot de passe incorrect",
            "identifiants incorrects",
            "incorrect password",
        )
    )


class LeboncoinDriver:
    def __init__(self) -> None:
        self.browser = AppstrateBrowser()

    def configure(self, configuration: BrowserConfiguration) -> None:
        self.browser.configure(configuration)

    async def acquire(self, inputs: Mapping[str, object]) -> dict[str, object]:
        stored_state = inputs.get("browser_state")
        if isinstance(stored_state, str):
            await self.browser.restore_storage_state_json(stored_state)
            snapshot = await self.browser.navigate(LEBONCOIN_ORIGIN)
            self._assert_no_challenge(snapshot)
            cookies = await self.browser.cookies()
            if not has_session(cookies):
                raise RuntimeError("BROWSER_AUTH_REQUIRED: stored Leboncoin session expired")
            return await self._result(None)

        email = required_string(inputs.get("email"), "inputs.email", 320)
        password = required_string(inputs.get("password"), "inputs.password", 4096)
        query = urlencode(
            {
                "client_id": "lbc-front-web",
                "redirect_uri": "https://www.leboncoin.fr/oauth2callback",
                "response_type": "code",
                "scope": "* offline",
                "state": str(uuid.uuid4()),
            }
        )
        snapshot = await self.browser.navigate(
            f"https://auth.leboncoin.fr/api/authorizer/v2/authorize?{query}", 45.0
        )
        self._assert_no_challenge(snapshot)
        await self.browser.click_semantic(("Tout accepter", "Accepter", "Cookies requis uniquement"))

        email_labels = ("email", "e-mail", "adresse email", "username")
        password_labels = ("password", "mot de passe", "current-password")
        if not await self._wait_for_field(email_labels, 15.0, ("email", "text")):
            raise RuntimeError("BROWSER_AUTH_REQUIRED: Leboncoin email field was not found")
        if not await self.browser.fill_semantic(
            email_labels,
            email,
            secret_name="login_email",
            input_types=("email", "text"),
        ):
            raise RuntimeError("BROWSER_AUTH_REQUIRED: Leboncoin email field disappeared")

        password_visible = await self.browser.find_semantic_index(
            password_labels, tags=("input",), input_types=("password",)
        )
        if password_visible is None:
            if not await self.browser.click_semantic(("Continuer", "Se connecter", "Connexion")):
                await self.browser.press("Enter")
            if not await self._wait_for_field(password_labels, 20.0, ("password",)):
                self._assert_no_challenge(await self.browser.snapshot())
                raise RuntimeError("BROWSER_AUTH_REQUIRED: Leboncoin password step was not reached")
        if not await self.browser.fill_semantic(
            password_labels,
            password,
            secret_name="login_password",
            input_types=("password",),
        ):
            raise RuntimeError("BROWSER_AUTH_REQUIRED: Leboncoin password field disappeared")
        if not await self.browser.click_semantic(("Se connecter", "Connexion", "Valider")):
            await self.browser.press("Enter")

        deadline = asyncio.get_running_loop().time() + 45.0
        while asyncio.get_running_loop().time() < deadline:
            cookies = await self.browser.cookies()
            if has_session(cookies):
                return await self._result(email)
            snapshot = await self.browser.snapshot()
            self._assert_no_challenge(snapshot)
            if credentials_rejected(snapshot.body_text):
                raise RuntimeError("BROWSER_AUTH_REQUIRED: Leboncoin rejected the credentials")
            if re.search(r"(?:code|vérification|verification).{0,80}(?:sms|e-mail|email)", snapshot.body_text, re.I):
                raise RuntimeError("BROWSER_INTERACTION_REQUIRED: Leboncoin requires account verification")
            await asyncio.sleep(0.5)
        raise RuntimeError("BROWSER_NAVIGATION_TIMEOUT: Leboncoin login did not complete")

    async def _result(self, email: str | None) -> dict[str, object]:
        state = await self.browser.export_storage_state_json()
        return {
            "outputs": {"browser_state": state},
            "proof": {"kind": "leboncoin-browser-use-session", "succeeded": True},
            "identity_claims": {"marketplace": "leboncoin-fr", **({"email": email} if email else {})},
            "scopes_granted": ["read:listings"],
            "expires_at": None,
        }

    async def search(self, query: str, limit: int) -> dict[str, object]:
        url = f"{LEBONCOIN_ORIGIN}/recherche?{urlencode({'text': query})}"
        snapshot = await self.browser.navigate(url)
        self._assert_no_challenge(snapshot)
        listings = await self.browser.evaluate(
            "(limit) => { const seen = new Set(), out = []; "
            "for (const anchor of document.querySelectorAll('a[href*=\"/ad/\"]')) { "
            "let parsed; try { parsed = new URL(anchor.href, location.href); } catch { continue; } "
            "if (parsed.hostname !== 'www.leboncoin.fr' || !parsed.pathname.startsWith('/ad/') || seen.has(parsed.href)) continue; "
            "seen.add(parsed.href); const card = anchor.closest('article, li, [data-test-id], [class*=\"adcard\"]') || anchor; "
            "const lines = (card.innerText || anchor.innerText || '').split('\\n').map(x => x.trim()).filter(Boolean); "
            "const title = (anchor.getAttribute('title') || lines[0] || '').trim(); if (!title) continue; "
            "const price = lines.find(x => /\\d[\\d . ]*\\s*€/.test(x)); const image = card.querySelector('img'); "
            "out.push({url: parsed.href, title: title.slice(0,300), ...(price ? {price:price.slice(0,80)} : {}), "
            "summary: lines.slice(0,8).join(' · ').slice(0,1000), ...(image?.currentSrc ? {image:image.currentSrc} : {})}); "
            "if (out.length >= limit) break; } return out; }",
            limit,
        )
        items = listings if isinstance(listings, list) else []
        return {"query": query, "url": snapshot.url, "count": len(items), "listings": items}

    async def get_listing(self, url: str) -> dict[str, object]:
        snapshot = await self.browser.navigate(url)
        self._assert_no_challenge(snapshot)
        result = await self.browser.evaluate(
            "() => { const text=(document.body?.innerText||'').replace(/\\n{3,}/g,'\\n\\n').trim(); "
            "const canonical=document.querySelector('link[rel=\"canonical\"]')?.href||location.href; "
            "const title=document.querySelector('h1')?.textContent?.trim()||document.title; "
            "const price=[...document.querySelectorAll('body *')].map(n=>n.children.length===0?(n.textContent||'').trim():'').find(v=>/^\\d[\\d . ]*\\s*€$/.test(v)); "
            "const images=[...document.querySelectorAll('img')].map(i=>i.currentSrc||i.src).filter(Boolean).slice(0,12); "
            "return {url:location.href,canonical_url:canonical,title:title.slice(0,500),...(price?{price:price.slice(0,80)}:{}),visible_text:text.slice(0,12000),images}; }"
        )
        return result if isinstance(result, dict) else {}

    async def status(self) -> dict[str, object]:
        cookies = await self.browser.cookies()
        names = sorted(
            {
                str(cookie["name"])
                for cookie in cookies
                if isinstance(cookie.get("name"), str)
                and isinstance(cookie.get("domain"), str)
                and str(cookie["domain"]).lower().lstrip(".").endswith("leboncoin.fr")
            }
        )
        return {
            "authenticated": has_session(cookies),
            "cookie_names": names,
            "current_url": await self.browser.current_url(),
            "engine": "browser-use",
        }

    async def _wait_for_field(
        self, labels: tuple[str, ...], timeout: float, input_types: tuple[str, ...]
    ) -> bool:
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if await self.browser.find_semantic_index(
                labels, tags=("input", "textarea"), input_types=input_types
            ) is not None:
                return True
            self._assert_no_challenge(await self.browser.snapshot())
            await asyncio.sleep(0.25)
        return False

    @staticmethod
    def _assert_no_challenge(snapshot: object) -> None:
        if detect_datadome_challenge(snapshot):
            raise RuntimeError("BROWSER_INTERACTION_REQUIRED: Leboncoin presented a DataDome challenge")


driver = LeboncoinDriver()


def configure_from_env() -> None:
    if driver.browser.configured:
        return
    try:
        origins = json.loads(os.environ.get("APPSTRATE_BROWSER_ALLOWED_ORIGINS_JSON", "[]"))
    except json.JSONDecodeError as error:
        raise ProtocolError("APPSTRATE_BROWSER_ALLOWED_ORIGINS_JSON is invalid") from error
    driver.configure(
        BrowserConfiguration.parse(
            os.environ.get("APPSTRATE_BROWSER_ENDPOINT"),
            os.environ.get("APPSTRATE_BROWSER_TOKEN"),
            origins,
        )
    )


async def acquire_session(args: Mapping[str, object]) -> object:
    if args.get("session_mode") != "exportable":
        raise ProtocolError("session_mode must be exportable")
    inputs = args.get("inputs")
    if not isinstance(inputs, dict):
        raise ProtocolError("inputs must be an object")
    configuration = BrowserConfiguration.parse(
        args.get("browser_endpoint"), args.get("browser_token"), args.get("allowed_origins")
    )
    if LEBONCOIN_ORIGIN not in configuration.allowed_origins:
        raise ProtocolError(f"allowed_origins omits {LEBONCOIN_ORIGIN}")
    driver.configure(configuration)
    return await driver.acquire(inputs)


async def search_listings(args: Mapping[str, object]) -> object:
    query = required_string(args.get("query"), "query", 120).strip()
    if not query:
        raise ProtocolError("query must not be blank")
    limit = args.get("limit", 10)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20:
        raise ProtocolError("limit must be an integer from 1 to 20")
    configure_from_env()
    return await driver.search(query, limit)


async def get_listing(args: Mapping[str, object]) -> object:
    configure_from_env()
    return await driver.get_listing(normalize_listing_url(args.get("url")))


async def session_status(_args: Mapping[str, object]) -> object:
    configure_from_env()
    return await driver.status()


server = JsonRpcMcpServer(
    name="appstrate-leboncoin-browser-use",
    version="1.0.0",
    tools=TOOLS,
    handlers={
        "acquire_session": acquire_session,
        "search_listings": search_listings,
        "get_listing": get_listing,
        "session_status": session_status,
    },
)


if __name__ == "__main__":
    try:
        asyncio.run(server.run_stdio())
    finally:
        try:
            asyncio.run(driver.browser.close())
        except Exception:
            pass
