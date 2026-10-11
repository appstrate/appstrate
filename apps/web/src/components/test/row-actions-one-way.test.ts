// SPDX-License-Identifier: Apache-2.0

/**
 * A table row is acted on in ONE way (DESIGN_SYSTEM.md, section 7, « A row's end »):
 * the « … » menu holds every action of the row, and a click on the row opens its
 * edit or its detail. No pencil, download or reconnect icon sits beside the « … ».
 *
 * This scan reads the sources, with no DOM, and fails when
 * - a `<TableRowActions>` is given a direct action (`primary`, or any prop other
 *   than the menu's own);
 * - the `actions` column of a column set draws a `<Button>`: that column is the
 *   row's end, and its only content is the menu;
 * - a `<Button>` or `<…ConnectButton>` is rendered as the sibling of a
 *   `<TableRowActions>` in the same wrapper (the reconnect icon that used to sit
 *   next to the connection menu).
 * A control that IS the setting (a role select, a switch, a share editor) lives in
 * its own column and is not an action of the row.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const WEB_SRC = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ALLOWED_PROPS = new Set(["menuLabel", "isPending", "pendingLabel", "renaming"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "test" || name === "lab" || name === "node_modules" ? [] : sources(path);
    }
    return name.endsWith(".tsx") && name !== "table-row-actions.tsx" ? [path] : [];
  });
}

/** The attribute names of the JSX tag that opens at `start` (just after its name). */
function propNames(text: string, start: number): string[] {
  const names: string[] = [];
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && c === ">") break;
    else if (depth === 0 && /\s/.test(text[i - 1] ?? "") && /[A-Za-z]/.test(c)) {
      const m = /^[A-Za-z][\w-]*/.exec(text.slice(i));
      if (m) names.push(m[0]);
      i += (m?.[0].length ?? 1) - 1;
    }
  }
  return names;
}

const files = sources(WEB_SRC).map((path) => ({
  path: relative(WEB_SRC, path),
  text: readFileSync(path, "utf8"),
}));

describe("a table row has one way to act", () => {
  it("scans the table sources", () => {
    expect(files.filter((f) => f.text.includes("<TableRowActions")).length).toBeGreaterThan(10);
  });

  it("gives TableRowActions no direct action, only the menu's own props", () => {
    const offenders: string[] = [];
    for (const { path, text } of files) {
      for (const m of text.matchAll(/<TableRowActions\b/g)) {
        for (const name of propNames(text, m.index + m[0].length)) {
          if (!ALLOWED_PROPS.has(name)) offenders.push(`${path}: <TableRowActions ${name}=…>`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("draws no button in the actions column of a column set", () => {
    const offenders: string[] = [];
    for (const { path, text } of files) {
      for (const m of text.matchAll(/id: "actions"/g)) {
        const rest = text.slice(m.index);
        const end = rest.indexOf("\n  ];");
        const column = end === -1 ? rest : rest.slice(0, end);
        if (/<Button\b/.test(column)) offenders.push(`${path}: a <Button> in the actions column`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("puts no button beside a TableRowActions in the same wrapper", () => {
    const offenders: string[] = [];
    for (const { path, text } of files) {
      for (const m of text.matchAll(/<TableRowActions\b/g)) {
        // The wrapper opens at the nearest preceding cell, `<div` or `<span`; what
        // sits between it and the menu is its sibling content.
        const before = text.slice(0, m.index);
        const wrapper = Math.max(
          before.lastIndexOf("<div"),
          before.lastIndexOf("<span"),
          before.lastIndexOf("<TableCell"),
        );
        const siblings = wrapper === -1 ? "" : before.slice(wrapper);
        if (/<(Button|\w*ConnectButton)\b/.test(siblings)) {
          offenders.push(`${path}: a button before <TableRowActions>`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
