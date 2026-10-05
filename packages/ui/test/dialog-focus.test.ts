// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { captureDialogOpener, restoreDialogOpener } from "../src/dialog-focus.ts";

function element(opts: { connected?: boolean; menuLabelledBy?: string } = {}) {
  const el = {
    isConnected: opts.connected ?? true,
    focused: 0,
    focus() {
      el.focused++;
    },
    closest: (selector: string) =>
      selector === '[role="menu"]' && opts.menuLabelledBy
        ? {
            getAttribute: (name: string) =>
              name === "aria-labelledby" ? opts.menuLabelledBy! : null,
          }
        : null,
  };
  return el;
}

const emptyDoc = { getElementById: () => null };

describe("dialog focus return", () => {
  it("refocuses the control that had focus when the dialog opened", () => {
    const button = element();
    const opener = captureDialogOpener(button);

    expect(restoreDialogOpener(opener, emptyDoc)).toBe(true);
    expect(button.focused).toBe(1);
  });

  it("falls back to the menu trigger when the opener was a menu item, gone by close time", () => {
    const item = element({ menuLabelledBy: "radix-trigger-1" });
    const trigger = element();
    const opener = captureDialogOpener(item);
    item.isConnected = false; // the menu unmounted with its items

    const doc = { getElementById: (id: string) => (id === "radix-trigger-1" ? trigger : null) };
    expect(restoreDialogOpener(opener, doc)).toBe(true);
    expect(trigger.focused).toBe(1);
    expect(item.focused).toBe(0);
  });

  it("reports nothing to restore when the opener left the page and had no menu", () => {
    const button = element();
    const opener = captureDialogOpener(button);
    button.isConnected = false;

    expect(restoreDialogOpener(opener, emptyDoc)).toBe(false);
    expect(button.focused).toBe(0);
  });

  it("reports nothing to restore when nothing had focus", () => {
    expect(restoreDialogOpener(captureDialogOpener(null), emptyDoc)).toBe(false);
  });
});
