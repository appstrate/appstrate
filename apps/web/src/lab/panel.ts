// SPDX-License-Identifier: Apache-2.0

/**
 * Scenario switcher for lab mode.
 *
 * Plain DOM, mounted outside `#root` on purpose: it must never appear in the
 * React tree, the router, or a screenshot of the design being worked on. It is
 * a tool sitting next to the app, not part of it.
 */
import { SCENARIOS, getScenario, setScenario, type Scenario } from "./scenario";
import {
  LAB_PRESETS,
  LAB_ROLES,
  getPreset,
  getRole,
  setPreset,
  setRole,
  type LabPreset,
  type LabRole,
} from "./role";

const LABELS: Record<Scenario, string> = {
  nominal: "Nominal",
  empty: "Vide",
  heavy: "Charge",
  error: "Erreur",
};

/** The role's own label: what the caller IS, not what the data looks like. */
const ROLE_LABELS: Record<LabRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

/** The space preset — the axis most screens actually read. */
const PRESET_LABELS: Record<LabPreset, string> = {
  admin: "Admin",
  builder: "Builder",
  operator: "Operator",
  runner: "Runner",
  viewer: "Viewer",
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
    "flex-direction:column",
    "gap:3px",
    "align-items:stretch",
    "padding:5px 7px",
    "border-radius:9px",
    "background:rgba(20,20,23,.92)",
    "color:#fff",
    "font:11px/1 ui-sans-serif,system-ui,sans-serif",
    "box-shadow:0 4px 16px rgba(0,0,0,.35)",
    "backdrop-filter:blur(6px)",
  ].join(";");

  const scenario = getScenario();
  host.append(
    row(
      "LAB",
      SCENARIOS.map((value) => pill(LABELS[value], value === scenario, () => setScenario(value))),
    ),
  );

  // Second row: WHO is looking. Flipping it reloads with a weaker permission
  // set, so a gate that never hides anything shows up here immediately.
  const role = getRole();
  host.append(
    row(
      "ORG",
      LAB_ROLES.map((value) => pill(ROLE_LABELS[value], value === role, () => setRole(value))),
    ),
  );

  const preset = getPreset();
  host.append(
    row(
      "ESPACE",
      LAB_PRESETS.map((value) =>
        pill(PRESET_LABELS[value], value === preset, () => setPreset(value)),
      ),
    ),
  );

  document.body.append(host);
}

function row(name: string, pills: HTMLElement[]): HTMLDivElement {
  const line = document.createElement("div");
  line.style.cssText = "display:flex;gap:4px;align-items:center";
  line.append(label(name));
  for (const p of pills) line.append(p);
  return line;
}

function label(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = text;
  span.style.cssText =
    "opacity:.5;letter-spacing:.08em;font-weight:600;margin:0 3px;min-width:30px";
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
