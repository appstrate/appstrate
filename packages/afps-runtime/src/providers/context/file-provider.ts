// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { readFile, stat } from "node:fs/promises";
import type {
  ContextProvider,
  GetMemoriesOptions,
  GetHistoryOptions,
  ResourceContent,
} from "../../interfaces/context-provider.ts";
import type { HistoryEntry, MemorySnapshot } from "../../types/execution-context.ts";
import { afpsEventSchema, type AfpsEvent, type AfpsEventEnvelope } from "../../types/afps-event.ts";

export interface FileContextProviderOptions {
  /**
   * Absolute path(s) to one or more `.jsonl` files produced by
   * {@link FileSink}. Multiple files are replayed in the order given —
   * typically one per run, oldest first — so later writes shadow
   * earlier ones for `state`, and memories accumulate chronologically.
   */
  paths: readonly string[];
  /**
   * Inject a clock for deterministic tests. Defaults to `Date.now()`.
   * Used as `createdAt` for memories since envelopes carry no
   * timestamp — see note below.
   */
  now?: () => number;
}

/**
 * Event-sourced {@link ContextProvider} — replays one or more
 * `run-*.jsonl` files produced by {@link FileSink} to reconstruct the
 * memories / state / history a fresh agent should see.
 *
 * This is what closes the reproducibility loop: a run recorded into a
 * `.jsonl` can be fed into the next run without any server, making the
 * runtime fully portable (see
 * `AFPS_EXTENSION_ARCHITECTURE.md` §3.3).
 *
 * **Timestamps**: envelopes written by {@link FileSink} do not carry a
 * wall-clock field (by design — clocks diverge, `.jsonl` files are
 * relocatable). `createdAt` on replayed memories is therefore set to
 * the file's mtime at load time. Same within a file, monotonically
 * increasing across files when loaded in order. If you need precise
 * times, emit a `log` event alongside memories with an explicit
 * timestamp in the message, or store a companion metadata file.
 *
 * **Duplicate / out-of-order events**: memories are deduplicated by
 * `content` to keep replay idempotent; the earliest occurrence wins
 * (stable ordering). `set_state` uses last-write-wins across all files.
 */
export class FileContextProvider implements ContextProvider {
  private readonly paths: readonly string[];
  private readonly now: () => number;
  private cache: {
    memories: MemorySnapshot[];
    state: unknown;
  } | null = null;
  private loadOnce: Promise<void> | null = null;

  constructor(opts: FileContextProviderOptions) {
    if (opts.paths.length === 0) {
      throw new Error("FileContextProvider: `paths` must contain at least one file");
    }
    this.paths = opts.paths;
    this.now = opts.now ?? Date.now;
  }

  async getMemories(opts?: GetMemoriesOptions): Promise<MemorySnapshot[]> {
    await this.ensureLoaded();
    let out = this.cache!.memories;
    if (opts?.since !== undefined) {
      const threshold = opts.since;
      out = out.filter((m) => m.createdAt >= threshold);
    }
    if (opts?.limit !== undefined && opts.limit >= 0) {
      out = out.slice(0, opts.limit);
    }
    return out;
  }

  async getHistory(_opts?: GetHistoryOptions): Promise<HistoryEntry[]> {
    // Raw `.jsonl` files do not carry per-run outputs in a shape suitable
    // for `HistoryEntry`. A caller who needs history should layer a
    // {@link SnapshotContextProvider} on top.
    return [];
  }

  async getState(): Promise<unknown | null> {
    await this.ensureLoaded();
    return this.cache!.state ?? null;
  }

  async getResource(_uri: string): Promise<ResourceContent | undefined> {
    return undefined;
  }

  private ensureLoaded(): Promise<void> {
    if (this.cache) return Promise.resolve();
    if (!this.loadOnce) this.loadOnce = this.load();
    return this.loadOnce;
  }

  private async load(): Promise<void> {
    const memories: MemorySnapshot[] = [];
    const memorySeen = new Set<string>();
    let state: unknown = null;

    for (const path of this.paths) {
      const fileTime = await this.readMtime(path);
      const events = await this.readEvents(path);
      for (const ev of events) {
        if (ev.type === "add_memory") {
          if (memorySeen.has(ev.content)) continue;
          memorySeen.add(ev.content);
          memories.push({ content: ev.content, createdAt: fileTime });
        } else if (ev.type === "set_state") {
          state = ev.state;
        }
      }
    }

    this.cache = { memories, state };
  }

  private async readMtime(path: string): Promise<number> {
    try {
      const s = await stat(path);
      return s.mtimeMs;
    } catch {
      return this.now();
    }
  }

  private async readEvents(path: string): Promise<AfpsEvent[]> {
    const raw = await readFile(path, { encoding: "utf8" });
    const lines = raw.split("\n");
    const events: AfpsEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseEnvelopeLine(trimmed);
      if (parsed) events.push(parsed);
    }
    return events;
  }
}

function parseEnvelopeLine(line: string): AfpsEvent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const envelope = obj as Partial<AfpsEventEnvelope>;
  if (!envelope.event || typeof envelope.event !== "object") return null;
  const parsed = afpsEventSchema.safeParse(envelope.event);
  return parsed.success ? parsed.data : null;
}
