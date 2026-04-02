// SPDX-License-Identifier: Apache-2.0

import { makeContentPackageModule } from "./content-module-factory";

export const toolModule = makeContentPackageModule(
  "tool",
  `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";\n\nexport default function (pi: ExtensionAPI) {\n  pi.registerTool({\n    name: "my_tool",\n    description: "Describe what this tool does",\n    parameters: {},\n    execute(_toolCallId, _params, _signal) {\n      return { content: [{ type: "text", text: "Hello" }] };\n    },\n  });\n}\n`,
);
