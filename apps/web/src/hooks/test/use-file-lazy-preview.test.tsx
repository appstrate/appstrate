// SPDX-License-Identifier: Apache-2.0

/**
 * A grid tile asks for no excerpt while it is off-screen. A static render builds
 * the query without fetching it; the enabled side is out of reach here, since it
 * sees the stores' initial (empty) scope.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { render } = await import("../../test/render.tsx");
const { useFileExcerpt } = await import("../use-files.ts");

describe("useFileExcerpt", () => {
  it("builds a disabled query while the tile is off-screen", () => {
    const queryClient = new QueryClient();
    function Probe() {
      useFileExcerpt("file_1", false);
      return null;
    }
    render(<Probe />, { queryClient });
    const query = queryClient
      .getQueryCache()
      .find({ queryKey: ["get", "/api/files/{id}/excerpt"], exact: false })!;
    // `enabled` is an observer option, absent from the cached query's type.
    expect((query.options as { enabled?: boolean }).enabled).toBe(false);
  });
});
