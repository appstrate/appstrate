// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

export * from "./execution-context.ts";
// `./manifest.ts` (deleted): a pass-through re-export of `@afps-spec/schema`
// that existed "so consumers do not need a direct dependency on the spec
// package". No taker ever appeared — every consumer, including this package's
// own `bundle/validate-bundle.ts`, imports `@afps-spec/schema` directly.
export type { RunEvent } from "@afps-spec/types";
export * from "./run-result.ts";
export * from "./canonical-events.ts";
