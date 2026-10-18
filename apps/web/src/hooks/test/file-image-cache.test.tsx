// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
});

const { render } = await import("../../test/render");
const { useFileImageSrc } = await import("../use-files");
const { client } = await import("../../api/client");
const { queryClient } = await import("../../lib/query-client");

function Image() {
  useFileImageSrc("file_network");
  return null;
}

function imageOptions(qc: QueryClient) {
  render(<Image />, { queryClient: qc });
  const query = qc
    .getQueryCache()
    .findAll()
    .find((q) => q.queryKey[0] === "file-blob");
  if (!query) throw new Error("Missing image query");
  return { ...query.options, queryKey: query.queryKey, enabled: true };
}

describe("image preview cache", () => {
  it("retries a failed image on reopening, then reuses the successful URL", async () => {
    const qc = new QueryClient();
    const options = imageOptions(qc);
    const get = spyOn(client, "GET")
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue({ data: new Blob(["image"]), response: new Response() });
    const create = spyOn(URL, "createObjectURL").mockReturnValue("blob:recovered");
    try {
      const first = new QueryObserver(qc, options);
      const closeFirst = first.subscribe(() => {});
      await first.refetch();
      closeFirst();
      const reopened = new QueryObserver(qc, options);
      const closeReopened = reopened.subscribe(() => {});
      // Await the automatically started read, without manually forcing a refetch.
      await qc.getQueryCache().find({ queryKey: options.queryKey })?.promise;
      expect(get).toHaveBeenCalledTimes(2);
      expect(reopened.getCurrentResult().data).toBe("blob:recovered");
      closeReopened();
      const cached = new QueryObserver(qc, options);
      const closeCached = cached.subscribe(() => {});
      expect(cached.getCurrentResult().data).toBe("blob:recovered");
      expect(get).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenCalledTimes(1);
      closeCached();
    } finally {
      get.mockRestore();
      create.mockRestore();
      qc.clear();
    }
  });

  it("does not create a URL if a removed query's response arrives late", async () => {
    const options = imageOptions(queryClient);
    const response = Promise.withResolvers<{ data: Blob; response: Response }>();
    const get: ReturnType<typeof spyOn> = spyOn(client, "GET");
    get.mockImplementation(() => response.promise);
    const create = spyOn(URL, "createObjectURL").mockReturnValue("blob:late");
    try {
      const fetching = queryClient.fetchQuery(options).catch(() => undefined);
      queryClient.removeQueries({ queryKey: options.queryKey });
      response.resolve({ data: new Blob(["image"]), response: new Response() });
      await response.promise;
      await fetching;
      expect(create).not.toHaveBeenCalled();
      expect(queryClient.getQueryCache().find({ queryKey: options.queryKey })).toBeUndefined();
    } finally {
      get.mockRestore();
      create.mockRestore();
      queryClient.clear();
    }
  });
});
