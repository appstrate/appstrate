// SPDX-License-Identifier: Apache-2.0

/**
 * The org list is the one read that must survive a refused role preview: the
 * refusal ends the preview, and an empty org list would send a member to
 * onboarding instead of back to their own view.
 */

import { describe, it, expect } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({});
const { readPastRefusedPreview } = await import("../use-org.ts");

const refusedPersona = new ApiError("view_as_not_found", "space is gone", 404);

/** A read whose first answer is `first`, and the org list after that. */
function orgRead(first: Error) {
  const read = Object.assign(
    () => (read.asked++ === 0 ? Promise.reject(first) : Promise.resolve(["org"])),
    { asked: 0 },
  );
  return read;
}

describe("readPastRefusedPreview", () => {
  it("asks again, at once, after a refused persona", async () => {
    const read = orgRead(refusedPersona);
    expect(await readPastRefusedPreview(read)).toEqual(["org"]);
    expect(read.asked).toBe(2);
  });

  it("lets any other failure through", async () => {
    const gone = new ApiError("not_found", "nope", 404);
    const read = orgRead(gone);
    await expect(readPastRefusedPreview(read)).rejects.toBe(gone);
    expect(read.asked).toBe(1);
  });

  it("surfaces a second refusal instead of looping", async () => {
    let asked = 0;
    const read = () => {
      asked++;
      return Promise.reject(refusedPersona);
    };
    await expect(readPastRefusedPreview(read)).rejects.toBe(refusedPersona);
    expect(asked).toBe(2);
  });

  // The boot prime: one promise, started before React, adopted by the query.
  it("leaves the list in the cache when the primed read is refused, with no retry", async () => {
    const qc = new QueryClient();
    const read = orgRead(refusedPersona);
    const primed = readPastRefusedPreview(read);

    const observer = new QueryObserver(qc, {
      queryKey: ["orgs"],
      queryFn: () => primed,
      retry: false,
      staleTime: 30_000,
    });
    const unsubscribe = observer.subscribe(() => {});
    await primed;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(qc.getQueryData<string[]>(["orgs"])).toEqual(["org"]);
    expect(observer.getCurrentResult().isLoading).toBe(false);
    // The mounted query has its answer: nothing asks a third time.
    expect(read.asked).toBe(2);
    unsubscribe();
  });
});
