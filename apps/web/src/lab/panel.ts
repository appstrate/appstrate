// SPDX-License-Identifier: Apache-2.0

/**
 * Scenario switcher for lab mode.
 *
 * Plain DOM, mounted outside `#root` on purpose: it must never appear in the
 * React tree, the router, or a screenshot of the design being worked on. It is
 * a tool sitting next to the app, not part of it.
 */
import { SCENARIOS, getScenario, setScenario, type Scenario } from "./scenario";
import { DEPTHS, applyDepth, getDepth, type Depth } from "./canvas-depth";

const LABELS: Record<Scenario, string> = {
  nominal: "Nominal",
  empty: "Vide",
  heavy: "Charge",
  error: "Erreur",
};

export function mountLabPanel(): void {
  const host = document.createElement("div");
  host.setAttribute("data-lab-panel", "");
  host.style.cssText = [
    "position:fixed",
    "bottom:12px",
    "right:12px",
    "z-index:2147483647",
    "display:flex",
    "gap:4px",
    "align-items:center",
    "padding:5px 7px",
    "border-radius:9px",
    "background:rgba(20,20,23,.92)",
    "color:#fff",
    "font:11px/1 ui-sans-serif,system-ui,sans-serif",
    "box-shadow:0 4px 16px rgba(0,0,0,.35)",
    "backdrop-filter:blur(6px)",
  ].join(";");

  host.append(label("LAB"));

  const scenario = getScenario();
  for (const value of SCENARIOS) {
    host.append(pill(LABELS[value], value === scenario, () => setScenario(value)));
  }

  host.append(separator(), label("GRIS"));

  // The grey buttons restyle themselves in place: switching depth must not
  // reload, or the comparison the dial exists for is lost with the scroll.
  const depths = new Map<Depth, HTMLButtonElement>();
  const paint = (chosen: Depth) => {
    for (const [key, button] of depths) style(button, key === chosen);
  };
  for (const key of Object.keys(DEPTHS) as Depth[]) {
    const button = pill(key, false, () => {
      applyDepth(key);
      paint(key);
    });
    button.title = DEPTHS[key].note;
    depths.set(key, button);
    host.append(button);
  }
  const depth = getDepth();
  applyDepth(depth);
  paint(depth);

  document.body.append(host);
}

function label(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = text;
  span.style.cssText = "opacity:.5;letter-spacing:.08em;font-weight:600;margin:0 3px";
  return span;
}

function separator(): HTMLSpanElement {
  const span = document.createElement("span");
  span.style.cssText = "width:1px;align-self:stretch;margin:0 4px;background:rgba(255,255,255,.18)";
  return span;
}

function pill(text: string, active: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.addEventListener("click", onClick);
  style(button, active);
  return button;
}

function style(button: HTMLButtonElement, active: boolean): void {
  button.style.cssText = [
    "all:unset",
    "cursor:pointer",
    "padding:4px 8px",
    "border-radius:6px",
    `background:${active ? "#fff" : "transparent"}`,
    `color:${active ? "#141417" : "rgba(255,255,255,.7)"}`,
    active ? "font-weight:600" : "font-weight:400",
  ].join(";");
}
