# SPDX-License-Identifier: Apache-2.0
"""Enrich deterministic model metadata with the pinned LiteLLM package.

This script is executed only inside the digest-pinned LiteLLM image in the
weekly workflow. The optional input is LiteLLM's model catalog downloaded at
an exact upstream commit; the package supplies its supported-parameter API.
Appstrate never imports LiteLLM at runtime.
"""

import json
import sys
from contextlib import redirect_stdout

import litellm


# Only these providers feed Appstrate's pricing catalog. Calling the public
# helper for subscription backends such as `chatgpt` can start an interactive
# OAuth device flow; those entries are retained for the id-only watch snapshot
# but must never execute provider authentication during a catalog export.
PARAM_PROVIDER_ALLOWLIST = {
    "openai",
    "anthropic",
    "mistral",
    "gemini",
    "cerebras",
    "groq",
    "xai",
    "deepseek",
    "moonshot",
    "together_ai",
    "fireworks_ai",
    "zai",
}


def supported_params(model: str, provider: str | None) -> list[str] | None:
    if provider not in PARAM_PROVIDER_ALLOWLIST:
        return None
    try:
        # Some LiteLLM provider adapters print diagnostics directly to stdout.
        # Redirect them so stdout remains a single valid JSON document.
        with redirect_stdout(sys.stderr):
            params = litellm.get_supported_openai_params(
                model=model,
                custom_llm_provider=provider,
            )
        return sorted(params or [])
    except Exception as error:  # one malformed upstream entry must not abort the catalog
        print(f"warning: {model}: {error}", file=sys.stderr)
        return None


if len(sys.argv) > 2:
    raise SystemExit("usage: export-litellm-catalog.py [catalog.json]")

if len(sys.argv) == 2:
    with open(sys.argv[1], encoding="utf-8") as source_file:
        source_catalog = json.load(source_file)
    if not isinstance(source_catalog, dict) or not source_catalog:
        raise SystemExit("catalog input must be a non-empty JSON object")
else:
    source_catalog = litellm.model_cost

catalog: dict[str, object] = {}
for model, raw_entry in sorted(source_catalog.items()):
    entry = dict(raw_entry)
    params = supported_params(
        model,
        entry.get("litellm_provider"),
    )
    if params is not None:
        entry["_appstrate_supported_openai_params"] = params
    catalog[model] = entry

json.dump(catalog, sys.stdout, sort_keys=True, separators=(",", ":"))
sys.stdout.write("\n")
