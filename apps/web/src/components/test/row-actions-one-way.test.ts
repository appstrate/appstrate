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
 * - a `<Button>` or `<…ConnectButton>` shares the nearest `<div>`, `<span>` or
 *   `<TableCell>` holding a `<TableRowActions>`, before or after it (a reconnect
 *   icon next to the connection menu).
 * A control that IS the setting (a role select, a switch, a share editor) lives in
 * its own column and is not an action of the row.
 *
 * Its sight is each file's own JSX: a button drawn by a child component beside the
 * menu is not seen, and review holds that.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const WEB_SRC = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ALLOWED_PROPS = new Set(["menuLabel", "isPending", "renaming"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "test" || name === "lab" || name === "node_modules" ? [] : sources(path);
    }
    return name.endsWith(".tsx") && name !== "table-row-actions.tsx" ? [path] : [];
  });
}

/**
 * The index of the `>` ending the JSX opening tag whose attributes start at `start`, and
 * whether it closes itself. Braces and quotes are skipped, so `a > b` in a prop does not end it.
 */
function tagEnd(text: string, start: number): { end: number; selfClosing: boolean } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (depth === 0 && (c === '"' || c === "'")) quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && c === ">") return { end: i, selfClosing: text[i - 1] === "/" };
  }
  return { end: text.length, selfClosing: false };
}

/**
 * The attribute names of the JSX tag that opens at `start` (just after its name); a spread
 * is `...`.
 */
function propNames(text: string, start: number): string[] {
  const { end } = tagEnd(text, start);
  const names: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < end; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (depth === 0 && (c === '"' || c === "'")) quote = c;
    else if (c === "{") {
      if (depth === 0 && text.startsWith("{...", i)) names.push("...");
      depth++;
    } else if (c === "}") depth--;
    else if (depth === 0 && /\s/.test(text[i - 1] ?? "") && /[A-Za-z]/.test(c)) {
      const m = /^[A-Za-z][\w-]*/.exec(text.slice(i))!;
      names.push(m[0]);
      i += m[0].length - 1;
    }
  }
  return names;
}

/** The index just past the `}` matching the `{` at `open`, quoted braces skipped. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return text.length;
}

/** The `{ … }` object literal that holds the property at `at`: a column of a column set. */
function enclosingObject(text: string, at: number): string {
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{" && depth-- === 0) return text.slice(i, closingBrace(text, i));
  }
  return text.slice(at);
}

/** The end of the element named `tag` whose `<tag` is at `open` (just past its closing tag). */
function elementEnd(text: string, open: number, tag: string): number {
  const first = tagEnd(text, open + tag.length + 1);
  if (first.selfClosing) return first.end + 1;
  const marks = new RegExp(`<${tag}\\b|</${tag}>`, "g");
  marks.lastIndex = first.end;
  let depth = 1;
  for (let m = marks.exec(text); m; m = marks.exec(text)) {
    if (m[0].startsWith("</")) {
      if (--depth === 0) return m.index + m[0].length;
    } else if (!tagEnd(text, m.index + m[0].length).selfClosing) depth++;
  }
  return text.length;
}

const WRAPPERS = ["div", "span", "TableCell"];

/**
 * What shares a wrapper with the `<TableRowActions>` at `at`: the nearest `<div>`, `<span>` or
 * `<TableCell>` that still holds it inside its cell, without the menu itself. Empty when it
 * has none.
 */
function besideMenu(text: string, at: number): string {
  const menuEnd = elementEnd(text, at, "TableRowActions");
  const opens = [...text.slice(0, at).matchAll(new RegExp(`<(${WRAPPERS.join("|")})\\b`, "g"))];
  for (const open of opens.reverse()) {
    // A wrapper outside the cell (`cell:` lies between) is the page's layout, not the row's end.
    if (text.slice(open.index, at).includes("cell:")) return "";
    const end = elementEnd(text, open.index, open[1]!);
    if (end >= menuEnd) return text.slice(open.index, at) + text.slice(menuEnd, end);
  }
  return "";
}

const files = sources(WEB_SRC).map((path) => ({
  path: relative(WEB_SRC, path),
  text: readFileSync(path, "utf8"),
}));

describe("the scan's reading of JSX", () => {
  it("reads every prop, a quoted `>` and a spread included", () => {
    const tag = '<TableRowActions menuLabel="a > b" {...rest} isPending={x > 1}>';
    expect(propNames(tag, "<TableRowActions".length)).toEqual(["menuLabel", "...", "isPending"]);
  });

  it("reads the actions column alone, wherever it sits in the set", () => {
    const set = `[\n    { id: "actions", cell: () => <Menu /> },\n    { id: "name", cell: () => <Button /> },\n  ]`;
    expect(enclosingObject(set, set.indexOf('id: "actions"'))).not.toContain("<Button");
  });

  it("sees a button after the menu as well as before it, and none outside the wrapper", () => {
    const after = '<div><TableRowActions menuLabel="x"><Item /></TableRowActions><Button /></div>';
    expect(besideMenu(after, after.indexOf("<TableRowActions"))).toContain("<Button");
    const apart = '<div><Button /></div><span><TableRowActions menuLabel="x" /></span>';
    expect(besideMenu(apart, apart.indexOf("<TableRowActions"))).not.toContain("<Button");
    const page = '<div><Button />{cell: () => <TableRowActions menuLabel="x" />}</div>';
    expect(besideMenu(page, page.indexOf("<TableRowActions"))).toBe("");
  });
});

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
        if (/<Button\b/.test(enclosingObject(text, m.index))) {
          offenders.push(`${path}: a <Button> in the actions column`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("puts no button beside a TableRowActions in the same wrapper", () => {
    const offenders: string[] = [];
    for (const { path, text } of files) {
      for (const m of text.matchAll(/<TableRowActions\b/g)) {
        if (/<(Button|\w*ConnectButton)\b/.test(besideMenu(text, m.index))) {
          offenders.push(`${path}: a button beside <TableRowActions>`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("renames a name only from the menu: driven, never opened by a click on the name", () => {
    const offenders: string[] = [];
    for (const { path, text } of files) {
      for (const m of text.matchAll(/<InlineEditableLabel\b/g)) {
        const props = propNames(text, m.index + m[0].length);
        for (const required of ["editing", "onEditingChange"]) {
          if (!props.includes(required))
            offenders.push(`${path}: <InlineEditableLabel> without ${required}`);
        }
      }
      // Every file that draws a renamable name also draws the « Rename » entry that opens it.
      if (text.includes("<InlineEditableLabel") && !text.includes("btn.rename")) {
        offenders.push(`${path}: a renamable name without a « Rename » entry (btn.rename)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
