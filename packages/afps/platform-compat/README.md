# @afps/platform-compat

Compatibility bundle of the five AFPS 1.3 platform tools (`add_memory`, `set_state`, `output`, `report`, `log`).

Intended for runners that need to auto-inject platform tools into pre-1.3 agents whose manifests never declared them as explicit dependencies. Native AFPS 1.3 bundles should depend on the individual `@afps/*` packages directly.
