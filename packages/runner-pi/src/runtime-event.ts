// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Where the runner-pi tools report their events (`api_call.*`, `integration_tool.*`,
 * `resource.spilled`, …): any sink (CloudEvents, console, an in-memory test recorder).
 */
export type RuntimeEventEmitter = (event: { type: string; [k: string]: unknown }) => void;
