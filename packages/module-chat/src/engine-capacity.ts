// SPDX-License-Identifier: Apache-2.0

/**
 * Shared 429 capacity response for the subscription chat engines (codex/claude),
 * returned when the per-instance subprocess cap is reached so the client backs
 * off rather than the instance forking unbounded binaries. RFC 9457
 * problem+json — `useChat` surfaces it as a turn error. `service` names the
 * engine in the user-facing detail (e.g. "Codex", "Claude").
 */
export function capacityResponse(service: string): Response {
  const retryAfterSeconds = 5;
  return new Response(
    JSON.stringify({
      type: "https://docs.appstrate.dev/errors/chat-capacity",
      title: "Too Many Requests",
      status: 429,
      detail: `Le service de chat ${service} est temporairement saturé. Réessayez dans quelques instants.`,
      code: "chat_capacity",
      retry_after: retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/problem+json",
        "retry-after": String(retryAfterSeconds),
      },
    },
  );
}
