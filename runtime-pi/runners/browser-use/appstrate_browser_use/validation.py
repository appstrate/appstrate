"""Dependency-free validation helpers used before Browser Use is imported."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from urllib.parse import urlsplit


class ValidationError(ValueError):
    """Raised for agent-safe malformed MCP input."""


SAFE_BROWSER_ERROR_CODES = frozenset(
    {
        "BROWSER_UNAVAILABLE",
        "BROWSER_UNSUPPORTED_REVISION",
        "BROWSER_POLICY_DENIED",
        "BROWSER_PROXY_UNAVAILABLE",
        "BROWSER_NAVIGATION_TIMEOUT",
        "BROWSER_CRASHED",
        "BROWSER_AUTH_REQUIRED",
        "BROWSER_INTERACTION_REQUIRED",
        "BROWSER_STATE_CONFLICT",
        "BROWSER_SESSION_BUSY",
        "BROWSER_RESOURCE_LIMIT",
    }
)


def safe_browser_error(value: object) -> str:
    match = re.search(r"\bBROWSER_[A-Z_]+\b", str(value))
    return match.group(0) if match and match.group(0) in SAFE_BROWSER_ERROR_CODES else "BROWSER_UNAVAILABLE"


def required_string(value: object, field: str, max_length: int) -> str:
    if not isinstance(value, str) or not value or len(value) > max_length:
        raise ValidationError(
            f"{field} must be a non-empty string of at most {max_length} chars"
        )
    return value


def canonical_browser_endpoint(value: object) -> str:
    raw = required_string(value, "browser_endpoint", 2048)
    parsed = urlsplit(raw)
    if (
        parsed.scheme != "http"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or raw != f"http://{parsed.netloc}"
    ):
        raise ValidationError("browser_endpoint must be a canonical HTTP origin")
    return raw


def canonical_https_origins(value: object) -> tuple[str, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= 64:
        raise ValidationError("allowed_origins must contain between 1 and 64 HTTPS origins")
    output: list[str] = []
    for raw in value:
        if not isinstance(raw, str):
            raise ValidationError("allowed_origins must contain only HTTPS origins")
        parsed = urlsplit(raw)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or raw != f"https://{parsed.netloc}"
        ):
            raise ValidationError("allowed_origins must contain only canonical HTTPS origins")
        if raw not in output:
            output.append(raw)
    return tuple(output)


def cookie_domain_is_allowed(raw_domain: object, allowed_origins: Sequence[str]) -> bool:
    if not isinstance(raw_domain, str) or not raw_domain:
        return False
    domain = raw_domain.lower().lstrip(".")
    return any((urlsplit(origin).hostname or "").lower() == domain for origin in allowed_origins)


@dataclass(frozen=True)
class ChallengeSnapshot:
    url: str
    title: str
    body_text: str
    frame_urls: Sequence[str]


_DATADOME_HOSTS = frozenset(
    {
        "ct.captcha-delivery.com",
        "geo.captcha-delivery.com",
        "static.captcha-delivery.com",
    }
)


def detect_datadome_challenge(snapshot: ChallengeSnapshot) -> bool:
    for raw in (snapshot.url, *snapshot.frame_urls):
        try:
            if (urlsplit(raw).hostname or "").lower() in _DATADOME_HOSTS:
                return True
        except ValueError:
            continue
    visible = f"{snapshot.title}\n{snapshot.body_text}".lower()
    return any(
        marker in visible
        for marker in (
            "datadome",
            "pardon the interruption",
            "verify you are human",
            "vérifiez que vous êtes humain",
            "confirmez que vous n'êtes pas un robot",
        )
    )


def bounded_cookie_header(
    cookies: Iterable[Mapping[str, object]],
    *,
    allowed_suffix: str,
    preferred_host: str,
    max_bytes: int = 64 * 1024,
) -> str:
    """Build a deterministic header without accepting injection or foreign cookies."""

    suffix = allowed_suffix.lower().lstrip(".")
    preferred = preferred_host.lower()
    selected: dict[str, tuple[str, int]] = {}
    for cookie in list(cookies)[:256]:
        name = cookie.get("name")
        value = cookie.get("value")
        domain_value = cookie.get("domain")
        if not all(isinstance(item, str) for item in (name, value, domain_value)):
            continue
        assert isinstance(name, str) and isinstance(value, str) and isinstance(domain_value, str)
        domain = domain_value.lower().lstrip(".")
        if domain != suffix and not domain.endswith(f".{suffix}"):
            continue
        if not name or len(name) > 256 or not value or any(ch in name + value for ch in ";\r\n"):
            continue
        path = cookie.get("path") if isinstance(cookie.get("path"), str) else "/"
        score = (10_000 if domain == preferred else 0) + len(path)
        previous = selected.get(name)
        if previous is None or score >= previous[1]:
            selected[name] = (value, score)
    header = "; ".join(f"{name}={selected[name][0]}" for name in sorted(selected))
    if len(header.encode("utf-8")) > max_bytes:
        raise RuntimeError("BROWSER_RESOURCE_LIMIT: exported cookie header is too large")
    return header
