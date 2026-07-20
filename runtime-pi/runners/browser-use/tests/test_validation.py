from __future__ import annotations

import unittest

from appstrate_browser_use.validation import (
    ChallengeSnapshot,
    ValidationError,
    bounded_cookie_header,
    canonical_browser_endpoint,
    canonical_https_origins,
    cookie_domain_is_allowed,
    detect_datadome_challenge,
    safe_browser_error,
)


class ValidationTests(unittest.TestCase):
    def test_rejects_noncanonical_control_endpoints(self) -> None:
        self.assertEqual(canonical_browser_endpoint("http://browser:8080"), "http://browser:8080")
        for value in ("https://browser:8080", "http://user@browser:8080", "http://browser:8080/x"):
            with self.assertRaises(ValidationError):
                canonical_browser_endpoint(value)

    def test_accepts_only_exact_https_origins(self) -> None:
        self.assertEqual(
            canonical_https_origins(["https://www.vinted.fr", "https://www.vinted.fr"]),
            ("https://www.vinted.fr",),
        )
        with self.assertRaises(ValidationError):
            canonical_https_origins(["https://www.vinted.fr/path"])

    def test_datadome_detection_uses_exact_hosts(self) -> None:
        self.assertTrue(
            detect_datadome_challenge(
                ChallengeSnapshot("https://x", "ok", "", ["https://geo.captcha-delivery.com/captcha"])
            )
        )
        self.assertFalse(
            detect_datadome_challenge(
                ChallengeSnapshot("https://x", "ok", "", ["https://geo.captcha-delivery.com.evil.test/captcha"])
            )
        )

    def test_cookie_header_drops_foreign_and_injected_values(self) -> None:
        cookies = [
            {"name": "datadome", "value": "domain", "domain": ".vinted.fr", "path": "/"},
            {"name": "datadome", "value": "www", "domain": "www.vinted.fr", "path": "/"},
            {"name": "foreign", "value": "secret", "domain": ".example.com", "path": "/"},
            {"name": "bad", "value": "x; y=z", "domain": ".vinted.fr", "path": "/"},
        ]
        self.assertEqual(
            bounded_cookie_header(cookies, allowed_suffix="vinted.fr", preferred_host="www.vinted.fr"),
            "datadome=www",
        )

    def test_state_cookie_domains_are_exact_and_errors_are_canonical(self) -> None:
        origins = ("https://vinted.fr", "https://www.vinted.fr")
        self.assertTrue(cookie_domain_is_allowed(".vinted.fr", origins))
        self.assertTrue(cookie_domain_is_allowed("www.vinted.fr", origins))
        self.assertFalse(cookie_domain_is_allowed("evil.vinted.fr", origins))
        self.assertFalse(cookie_domain_is_allowed("vinted.fr.evil.test", origins))
        self.assertEqual(
            safe_browser_error(RuntimeError("BROWSER_AUTH_REQUIRED: secret detail")),
            "BROWSER_AUTH_REQUIRED",
        )
        self.assertEqual(safe_browser_error(RuntimeError("password=hunter2")), "BROWSER_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
