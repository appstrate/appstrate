// SPDX-License-Identifier: Apache-2.0

/** The local source edits the inline run declaration: type, entry point, command, args. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { SourceSection } from "../source-section.tsx";
import { entryPointMissing } from "../utils.ts";

await i18nReady;
// The source label reads the app config off `window`.
installFakeStorage({
  __APP_CONFIG__: { features: { localIntegrations: true }, trustedOrigins: [] },
});

const manifest = {
  source: {
    kind: "local",
    server: {
      type: "python",
      entry_point: "server/main.py",
      mcp_config: { command: "uv", args: ["run", "server/main.py"], env: { A: "1" } },
      tools: [{ name: "t" }],
    },
  },
};

function renderSection(files?: string[], m: Record<string, unknown> = manifest) {
  return render(<SourceSection manifest={m} onChange={() => {}} serverFiles={files} />);
}

describe("SourceSection, local source", () => {
  it("shows the run declaration fields with their stored values", () => {
    const html = renderSection();
    expect(html).toContain('id="int-source-server-entry"');
    expect(html).toContain('value="server/main.py"');
    expect(html).toContain('id="int-source-server-command"');
    expect(html).toContain('value="uv"');
    expect(html).toContain('id="int-source-server-args"');
    expect(html).toContain("run\nserver/main.py");
  });

  it("renders an empty-string argument without looping on it", () => {
    const withBlank = {
      source: {
        kind: "local",
        server: {
          type: "node",
          entry_point: "a.js",
          mcp_config: { command: "node", args: ["--name", ""] },
        },
      },
    };
    expect(renderSection(undefined, withBlank)).toContain("--name\n");
  });

  it("warns when the entry point names a file the package does not hold", () => {
    expect(renderSection(["manifest.json"])).toContain("integration-editor-entry-point-missing");
  });

  it("stays quiet when the file exists or the file list is unknown", () => {
    expect(renderSection(["manifest.json", "server/main.py"])).not.toContain(
      "integration-editor-entry-point-missing",
    );
    expect(renderSection(undefined)).not.toContain("integration-editor-entry-point-missing");
  });
});

describe("entryPointMissing", () => {
  it("ignores a ./ or / prefix and a blank entry point", () => {
    expect(entryPointMissing("./server/a.js", ["server/a.js"])).toBe(false);
    expect(entryPointMissing("/server/a.js", ["server/a.js"])).toBe(false);
    expect(entryPointMissing("  ", [])).toBe(false);
    expect(entryPointMissing("server/b.js", ["server/a.js"])).toBe(true);
  });
});
