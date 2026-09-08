// SPDX-License-Identifier: Apache-2.0

/**
 * The sentence a refused billing save puts in the toast.
 *
 * Both admin sections hand `toast.error` the same builder, so this is where the
 * one thing that matters is pinned: a 400 problem+json has to arrive as the
 * server's own `detail` — "Owners and admins already manage billing …" — not as
 * "API Error: 400", which names neither the id nor the reason.
 */

import { describe, expect, it } from "bun:test";
import { toApiError } from "../../api/client.ts";
import { billingSaveErrorMessage } from "../billing-error.ts";

const prefix = (message: string) => `Erreur : ${message}`;

describe("the refused-save message", () => {
  it("carries the server's problem+json detail", async () => {
    const detail =
      "Owners and admins already manage billing through their organization role: usr_owner";
    const error = await toApiError(
      new Response(
        JSON.stringify({ code: "invalid_request", detail, param: "user_ids", status: 400 }),
        { status: 400, headers: { "content-type": "application/problem+json" } },
      ),
    );

    expect(billingSaveErrorMessage(error, prefix)).toBe(`Erreur : ${detail}`);
  });

  it("still says something useful when the answer carries no problem body", async () => {
    const error = await toApiError(new Response("<html>", { status: 502 }));
    expect(billingSaveErrorMessage(error, prefix)).not.toBe("Erreur : ");
  });
});
