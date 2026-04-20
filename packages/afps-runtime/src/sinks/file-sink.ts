// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { appendFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventSink } from "../interfaces/event-sink.ts";
import type { AfpsEventEnvelope } from "../types/afps-event.ts";
import type { RunResult } from "../types/run-result.ts";

export interface FileSinkOptions {
  /**
   * Absolute path to the JSON-lines event file. Parent directory is
   * created if missing. A companion `<path>.result.json` is written at
   * finalize.
   */
  path: string;
}

/**
 * Append each event to a `.jsonl` stream; write the aggregated
 * `RunResult` to a companion `.result.json` on finalize.
 *
 * The `.jsonl` produced here is the canonical input of
 * `FileContextProvider` (event-sourcing): a subsequent run can replay
 * the file to reconstruct memories/state without any server, closing
 * the loop for fully offline operation.
 *
 * Specification: see `AFPS_EXTENSION_ARCHITECTURE.md` §3.3, §6.
 */
export class FileSink implements EventSink {
  private readonly path: string;
  private readonly resultPath: string;
  private readonly initOnce: Promise<void>;

  constructor(opts: FileSinkOptions) {
    this.path = opts.path;
    this.resultPath = `${opts.path}.result.json`;
    this.initOnce = mkdir(dirname(this.path), { recursive: true }).then(() => undefined);
  }

  async onEvent(envelope: AfpsEventEnvelope): Promise<void> {
    await this.initOnce;
    const serialized = JSON.stringify(envelope);
    await appendFile(this.path, serialized + "\n", { encoding: "utf8" });
  }

  async finalize(result: RunResult): Promise<void> {
    await this.initOnce;
    await writeFile(this.resultPath, JSON.stringify(result, null, 2), { encoding: "utf8" });
  }
}
