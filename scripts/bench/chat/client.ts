// SPDX-License-Identifier: Apache-2.0

/**
 * The bench's user: signs up, creates an organization, and sends chat turns
 * exactly as the SPA does — `POST /api/chat` with the conversation's UIMessage
 * history, the session cookie and the org/space headers — then reads the AI SDK
 * UI message stream and timestamps what a user would see.
 */

import { lines } from "./lines.ts";

const now = () => performance.timeOrigin + performance.now();

/** A turn that has not finished by then is recorded as failed rather than hanging the bench. */
const TURN_TIMEOUT_MS = 180_000;

export interface BenchUser {
  cookie: string;
  orgId: string;
  spaceId: string;
}

async function expectOk(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`${what} failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

export async function seedUser(origin: string): Promise<BenchUser> {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const signUp = await expectOk(
    await fetch(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `bench-${tag}@bench.test`,
        password: "BenchPassword123!",
        name: `Bench ${tag}`,
      }),
    }),
    "sign-up",
  );
  const cookie = signUp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((pair) => pair.includes("session_token="))
    .join("; ");
  if (!cookie) throw new Error("sign-up returned no session cookie");

  const org = await expectOk(
    await fetch(`${origin}/api/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ name: `Bench ${tag}`, slug: `bench-${tag}` }),
    }),
    "org creation",
  );
  const orgId = ((await org.json()) as { id: string }).id;
  const spaces = await expectOk(
    await fetch(`${origin}/api/spaces`, { headers: { cookie, "x-org-id": orgId } }),
    "space listing",
  );
  const space = ((await spaces.json()) as { data: { id: string; isDefault: boolean }[] }).data.find(
    (s) => s.isDefault,
  );
  if (!space) throw new Error("no default space after org creation");
  return { cookie, orgId, spaceId: space.id };
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  parts: Record<string, unknown>[];
}

export interface TurnTimings {
  /** Absolute send time, bench clock. */
  sentAt: number;
  /** 0 when no response came back at all. */
  status: number;
  /** All `*Ms` below: ms after `sentAt`, or null when the event never came. */
  headersMs: number | null;
  startMs: number | null;
  firstReasoningMs: number | null;
  firstTextMs: number | null;
  /** First thing a user can see move: reasoning or text. */
  firstVisibleMs: number | null;
  finishMs: number | null;
  endMs: number | null;
  reasoningChars: number;
  textChars: number;
  toolCalls: number;
  error: string | null;
}

export function newSessionId(): string {
  return `chs_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function userMessage(text: string): UiMessage {
  return { id: crypto.randomUUID().slice(0, 16), role: "user", parts: [{ type: "text", text }] };
}

/** Sends one turn and reads its stream to the end; every failure is recorded in `error`, never thrown. */
export async function sendTurn(
  origin: string,
  user: BenchUser,
  sessionId: string,
  history: UiMessage[],
  extraBody: Record<string, unknown>,
): Promise<{ timings: TurnTimings; assistant: UiMessage | null }> {
  const sentAt = now();
  const since = () => now() - sentAt;
  const t: TurnTimings = {
    sentAt,
    status: 0,
    headersMs: null,
    startMs: null,
    firstReasoningMs: null,
    firstTextMs: null,
    firstVisibleMs: null,
    finishMs: null,
    endMs: null,
    reasoningChars: 0,
    textChars: 0,
    toolCalls: 0,
    error: null,
  };
  let messageId: string | null = null;
  let text = "";
  try {
    const res = await fetch(`${origin}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: user.cookie,
        origin,
        "x-org-id": user.orgId,
        "x-space-id": user.spaceId,
        "x-chat-locale": "fr",
      },
      body: JSON.stringify({ id: sessionId, messages: history, ...extraBody }),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    t.status = res.status;
    t.headersMs = since();
    if (!res.ok || !res.body) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);

    for await (const line of lines(res.body)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let event: { type?: string; delta?: string; messageId?: string; errorText?: string };
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      const at = since();
      switch (event.type) {
        case "start":
          t.startMs ??= at;
          messageId = event.messageId ?? messageId;
          break;
        case "reasoning-delta":
          t.firstReasoningMs ??= at;
          t.firstVisibleMs ??= at;
          t.reasoningChars += event.delta?.length ?? 0;
          break;
        case "text-delta":
          t.firstTextMs ??= at;
          t.firstVisibleMs ??= at;
          t.textChars += event.delta?.length ?? 0;
          text += event.delta ?? "";
          break;
        case "tool-input-start":
          t.toolCalls++;
          break;
        case "finish":
          t.finishMs ??= at;
          break;
        case "error":
          t.error = event.errorText ?? "stream error";
          break;
      }
    }
  } catch (err) {
    t.error = err instanceof Error ? err.message : String(err);
  }
  t.endMs = since();
  const assistant: UiMessage | null =
    !t.error && messageId && text
      ? { id: messageId, role: "assistant", parts: [{ type: "text", text }] }
      : null;
  return { timings: t, assistant };
}
