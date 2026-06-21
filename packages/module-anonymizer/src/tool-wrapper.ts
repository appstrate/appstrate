// SPDX-License-Identifier: Apache-2.0

// Wrapper d'outils : LE point crucial des runs d'agents.
// Le LLM raisonne en jetons -> il appelle un outil avec des jetons dans les args.
//   - RESTORE des args AVANT execution (l'outil agit sur les vraies valeurs)
//   - ANONYMISE le resultat APRES execution (le LLM ne revoit que des jetons)
// A brancher au choke point mcp-host buildTools : chaque tool (runtime_tools,
// MCP, integrations) passe par la, une seule fois.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AnonSession } from "./run-session.ts";

type ToolLike = { execute?: (args: any, opts?: any) => Promise<any> } & Record<string, any>;

export function wrapToolWithAnonymizer<T extends ToolLike>(tool: T, session: AnonSession): T {
  if (typeof tool.execute !== "function") return tool;
  const original = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(args: any, opts?: any) {
      const realArgs = await session.unmaskDeep(args); // jetons -> vraies valeurs
      const result = await original(realArgs, opts); // l'outil agit pour de vrai
      return session.maskDeep(result); // resultat -> jetons
    },
  } as T;
}

/** Enveloppe un dictionnaire de tools (forme AI SDK / MCP). */
export function wrapToolsWithAnonymizer<T extends Record<string, ToolLike>>(
  tools: T,
  session: AnonSession,
): T {
  const out: Record<string, ToolLike> = {};
  for (const [name, tool] of Object.entries(tools)) {
    out[name] = wrapToolWithAnonymizer(tool, session);
  }
  return out as T;
}
