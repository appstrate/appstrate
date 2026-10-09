// SPDX-License-Identifier: Apache-2.0
/**
 * The two doors a non-OAuth connection is completed through, for route-boundary tests: the
 * member route `POST /api/integrations/{packageId}/auths/{authKey}/connect/fields` and the
 * hosted end-user form `POST /api/integrations/connect/submit`.
 */
import { expect } from "bun:test";
import { getTestApp } from "./app.ts";
import { authHeaders, type TestContext } from "./auth.ts";

/** A problem body as the connect routes answer it. */
export interface ProblemBody {
  status: number;
  code: string;
  detail: string;
  param?: string;
}

/** Complete a connection through `connect/fields`, as the member `ctx`. */
export function fieldsConnect(
  ctx: TestContext,
  integrationId: string,
  authKey: string,
  credentials: Record<string, unknown>,
  variables?: Record<string, string>,
): Promise<Response> {
  return Promise.resolve(
    getTestApp().request(`/api/integrations/${integrationId}/auths/${authKey}/connect/fields`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ credentials, ...(variables ? { variables } : {}) }),
    }),
  );
}

/** Drive the hosted portal end to end: mint → dispatch → context → submit. */
export async function hostedSubmit(
  ctx: TestContext,
  integrationId: string,
  authKey: string,
  credentials: Record<string, unknown>,
): Promise<Response> {
  const app = getTestApp();
  const mint = await app.request(
    `/api/integrations/${integrationId}/auths/${authKey}/connect/session`,
    {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  expect(mint.status).toBe(200);
  const token = new URL(
    ((await mint.json()) as { connect_url: string }).connect_url,
  ).searchParams.get("token")!;
  const start = await app.request(
    `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
    { redirect: "manual" },
  );
  const cookie = `appstrate_connect=${start.headers.get("set-cookie")!.match(/appstrate_connect=([^;]+)/)![1]}`;
  const context = (await (
    await app.request("/api/integrations/connect/context", { headers: { Cookie: cookie } })
  ).json()) as { csrf: string };
  return app.request("/api/integrations/connect/submit", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "x-connect-csrf": context.csrf },
    body: JSON.stringify({ credentials }),
  });
}
