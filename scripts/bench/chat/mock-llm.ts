// SPDX-License-Identifier: Apache-2.0

/**
 * A deterministic OpenAI-compatible upstream for the chat benchmark.
 *
 * It streams `chat.completions` SSE the way a reasoning model behind an
 * OpenAI-compatible gateway does — `reasoning_content` deltas, then `content`
 * deltas, then a usage frame — on a fixed timing profile, so two builds of the
 * platform compare with the model held constant. It records every request it
 * receives: the gap between the client sending a turn and this server
 * receiving it is pure platform time.
 *
 * The profile is a simulation, not a model: reasoning durations are inputs,
 * keyed by the `reasoning_effort` the platform sends. Calibrate them from a
 * `--upstream real` run.
 */

export interface MockProfile {
  /** Delay before the response headers and the first frame. */
  ttfbMs: number;
  /** Reasoning duration per `reasoning_effort` sent (`none` = field absent; an unlisted effort = no reasoning). */
  reasoningMsByEffort: Record<string, number>;
  /** Visible answer length, in tokens. Each token is one `lorem` — what the `ui` scenario counts. */
  textTokens: number;
  /** Output rate for both phases. */
  tokensPerSecond: number;
  /** Shape the answer as markdown (paragraphs, bullet lists) so the client renders many blocks. */
  markdown?: boolean;
}

export const DEFAULT_MOCK_PROFILE: MockProfile = {
  ttfbMs: 350,
  reasoningMsByEffort: { none: 0, low: 600, medium: 1500, high: 3000, max: 6000 },
  textTokens: 120,
  tokensPerSecond: 80,
};

export interface MockRequestRecord {
  /** `performance.timeOrigin + performance.now()` — the bench client's clock. */
  receivedAt: number;
  firstReasoningAt: number | null;
  firstContentAt: number | null;
  reasoningEffort: string | null;
  maxTokens: number | null;
  messageCount: number;
  toolCount: number;
  /** UTF-8 size of the request body — what the upstream must prefill. */
  bodyBytes: number;
}

export interface MockLlm {
  url: string;
  records: MockRequestRecord[];
  stop(): void;
}

const now = () => performance.timeOrigin + performance.now();

/** One answer token: `lorem`, with a paragraph break every 30 and a 4-item bullet list every 90 in markdown. */
function answerToken(i: number, markdown: boolean): string {
  if (!markdown || i === 0) return "lorem ";
  if (i % 90 === 0) return "\n\n- lorem ";
  if (i % 90 < 10 && i % 3 === 0) return "\n- lorem ";
  if (i % 30 === 0) return "\n\nlorem ";
  return "lorem ";
}

export function startMockLlm(profile: MockProfile): MockLlm {
  const records: MockRequestRecord[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 120,
    async fetch(req) {
      if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const receivedAt = now();
      const bytes = new Uint8Array(await req.arrayBuffer());
      const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      const effort = typeof body.reasoning_effort === "string" ? body.reasoning_effort : null;
      const maxTokens = body.max_completion_tokens ?? body.max_tokens;
      const record: MockRequestRecord = {
        receivedAt,
        firstReasoningAt: null,
        firstContentAt: null,
        reasoningEffort: effort,
        maxTokens: typeof maxTokens === "number" ? maxTokens : null,
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        bodyBytes: bytes.byteLength,
      };
      records.push(record);

      const frameMs = 1000 / profile.tokensPerSecond;
      const reasoningFrames = Math.round(
        (profile.reasoningMsByEffort[effort ?? "none"] ?? 0) / frameMs,
      );
      const promptTokens = Math.ceil(bytes.byteLength / 4);
      const id = `chatcmpl-${crypto.randomUUID()}`;
      const model = typeof body.model === "string" ? body.model : "bench-model";
      const encoder = new TextEncoder();
      const chunk = (
        delta: Record<string, unknown>,
        finishReason: string | null = null,
        extra = {},
      ) =>
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
            ...extra,
          })}\n\n`,
        );

      await Bun.sleep(profile.ttfbMs);
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(chunk({ role: "assistant", content: "" }));
          for (let i = 0; i < reasoningFrames + profile.textTokens; i++) {
            if (i > 0) await Bun.sleep(frameMs);
            // The platform hung up (a stopped turn): stop writing into a closed stream.
            if (cancelled) return;
            if (i < reasoningFrames) {
              record.firstReasoningAt ??= now();
              controller.enqueue(chunk({ reasoning_content: "hmm " }));
            } else {
              record.firstContentAt ??= now();
              const token = answerToken(i - reasoningFrames, profile.markdown ?? false);
              controller.enqueue(chunk({ content: token }));
            }
          }
          const completionTokens = reasoningFrames + profile.textTokens;
          controller.enqueue(
            chunk({}, "stop", {
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
                completion_tokens_details: { reasoning_tokens: reasoningFrames },
              },
            }),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    records,
    stop: () => void server.stop(true),
  };
}
