# SPDX-License-Identifier: Apache-2.0
"""Deterministic Browser Use MCP driver for the system Vinted integration."""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlencode, urlsplit, urlunsplit

from appstrate_browser_use import (
    AppstrateBrowser,
    BrowserConfiguration,
    JsonRpcMcpServer,
    ProtocolError,
    detect_datadome_challenge,
    required_string,
)

VINTED_ORIGIN = "https://www.vinted.fr"

TOOLS = [
    {
        "name": "acquire_session",
        "description": "Private Appstrate connect hook. Signs in or restores bounded Vinted browser state and returns an authenticated proof. Never exposed to the agent.",
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
        "name": "search_items",
        "description": "Search the public Vinted France catalog in the isolated browser and return bounded item summaries. Read-only.",
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
        "name": "get_item",
        "description": "Open one canonical https://www.vinted.fr/items/... URL and return bounded visible details. Read-only.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["url"],
            "properties": {"url": {"type": "string", "format": "uri"}},
        },
    },
    {
        "name": "browser_status",
        "description": "Report the current Vinted page and cookie names without exposing cookie values.",
        "inputSchema": {"type": "object", "additionalProperties": False, "properties": {}},
    },
    {
        "name": "prepare_item_draft",
        "description": "Fill a Vinted listing form from validated workspace images without submitting it. Returns a one-time draft token and exact summary.",
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True},
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["title", "description", "price_eur", "category", "condition", "image_paths"],
            "properties": {
                "title": {"type": "string", "minLength": 1, "maxLength": 100},
                "description": {"type": "string", "minLength": 1, "maxLength": 2000},
                "price_eur": {"type": "string"},
                "category": {"type": "string", "minLength": 1, "maxLength": 120},
                "condition": {"type": "string", "minLength": 1, "maxLength": 120},
                "brand": {"type": "string", "minLength": 1, "maxLength": 120},
                "size": {"type": "string", "minLength": 1, "maxLength": 120},
                "parcel_size": {"type": "string", "minLength": 1, "maxLength": 120},
                "image_paths": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "string"}},
            },
        },
    },
    {
        "name": "publish_item",
        "description": "Publish the exact prepared Vinted listing after explicit user approval using its one-time token.",
        "annotations": {"readOnlyHint": False, "destructiveHint": True, "openWorldHint": True},
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["draft_token", "confirm_publish"],
            "properties": {
                "draft_token": {"type": "string", "minLength": 32, "maxLength": 128},
                "confirm_publish": {"const": True},
            },
        },
    },
]


def normalize_item_url(value: object) -> str:
    raw = required_string(value, "url", 2048)
    parsed = urlsplit(raw)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "www.vinted.fr"
        or re.fullmatch(r"/items/\d+(?:-[^/]+)?/?", parsed.path) is None
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ProtocolError("url must use https://www.vinted.fr/items/<id>-<slug>")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def normalize_price(value: object) -> str:
    raw = required_string(value, "price_eur", 32).strip().replace(",", ".")
    if re.fullmatch(r"(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?", raw) is None:
        raise ProtocolError("price_eur must be a positive decimal amount with at most 2 decimals")
    amount = float(raw)
    if amount < 0.01 or amount > 999_999.99:
        raise ProtocolError("price_eur must be between 0.01 and 999999.99")
    return f"{amount:.2f}"


def _optional_string(value: object, field: str, limit: int) -> str | None:
    if value in (None, ""):
        return None
    normalized = required_string(value, field, limit).strip()
    return normalized or None


def resolve_workspace_images(value: object) -> tuple[str, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= 20:
        raise ProtocolError("image_paths must contain between 1 and 20 workspace paths")
    root_value = os.environ.get("APPSTRATE_WORKSPACE")
    if not root_value or not Path(root_value).is_absolute():
        raise ProtocolError("the Vinted integration has no mounted run workspace")
    try:
        root = Path(root_value).resolve(strict=True)
    except OSError as error:
        raise ProtocolError("the mounted run workspace is unavailable") from error
    output: list[str] = []
    total = 0
    for index, raw_value in enumerate(value):
        raw = required_string(raw_value, f"image_paths[{index}]", 1024)
        raw_path = Path(raw)
        if raw_path.is_absolute() or ".." in raw_path.parts:
            raise ProtocolError(f"image_paths[{index}] must be workspace-relative")
        try:
            candidate = (root / raw_path).resolve(strict=True)
            candidate.relative_to(root)
            info = candidate.stat()
        except (OSError, ValueError) as error:
            raise ProtocolError(f"image_paths[{index}] does not exist in the workspace") from error
        if not candidate.is_file() or not 1 <= info.st_size <= 20 * 1024 * 1024:
            raise ProtocolError(f"image_paths[{index}] must be a regular file up to 20 MB")
        prefix = candidate.read_bytes()[:16]
        image = (
            prefix.startswith(b"\xff\xd8\xff")
            or prefix.startswith(b"\x89PNG\r\n\x1a\n")
            or (prefix.startswith(b"RIFF") and prefix[8:12] == b"WEBP")
        )
        if not image:
            raise ProtocolError(f"image_paths[{index}] must be JPEG, PNG, or WebP")
        total += info.st_size
        if total > 100 * 1024 * 1024:
            raise ProtocolError("image_paths exceed the 100 MB total limit")
        output.append(str(candidate))
    return tuple(output)


@dataclass(frozen=True)
class Draft:
    token: str
    title: str
    description: str
    price: str
    category: str
    condition: str
    brand: str | None
    size: str | None
    parcel_size: str | None
    image_paths: tuple[str, ...]


class VintedDriver:
    def __init__(self) -> None:
        self.browser = AppstrateBrowser()
        self.draft: Draft | None = None

    def configure(self, configuration: BrowserConfiguration) -> None:
        self.browser.configure(configuration)

    async def acquire(self, inputs: Mapping[str, object]) -> dict[str, object]:
        stored_state = inputs.get("browser_state")
        if isinstance(stored_state, str):
            await self.browser.restore_storage_state_json(stored_state)
            if not await self._wait_for_listing_form(20.0):
                raise RuntimeError("BROWSER_AUTH_REQUIRED: stored Vinted session expired")
            return await self._result(None)

        email = required_string(inputs.get("email"), "inputs.email", 320)
        password = required_string(inputs.get("password"), "inputs.password", 4096)
        snapshot = await self.browser.navigate(f"{VINTED_ORIGIN}/member/signup/select_type")
        self._assert_no_challenge(snapshot)
        await self.browser.click_semantic(("Cookies requis uniquement", "Accepter tout", "Tout accepter"))
        await self.browser.click_semantic(("Se connecter", "Connexion"))
        email_labels = ("email", "e-mail", "adresse e-mail", "username")
        password_labels = ("password", "mot de passe", "current-password")
        if not await self._wait_for_field(email_labels, 12.0, ("email", "text")):
            raise RuntimeError("BROWSER_INTERACTION_REQUIRED: Vinted did not expose its email login form")
        if not await self.browser.fill_semantic(
            email_labels, email, secret_name="login_email", input_types=("email", "text")
        ):
            raise RuntimeError("BROWSER_AUTH_REQUIRED: Vinted email field disappeared")
        if not await self.browser.click_semantic(("Continuer", "Se connecter", "Connexion")):
            await self.browser.press("Enter")
        if not await self._wait_for_field(password_labels, 15.0, ("password",)):
            self._assert_no_challenge(await self.browser.snapshot())
            raise RuntimeError("BROWSER_INTERACTION_REQUIRED: Vinted requires an additional login verification step")
        if not await self.browser.fill_semantic(
            password_labels, password, secret_name="login_password", input_types=("password",)
        ):
            raise RuntimeError("BROWSER_AUTH_REQUIRED: Vinted password field disappeared")
        if not await self.browser.click_semantic(("Se connecter", "Connexion", "Valider")):
            await self.browser.press("Enter")

        authenticated = await self._wait_for_listing_form(25.0)
        if not authenticated:
            snapshot = await self.browser.snapshot()
            self._assert_no_challenge(snapshot)
            if re.search(
                r"(?:code|vérification|verification|confirmer).{0,80}(?:e-mail|email|téléphone|telephone|sms)",
                snapshot.body_text,
                re.I,
            ):
                raise RuntimeError("BROWSER_INTERACTION_REQUIRED: Vinted requires email, SMS, or 2FA verification")
            raise RuntimeError("BROWSER_AUTH_REQUIRED: Vinted rejected the supplied account credentials")
        cookies = await self.browser.cookies()
        if not cookies:
            raise RuntimeError("BROWSER_AUTH_REQUIRED: Vinted did not establish an authenticated session")
        return await self._result(email)

    async def _result(self, email: str | None) -> dict[str, object]:
        state = await self.browser.export_storage_state_json()
        return {
            "outputs": {"browser_state": state},
            "proof": {"kind": "vinted-browser-use-listing-form", "succeeded": True},
            "identity_claims": {"marketplace": "vinted-fr", **({"email": email} if email else {})},
            "scopes_granted": ["read:catalog", "write:listings"],
            "expires_at": None,
        }

    async def search(self, query: str, limit: int) -> dict[str, object]:
        snapshot = await self.browser.navigate(
            f"{VINTED_ORIGIN}/catalog?{urlencode({'search_text': query})}"
        )
        self._assert_no_challenge(snapshot)
        found = await self.browser.evaluate(
            "(limit) => { const seen=new Set(), out=[]; for (const anchor of document.querySelectorAll('a[href*=\"/items/\"]')) { "
            "let p; try { p=new URL(anchor.href,location.href); } catch { continue; } "
            "if (p.hostname!=='www.vinted.fr'||!/^\\/items\\/\\d+/.test(p.pathname)) continue; p.search='';p.hash=''; "
            "if (seen.has(p.href)) continue; seen.add(p.href); const card=anchor.closest('article,li,[data-testid*=\"grid-item\"],[class*=\"feed-grid\"]')||anchor.parentElement?.parentElement||anchor; "
            "const image=anchor.querySelector('img')||card.querySelector?.('img'); const label=(anchor.getAttribute('aria-label')||image?.getAttribute('alt')||'').trim(); "
            "const lines=(card.innerText||anchor.innerText||label).split('\\n').map(x=>x.trim()).filter(Boolean); const title=(label.split(/, (?:marque|état|taille):/i)[0]||lines[0]||'').trim(); if(!title)continue; "
            "const price=(label.match(/\\d[\\d . ]*(?:[,.]\\d{1,2})?\\s*€/)||lines.join(' · ').match(/\\d[\\d . ]*(?:[,.]\\d{1,2})?\\s*€/))?.[0]; "
            "out.push({url:p.href,title:title.slice(0,300),...(price?{price:price.slice(0,80)}:{}),summary:lines.slice(0,8).join(' · ').slice(0,1000),...(image?.currentSrc?{image:image.currentSrc}:{})}); if(out.length>=limit)break;} return out; }",
            limit,
        )
        items = found if isinstance(found, list) else []
        return {"query": query, "url": snapshot.url, "count": len(items), "items": items}

    async def get_item(self, url: str) -> dict[str, object]:
        snapshot = await self.browser.navigate(url)
        self._assert_no_challenge(snapshot)
        output = await self.browser.evaluate(
            "() => { const text=(document.body?.innerText||'').replace(/\\n{3,}/g,'\\n\\n').trim(); "
            "const canonical=document.querySelector('link[rel=\"canonical\"]')?.href||location.href; const title=document.querySelector('h1')?.textContent?.trim()||document.title; "
            "const images=[...document.querySelectorAll('img')].map(i=>i.currentSrc||i.src).filter(Boolean).slice(0,12); "
            "return {url:location.href,canonical_url:canonical,title:title.slice(0,500),visible_text:text.slice(0,12000),images}; }"
        )
        return output if isinstance(output, dict) else {}

    async def prepare(self, draft: Draft) -> dict[str, object]:
        if not await self._wait_for_listing_form(15.0):
            raise RuntimeError("BROWSER_AUTH_REQUIRED: Vinted listing form requires an authenticated account")
        snapshot = await self.browser.snapshot()
        self._assert_no_challenge(snapshot)
        await self.browser.upload_files(draft.image_paths)
        await self._fill_required(("Titre", "Title", "title"), draft.title)
        await self._fill_required(("Description", "description"), draft.description)
        await self._fill_required(("Prix", "Price", "price"), draft.price)
        await self._choose(("Catégorie", "Category", "catalog"), draft.category)
        await self._choose(("État", "Condition", "status"), draft.condition)
        if draft.brand:
            await self._fill_or_choose(("Marque", "Brand", "brand"), draft.brand)
        if draft.size:
            await self._choose(("Taille", "Size", "size"), draft.size)
        if draft.parcel_size:
            await self._choose(("Taille du colis", "Parcel size", "Colis"), draft.parcel_size)
        self.draft = draft
        return {
            "prepared": True,
            "submitted": False,
            "draft_token": draft.token,
            "summary": {
                "title": draft.title,
                "description": draft.description,
                "price_eur": draft.price,
                "category": draft.category,
                "condition": draft.condition,
                **({"brand": draft.brand} if draft.brand else {}),
                **({"size": draft.size} if draft.size else {}),
                **({"parcel_size": draft.parcel_size} if draft.parcel_size else {}),
                "image_count": len(draft.image_paths),
            },
            "approval_required": "Ask the user to approve this exact summary before calling publish_item.",
        }

    async def publish(self, token: str) -> dict[str, object]:
        draft = self.draft
        if draft is None or not secrets.compare_digest(draft.token, token):
            raise ProtocolError("draft_token does not match the currently prepared Vinted draft")
        before = await self.browser.snapshot()
        self._assert_no_challenge(before)
        if not urlsplit(before.url).path.startswith("/items/new"):
            raise RuntimeError("BROWSER_STATE_CONFLICT: the prepared Vinted listing form is no longer open")
        self.draft = None
        if not await self.browser.click_semantic(("Mettre en ligne", "Publier", "Vendre", "Upload"), required=True):
            raise RuntimeError("BROWSER_STATE_CONFLICT: Vinted publish action is unavailable")
        deadline = asyncio.get_running_loop().time() + 25.0
        snapshot = before
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.25)
            snapshot = await self.browser.snapshot()
            self._assert_no_challenge(snapshot)
            if re.fullmatch(r"/items/\d+(?:-[^/]+)?/?", urlsplit(snapshot.url).path):
                return {
                    "published": True,
                    "url": normalize_item_url(snapshot.url),
                    "title": draft.title,
                    "price_eur": draft.price,
                }
        if re.search(r"erreur|obligatoire|requis|required|incorrect|vérification|verification", snapshot.body_text, re.I):
            raise RuntimeError("BROWSER_INTERACTION_REQUIRED: Vinted requires a correction or verification before publication")
        raise RuntimeError("BROWSER_NAVIGATION_TIMEOUT: Vinted did not confirm listing publication")

    async def status(self) -> dict[str, object]:
        cookies = await self.browser.cookies()
        names = sorted(
            {
                str(cookie["name"])
                for cookie in cookies
                if isinstance(cookie.get("name"), str)
                and isinstance(cookie.get("domain"), str)
                and str(cookie["domain"]).lower().lstrip(".").endswith("vinted.fr")
            }
        )
        current = await self.browser.current_url()
        return {
            "authenticated": bool(names) and "/member/" not in current,
            "cookie_names": names,
            "current_url": current,
            "engine": "browser-use",
        }

    async def _wait_for_field(self, labels: tuple[str, ...], timeout: float, types: tuple[str, ...]) -> bool:
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if await self.browser.find_semantic_index(labels, tags=("input", "textarea"), input_types=types) is not None:
                return True
            self._assert_no_challenge(await self.browser.snapshot())
            await asyncio.sleep(0.25)
        return False

    async def _wait_for_listing_form(self, timeout: float) -> bool:
        current = await self.browser.current_url()
        if not urlsplit(current).path.startswith("/items/new"):
            await self.browser.navigate(f"{VINTED_ORIGIN}/items/new")
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            snapshot = await self.browser.snapshot()
            self._assert_no_challenge(snapshot)
            ready = await self.browser.evaluate(
                "() => [...document.querySelectorAll('input[type=\"file\"],textarea,input')].some(e => e.getClientRects().length > 0 && !e.disabled)"
            )
            if ready and urlsplit(snapshot.url).path.startswith("/items/new"):
                return True
            if "/member/" in urlsplit(snapshot.url).path or "/login" in urlsplit(snapshot.url).path:
                return False
            await asyncio.sleep(0.25)
        return False

    async def _fill_required(self, labels: tuple[str, ...], value: str) -> None:
        if not await self.browser.fill_semantic(labels, value):
            raise RuntimeError(f"BROWSER_STATE_CONFLICT: Vinted field '{labels[0]}' is unavailable")

    async def _fill_or_choose(self, labels: tuple[str, ...], value: str) -> None:
        if await self.browser.fill_semantic(labels, value):
            await self.browser.click_semantic((value,))
            return
        await self._choose(labels, value)

    async def _choose(self, labels: tuple[str, ...], raw_value: str) -> None:
        for value in (part.strip() for part in raw_value.split(">") if part.strip()):
            selected = await self.browser.evaluate(
                "(labels,value) => { const norm=x=>(x||'').trim().replace(/\\s+/g,' ').toLocaleLowerCase('fr'); "
                "for(const label of document.querySelectorAll('label')){if(!labels.some(x=>norm(label.textContent).includes(norm(x))))continue; "
                "const select=(label.htmlFor?document.getElementById(label.htmlFor):null)||label.parentElement?.querySelector('select'); if(!(select instanceof HTMLSelectElement))continue; "
                "const option=[...select.options].find(x=>norm(x.textContent)===norm(value)); if(!option)return false; select.value=option.value; select.dispatchEvent(new Event('change',{bubbles:true})); return true;} return false; }",
                list(labels),
                value,
            )
            if selected:
                continue
            if not await self.browser.click_semantic(labels, required=True):
                raise RuntimeError(f"BROWSER_STATE_CONFLICT: Vinted selector '{labels[0]}' is unavailable")
            if not await self.browser.click_semantic((value,), required=True):
                raise RuntimeError(f"BROWSER_INTERACTION_REQUIRED: Vinted option '{value}' is unavailable")

    @staticmethod
    def _assert_no_challenge(snapshot: object) -> None:
        if detect_datadome_challenge(snapshot):
            raise RuntimeError("BROWSER_INTERACTION_REQUIRED: Vinted presented a DataDome challenge")


driver = VintedDriver()


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
    if VINTED_ORIGIN not in configuration.allowed_origins:
        raise ProtocolError(f"allowed_origins omits {VINTED_ORIGIN}")
    driver.configure(configuration)
    return await driver.acquire(inputs)


async def search_items(args: Mapping[str, object]) -> object:
    query = required_string(args.get("query"), "query", 120).strip()
    if not query:
        raise ProtocolError("query must not be blank")
    limit = args.get("limit", 10)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20:
        raise ProtocolError("limit must be an integer from 1 to 20")
    configure_from_env()
    return await driver.search(query, limit)


async def get_item(args: Mapping[str, object]) -> object:
    configure_from_env()
    return await driver.get_item(normalize_item_url(args.get("url")))


async def browser_status(_args: Mapping[str, object]) -> object:
    configure_from_env()
    return await driver.status()


async def prepare_item_draft(args: Mapping[str, object]) -> object:
    configure_from_env()
    title = required_string(args.get("title"), "title", 100).strip()
    description = required_string(args.get("description"), "description", 2000).strip()
    category = required_string(args.get("category"), "category", 120).strip()
    condition = required_string(args.get("condition"), "condition", 120).strip()
    if not title or not description or not category or not condition:
        raise ProtocolError("listing text fields must not be blank")
    draft = Draft(
        token=secrets.token_urlsafe(32),
        title=title,
        description=description,
        price=normalize_price(args.get("price_eur")),
        category=category,
        condition=condition,
        brand=_optional_string(args.get("brand"), "brand", 120),
        size=_optional_string(args.get("size"), "size", 120),
        parcel_size=_optional_string(args.get("parcel_size"), "parcel_size", 120),
        image_paths=resolve_workspace_images(args.get("image_paths")),
    )
    return await driver.prepare(draft)


async def publish_item(args: Mapping[str, object]) -> object:
    token = required_string(args.get("draft_token"), "draft_token", 128)
    if args.get("confirm_publish") is not True:
        raise ProtocolError("confirm_publish must be true after explicit user approval")
    configure_from_env()
    return await driver.publish(token)


server = JsonRpcMcpServer(
    name="appstrate-vinted-browser-use",
    version="1.0.0",
    tools=TOOLS,
    handlers={
        "acquire_session": acquire_session,
        "search_items": search_items,
        "get_item": get_item,
        "browser_status": browser_status,
        "prepare_item_draft": prepare_item_draft,
        "publish_item": publish_item,
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
