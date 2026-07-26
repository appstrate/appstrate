// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

export { HttpSink, type HttpSinkOptions } from "./http-sink.ts";
export { CompositeSink } from "./composite-sink.ts";
export { createReducerSink, type ReducerSinkHandle } from "./reducer-sink.ts";
export {
  attachStdoutBridge,
  isStdoutEventLine,
  mergeTerminalResult,
  type StdoutBridgeHandle,
  type StdoutBridgeOptions,
} from "./stdout-bridge.ts";
