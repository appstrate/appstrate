// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { resetEndUserLabState, resolveHandler } from "../handlers";

const detailUrl = new URL("http://lab.local/api/end-users/eu_lab_detail");

describe("end-user lab mutations", () => {
  beforeEach(resetEndUserLabState);

  it("persists a typed PATCH for the following detail read", () => {
    const updated = resolveHandler("PATCH", detailUrl, "nominal", new Headers(), {
      name: "Noémie Caron modifiée",
      externalId: "crm-51204-updated",
    });

    expect(updated?.status).toBe(200);
    expect(updated?.body).toMatchObject({
      id: "eu_lab_detail",
      name: "Noémie Caron modifiée",
      externalId: "crm-51204-updated",
    });

    expect(resolveHandler("GET", detailUrl, "nominal")?.body).toMatchObject({
      id: "eu_lab_detail",
      name: "Noémie Caron modifiée",
      externalId: "crm-51204-updated",
    });
  });

  it("does not persist a write from the error scenario", () => {
    expect(
      resolveHandler("PATCH", detailUrl, "error", new Headers(), {
        name: "Must not persist",
      })?.status,
    ).toBe(500);

    expect(resolveHandler("GET", detailUrl, "nominal")?.body).toMatchObject({
      name: "Noémie Caron",
    });
  });

  it("keeps a successful deletion out of later reads", () => {
    const deletedUrl = new URL("http://lab.local/api/end-users/eu_lab_2");
    expect(resolveHandler("DELETE", deletedUrl, "nominal")?.status).toBe(204);
    expect(resolveHandler("GET", deletedUrl, "nominal")?.status).toBe(404);
  });
});
