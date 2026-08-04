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
from litellm.exceptions import UnsupportedParamsError
from litellm.utils import get_optional_params


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

REASONING_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
ACTIVE_REASONING_EFFORTS = tuple(
    effort for effort in REASONING_EFFORTS if effort != "none"
)
SUPPORT_FLAGS = (
    "supports_none_reasoning_effort",
    "supports_minimal_reasoning_effort",
    "supports_low_reasoning_effort",
    "supports_xhigh_reasoning_effort",
    "supports_max_reasoning_effort",
)


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


def optional_params_support(
    model: str,
    provider: str,
    **values: object,
) -> str:
    """Ask LiteLLM's provider adapter whether one parameter set is valid.

    `get_supported_openai_params` only describes parameter names. The adapter
    invoked here owns the value-level rules (for example GPT-5's asymmetric
    reasoning-effort support and its temperature/reasoning constraint).
    """
    try:
        with redirect_stdout(sys.stderr):
            get_optional_params(
                model=model,
                custom_llm_provider=provider,
                drop_params=False,
                **values,
            )
        return "supported"
    except UnsupportedParamsError:
        return "unsupported"
    except ValueError as error:
        # Several LiteLLM adapters use a plain ValueError for their enum guard
        # instead of UnsupportedParamsError. Keep the classification narrow so
        # configuration/parser failures still surface as unknown below.
        if "invalid reasoning effort" in str(error).lower():
            return "unsupported"
        rendered_values = ", ".join(f"{key}={value}" for key, value in values.items())
        print(f"warning: {model} ({rendered_values}): {error}", file=sys.stderr)
        return "unknown"
    except Exception as error:
        rendered_values = ", ".join(f"{key}={value}" for key, value in values.items())
        print(f"warning: {model} ({rendered_values}): {error}", file=sys.stderr)
        return "unknown"


def generation_capabilities(
    model: str,
    provider: str | None,
    entry: dict[str, object],
    params: list[str] | None,
) -> dict[str, object] | None:
    """Normalize LiteLLM's effective generation contract for Appstrate.

    Sparse `supports_*_reasoning_effort` catalog flags are deliberately not
    interpreted as a complete enum: LiteLLM's adapters contain additional
    defaults and validation rules. Persist their answer so downstream code is
    a projection only and never has to reproduce provider semantics.
    """
    if provider not in PARAM_PROVIDER_ALLOWLIST or params is None:
        return None

    if entry.get("supports_sampling_params") is False or "temperature" not in params:
        temperature = "unsupported"
    else:
        temperature = optional_params_support(model, provider, temperature=0.5)

    has_reasoning_evidence = (
        entry.get("supports_reasoning") is True
        or "reasoning_effort" in params
        or "thinking" in params
        or any(entry.get(flag) is True for flag in SUPPORT_FLAGS)
    )
    if entry.get("supports_reasoning") is False:
        reasoning = "unsupported"
        levels = {effort: "unsupported" for effort in REASONING_EFFORTS}
    elif has_reasoning_evidence:
        levels = {
            effort: optional_params_support(model, provider, reasoning_effort=effort)
            for effort in REASONING_EFFORTS
        }
        reasoning = "supported"
    else:
        reasoning = "unknown"
        levels = {effort: "unknown" for effort in REASONING_EFFORTS}

    temperature_with_reasoning = "unknown"
    supported_active_efforts = [
        effort for effort in ACTIVE_REASONING_EFFORTS if levels[effort] == "supported"
    ]
    if temperature == "unsupported" or reasoning == "unsupported":
        temperature_with_reasoning = "unsupported"
    elif temperature == "supported" and supported_active_efforts:
        pair_support = [
            optional_params_support(
                model,
                provider,
                temperature=0.5,
                reasoning_effort=effort,
            )
            for effort in supported_active_efforts
        ]
        if all(value == "supported" for value in pair_support):
            temperature_with_reasoning = "supported"
        elif all(value == "unsupported" for value in pair_support):
            temperature_with_reasoning = "unsupported"

    return {
        "temperature": temperature,
        "temperatureWithReasoning": temperature_with_reasoning,
        "reasoning": {
            "supported": reasoning,
            "adaptive": entry.get("supports_adaptive_thinking")
            if isinstance(entry.get("supports_adaptive_thinking"), bool)
            else None,
            "levels": levels,
        },
    }


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
    generation = generation_capabilities(
        model,
        entry.get("litellm_provider"),
        entry,
        params,
    )
    if generation is not None:
        entry["_appstrate_generation"] = generation
    catalog[model] = entry

json.dump(catalog, sys.stdout, sort_keys=True, separators=(",", ":"))
sys.stdout.write("\n")
