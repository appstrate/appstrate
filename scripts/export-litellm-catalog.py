# SPDX-License-Identifier: Apache-2.0
"""Export deterministic model metadata from the pinned LiteLLM package.

This script is executed only inside the digest-pinned LiteLLM image in the
weekly workflow. Appstrate never imports LiteLLM at runtime.
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


catalog: dict[str, object] = {}
for model, raw_entry in sorted(litellm.model_cost.items()):
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
