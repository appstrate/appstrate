// SPDX-License-Identifier: Apache-2.0

/**
 * Follow a launched run's logs in the chat: fetch the persisted history once,
 * then tail new lines live over the run's SSE stream. Drives `ChatRunProgressCard`.
 *
 * Three sources, merged (they overlap):
 *  1. `GET /api/runs/:id/logs` — the persisted history, so a panel that mounts
 *     late (reopened conversation, or a `run_and_wait` whose run already
 *     finished) still shows everything.
 *  2. `GET /api/realtime/runs/:id?verbose=true` (EventSource) — the live tail
 *     while the run is in flight. Closed as soon as the run goes terminal.
 *  3. `GET /api/files?run_id=…&purpose=agent_output` — the AUTHORITATIVE list of
 *     what the run produced, read once the run is terminal. The log window is
 *     capped (`?limit=1000`, ascending) and the end-of-run publication frames
 *     are the last rows a run writes, so a chatty run pushes exactly those
 *     frames out of the window; the same happens to a reopened conversation
 *     whose logs have since been pruned. The frames stay the live incremental
 *     source (chips appear the moment an agent publishes) and this read is
 *     UNIONED on top — never subtracted from — so a failed fetch degrades to
 *     the log-derived set rather than emptying the card.
 *
 * Auth mirrors the OAuth connect card: relative URLs, `credentials: "include"`
 * (cookie session), and the host's forwarded `X-Org-Id` / `X-Space-Id`
 * for the SSE query params (EventSource cannot send headers).
 */

import { useEffect, useState } from "react";
import { runProducedFilesPath } from "@appstrate/core/run-and-wait-client";
import { useChatHeaders } from "./runtime-context.ts";
import {
  buildRunSseUrl,
  isTerminalStatus,
  mergeLogs,
  mergeRunFiles,
  orgSpaceFromHeaders,
  parseLogListResponse,
  parseRunLogFrame,
  parseRunResource,
  parseRunUpdateFrame,
  producedFilesFromFileList,
  shouldRaiseSweepDone,
  type ChatRunFile,
  type RunLogLine,
  type RunStatus,
  type SweepRead,
} from "./run-events.ts";

interface RunLogStream {
  logs: RunLogLine[];
  status: RunStatus | undefined;
  packageId: string | undefined;
  /** ISO timestamp the run started executing, once a `run_update` reports it. */
  startedAt: string | undefined;
  /** ISO timestamp the run reached a terminal status, once reported. */
  completedAt: string | undefined;
  /**
   * Server-authoritative duration in ms (`runs.duration`), once reported.
   * This is the same value the run page shows — prefer it over a local
   * `completedAt - startedAt` computation, which diverges whenever the
   * runner supplied its own execution-window `durationMs` at finalize.
   */
  duration: number | undefined;
  /**
   * Files this run PRODUCED, read from `/api/files` (see source 3 above).
   * Empty until that read lands — the caller unions it with the log-derived
   * list, it never replaces it.
   */
  producedFiles: ChatRunFile[];
  /**
   * The authoritative read came back with more rows than its page held (the
   * route clamps `limit` to 100). The card says so rather than showing a
   * silently truncated chips row; it does not page. Never endangers the
   * auto-present rule — a truncated page holds ≥100 entries, never exactly 1.
   */
  producedFilesTruncated: boolean;
  /**
   * POSITIVE completion signal: the hook has actually finished reading this
   * run's produced-file set, so `producedFiles` ∪ the log frames is the
   * complete set and the auto-present rule may count it (`autoPresentFile`).
   *
   * The invariant, decided in one place (`shouldRaiseSweepDone`): **no
   * evidence, no flag; and no flag means nothing is presented, never an error
   * and never a spinner.** A read that merely FINISHED is not evidence — the
   * flag is raised only when the authoritative `/api/files` read answered 2xx
   * with a parsed list envelope (an envelope listing zero files counts: a run
   * that produced nothing is a complete answer).
   *
   * Raised from the two — and only two — places that know no further
   * publication can arrive:
   *
   *  - the terminal `run_update` handler, after its final log sweep AND the
   *    `/api/files` read have both settled. This also covers a card that
   *    mounts on an already-finished run: the SSE is opened even then, and the
   *    server answers with a `run_update` snapshot that takes this path.
   *  - the one-shot run read, when no live tail can be opened at all (missing
   *    `X-Org-Id` / `X-Space-Id`, or no `EventSource`) and the run comes
   *    back terminal — nothing else will ever report on this run.
   *
   * Never inferred from the ABSENCE of a live tail. `live` used to serve as
   * this gate and could not: it starts `false`, flips true only on the SSE
   * handshake — which loses the race against the two plain GETs fired in the
   * same tick — and never flips at all when no SSE is opened. A run answering
   * `/runs/:id` with `success` a few ms before its stream connects would be
   * read as settled on a partial file set.
   *
   * When neither path fires (both reads failed, run still in flight) the flag
   * stays false and nothing is auto-presented: no evidence, no presentation.
   */
  sweepDone: boolean;
}

/**
 * @param runId       the launched run id (`run_…`), or undefined to stay idle.
 * @param initialStatus status already known from the launch result (e.g.
 *                      `run_and_wait` returns a terminal run) — seeds the badge
 *                      and lets the hook skip the SSE when already terminal.
 */
export function useRunLogStream(
  runId: string | undefined,
  initialStatus?: string,
  initialPackageId?: string,
): RunLogStream {
  const getHeaders = useChatHeaders();
  const [logs, setLogs] = useState<RunLogLine[]>([]);
  const [status, setStatus] = useState<RunStatus | undefined>(
    isTerminalStatus(initialStatus) ? initialStatus : undefined,
  );
  const [packageId, setPackageId] = useState<string | undefined>(undefined);
  const [startedAt, setStartedAt] = useState<string | undefined>(undefined);
  const [completedAt, setCompletedAt] = useState<string | undefined>(undefined);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const [producedFiles, setProducedFiles] = useState<ChatRunFile[]>([]);
  const [producedFilesTruncated, setProducedFilesTruncated] = useState(false);
  const [sweepDone, setSweepDone] = useState(false);

  // Every field above is derived from ONE run. The effect re-subscribes when
  // `runId` changes but cannot clear them (an effect body may not call
  // `setState` here), so the reset is React's documented render-phase
  // adjustment — the same pattern as `run-detail-tabs-controller.tsx`. It
  // re-renders before anything is painted, so the previous run's values never
  // reach the screen. Without it a card whose `runId` moves between two real
  // ids renders run A's chips under run B and can auto-open A's file against
  // B's terminal status: `sweepDone` has no self-correcting path (the `live`
  // flag it replaced was reset on close; this one never is).
  const [subscribedRunId, setSubscribedRunId] = useState(runId);
  if (subscribedRunId !== runId) {
    setSubscribedRunId(runId);
    setLogs([]);
    setStatus(isTerminalStatus(initialStatus) ? initialStatus : undefined);
    setPackageId(undefined);
    setStartedAt(undefined);
    setCompletedAt(undefined);
    setDuration(undefined);
    setProducedFiles([]);
    setProducedFilesTruncated(false);
    setSweepDone(false);
  }

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const headers = getHeaders?.() ?? {};
    const { orgId, spaceId } = orgSpaceFromHeaders(headers);

    // Decided up front (not after the fetches) because the one-shot run read
    // below needs to know whether anything else will ever report on this run.
    // NOTE this says the tail is OPENABLE, not that it ever opened — see the
    // `es.onerror` fallback for the case where the connection never lands.
    const sseUrl = buildRunSseUrl({ runId, orgId, spaceId });
    const willTail = !!sseUrl && typeof EventSource !== "undefined";

    const apply = (incoming: RunLogLine[]) => {
      if (cancelled || incoming.length === 0) return;
      setLogs((prev) => mergeLogs(prev, incoming));
    };

    /**
     * Read the authoritative produced-file set, and report whether the read
     * produced EVIDENCE: `"ok"` only when the response was 2xx AND the payload
     * parsed as the list envelope. An envelope listing ZERO files is `"ok"` —
     * a run that produced nothing is a legitimate, complete answer, and must
     * not be confused with a 500 or an error body.
     *
     * The files themselves are unioned into whatever is already there, so a
     * failure or a partial page can only ever leave the card with the
     * log-derived list.
     */
    const readProducedFiles = async (): Promise<SweepRead> => {
      try {
        const res = await fetch(runProducedFilesPath(runId), {
          headers,
          credentials: "include",
        });
        if (!res.ok) return "failed";
        const page = producedFilesFromFileList(await res.json(), runId);
        if (!page) return "failed";
        if (cancelled) return "failed";
        if (page.files.length > 0) setProducedFiles((prev) => mergeRunFiles(prev, page.files));
        if (page.hasMore) setProducedFilesTruncated(true);
        return "ok";
      } catch {
        // ignore — the log frames remain the source
        return "failed";
      }
    };

    // 1. History fetch (best-effort — a failure just means the live tail is the
    //    only source). Same-origin, cookie auth + forwarded org/space headers.
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/logs?limit=1000`, {
          headers,
          credentials: "include",
        });
        if (!res.ok || cancelled) return;
        apply(parseLogListResponse(await res.json()));
      } catch {
        // ignore — SSE remains the source of truth
      }
    })();

    // 1b. One-shot current-status fetch (best-effort). On a mid-run reload the
    //     persisted launch result only holds the transient `pending`, so the
    //     badge would read "Lancement" until the SSE snapshot lands. Seed the
    //     live lifecycle fields from the run resource so the card is correct
    //     immediately. Every setter is a `prev ?? …` merge, so a live
    //     `run_update` frame that arrives first always wins.
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
          headers,
          credentials: "include",
        });
        if (!res.ok || cancelled) return;
        const run = parseRunResource(await res.json());
        if (!run || cancelled) return;
        setStatus((prev) => prev ?? (run.status as RunStatus));
        if (run.packageId) setPackageId((prev) => prev ?? run.packageId ?? undefined);
        if (run.startedAt) setStartedAt((prev) => prev ?? run.startedAt ?? undefined);
        if (run.completedAt) setCompletedAt((prev) => prev ?? run.completedAt ?? undefined);
        if (typeof run.duration === "number")
          setDuration((prev) => prev ?? run.duration ?? undefined);
        // No live tail will ever open (missing org/space context, or no
        // EventSource): this read is the last word on a terminal run, so it
        // also owns the completion signal. With a tail, the `run_update`
        // snapshot below owns it instead — it lands after a strictly larger
        // read.
        //
        // No final log sweep is attempted on this path, so it claims none: the
        // history fetch above is fire-and-forget and its outcome is not part of
        // the claim. The authoritative read is the whole of the evidence here.
        if (!willTail && isTerminalStatus(run.status)) {
          const producedFileRead = await readProducedFiles();
          if (
            !cancelled &&
            shouldRaiseSweepDone({
              status: run.status,
              producedFileRead,
              logSweep: "not-attempted",
            })
          ) {
            setSweepDone(true);
          }
        }
      } catch {
        // ignore — SSE remains the source of truth
      }
    })();

    // 2. Live tail. Skipped only when org/space context or EventSource is unavailable.
    //    Even terminal initial results still open briefly to receive the SSE snapshot.
    if (!sseUrl || !willTail) {
      return () => {
        cancelled = true;
      };
    }

    const es = new EventSource(sseUrl, { withCredentials: true });

    es.addEventListener("run_log", (e) => {
      const line = parseRunLogFrame((e as MessageEvent).data);
      if (line) apply([line]);
    });

    // `sendInitialRunSnapshot` emits a `run_update` on EVERY connect, and
    // `es.close()` below only lands two awaits later, so a reconnect (or a
    // fan-out UPDATE on an already-terminal run) can otherwise start a second
    // sweep: two 1000-row log fetches plus two `/api/files` reads. Both merges
    // dedup, so correctness held — the duplicated work did not.
    let swept = false;

    es.addEventListener("run_update", (e) => {
      const update = parseRunUpdateFrame((e as MessageEvent).data);
      if (!update || cancelled) return;
      setStatus(update.status as RunStatus);
      if (update.packageId) setPackageId(update.packageId);
      if (update.startedAt) setStartedAt(update.startedAt);
      if (update.completedAt) setCompletedAt(update.completedAt);
      if (typeof update.duration === "number") setDuration(update.duration);
      if (isTerminalStatus(update.status) && !swept) {
        swept = true;
        // One final full history sweep catches log lines the trigger may have
        // emitted in the same tick as the terminal status (mergeLogs dedups the
        // overlap), then the authoritative produced-file read — which is what
        // covers the run whose publication frames fell outside the log window.
        // `sweepDone` is raised only if BOTH produced evidence
        // (`shouldRaiseSweepDone` owns that rule), which is what makes it mean
        // "the file set is complete" rather than "the fetches returned".
        void (async () => {
          let logSweep: SweepRead = "failed";
          let producedFileRead: SweepRead = "not-attempted";
          try {
            try {
              const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/logs?limit=1000`, {
                headers,
                credentials: "include",
              });
              if (res.ok) {
                const finalLogs = parseLogListResponse(await res.json());
                logSweep = "ok";
                apply(finalLogs);
              }
            } catch {
              // `logSweep` stays "failed": an errored sweep yields no rows,
              // which is indistinguishable from a run that wrote none.
            }
            if (!cancelled) producedFileRead = await readProducedFiles();
          } finally {
            es.close();
            if (
              !cancelled &&
              shouldRaiseSweepDone({ status: update.status, producedFileRead, logSweep })
            ) {
              setSweepDone(true);
            }
          }
        })();
      }
    });

    // The tail was OPENABLE, not necessarily OPEN.
    let tailFallbackRead = false;
    es.onerror = () => {
      // EventSource auto-reconnects on transient errors (readyState CONNECTING)
      // — nothing to do for those, and if the run is already terminal we closed
      // it above. CLOSED means it gave up for good: a 401 from
      // `validateSSEAuth`, a proxy that refuses `text/event-stream`, a wrong
      // content type. No `run_update` will ever arrive on this stream, and the
      // one-shot run read declined to own the completion signal precisely
      // because `willTail` was true — so without this the card keeps an empty
      // `producedFiles` FOREVER, and a run whose publication frames fell
      // outside the log window shows no chips at all.
      //
      // Deliberately does NOT raise `sweepDone`: the chips are real evidence,
      // "the set is complete" is not — the run may still be in flight, and a
      // mid-stream count of 1 is not the final count.
      if (cancelled || tailFallbackRead || es.readyState !== EventSource.CLOSED) return;
      tailFallbackRead = true;
      void readProducedFiles();
    };

    return () => {
      cancelled = true;
      es.close();
    };
    // initialStatus is read once at subscribe time; runId is the real identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  return {
    logs,
    status,
    packageId: packageId ?? initialPackageId,
    startedAt,
    completedAt,
    duration,
    producedFiles,
    producedFilesTruncated,
    sweepDone,
  };
}
