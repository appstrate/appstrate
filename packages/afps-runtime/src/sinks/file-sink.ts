// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { appendFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventSink } from "../interfaces/event-sink.ts";
import type { RunEvent } from "@afps/types";
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
 * Append each {@link RunEvent} as a single JSON line; write the
 * aggregated {@link RunResult} to a companion `.result.json` on
 * finalize.
 *
 * The `.jsonl` produced here is the canonical input for event-sourced
 * replay: a subsequent run can tail the file and feed each line back
 * through a reducer to reconstruct the full run state.
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

  async handle(event: RunEvent): Promise<void> {
    await this.initOnce;
    await appendFile(this.path, JSON.stringify(event) + "\n", { encoding: "utf8" });
  }

  async finalize(result: RunResult): Promise<void> {
    await this.initOnce;
    await writeFile(this.resultPath, JSON.stringify(result, null, 2), { encoding: "utf8" });
  }
}
