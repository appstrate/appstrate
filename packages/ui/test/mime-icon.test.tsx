// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MimeIcon } from "../src/components/mime-icon.tsx";

/** The Lucide icon class a mime renders (`lucide-file-text`, …). */
const iconOf = (mime: string) =>
  /lucide-(file[a-z-]*)/.exec(renderToStaticMarkup(<MimeIcon mime={mime} />))?.[1];

describe("MimeIcon", () => {
  it("maps common families", () => {
    expect(iconOf("image/png")).toBe("file-image");
    expect(iconOf("text/html")).toBe("file-code");
    expect(iconOf("application/json")).toBe("file-code");
    expect(iconOf("application/zip")).toBe("file-archive");
    expect(iconOf("text/csv")).toBe("file-spreadsheet");
    expect(iconOf("text/plain")).toBe("file-text");
    expect(iconOf("application/pdf")).toBe("file-text");
  });

  it("falls back to the neutral file icon", () => {
    expect(iconOf("application/octet-stream")).toBe("file");
    expect(iconOf("")).toBe("file");
  });
});
