// SPDX-License-Identifier: Apache-2.0

/**
 * A file a call of a conversation produced in another space is judged, previewed and
 * shown in THAT space: the grant of the working space neither opens nor refuses it.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { FileAttachment } from "../src/ui/file-attachment.tsx";
import { ChatHostProvider, type ChatHost } from "../src/ui/runtime-context.ts";
import { testHost } from "./fake-request.ts";

const imageSpaces: Array<string | undefined> = [];

const host = (over: Partial<ChatHost>): ChatHost =>
  testHost({
    useFileImageSrc: (_id, spaceId) => {
      imageSpaces.push(spaceId);
      return "blob:thumb";
    },
    can: () => false,
    ...over,
  });

const render = (file: Parameters<typeof FileAttachment>[0]["file"], over: Partial<ChatHost>) =>
  renderToString(
    <ChatHostProvider value={host(over)}>
      <FileAttachment file={file} />
    </ChatHostProvider>,
  );

describe("FileAttachment of another space", () => {
  const canIn = (spaceId: string, permission: string) =>
    spaceId === "spc_b" && permission === "files:read";

  it("opens where the file's space grants it, though the chat as a whole does not", () => {
    const html = render({ id: "f1", name: "a.md", spaceId: "spc_b" }, { canIn });
    expect(html).toContain("<button");
    expect(html).toContain("file.previewOf");
  });

  it("refuses where the file's space does not grant it, though the chat does", () => {
    const html = render({ id: "f1", name: "a.md", spaceId: "spc_a" }, { canIn, can: () => true });
    expect(html).not.toContain("<button");
    expect(html).toContain("file.noAccess");
  });

  it("asks the thumbnail in the file's space", () => {
    imageSpaces.length = 0;
    render({ id: "f1", name: "a.png", mime: "image/png", spaceId: "spc_b" }, { canIn });
    expect(imageSpaces).toEqual(["spc_b"]);
  });

  it("judges a file naming no space by the chat's own grant", () => {
    expect(render({ id: "f1", name: "a.md" }, { canIn, can: () => true })).toContain("<button");
    expect(render({ id: "f1", name: "a.md" }, { canIn })).not.toContain("<button");
  });
});
