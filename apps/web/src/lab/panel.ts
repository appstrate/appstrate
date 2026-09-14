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
  effectivePreset,
  hasFullSpaceAccess,
  getRole,
  setPreset,
  setRole,
  type LabPreset,
  type LabRole,
} from "./role";

/** Collapsed or not, remembered across the reloads every switch triggers. */
const COLLAPSED_KEY = "appstrate-lab-panel-collapsed";

/** lucide `flask-conical`, inline: the panel stays outside React and its icons. */
const FLASK_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/></svg>';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(COLLAPSED_KEY, "1");
    else localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    // Storage blocked: the panel still toggles, it just forgets on reload.
  }
}

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
  const panel = buildPanel();
  const chip = buildChip();
  const show = (collapsed: boolean) => {
    // Inline `display` would win over the `hidden` attribute, so set it directly.
    panel.style.display = collapsed ? "none" : "flex";
    chip.style.display = collapsed ? "grid" : "none";
    writeCollapsed(collapsed);
  };
  panel
    .querySelector<HTMLButtonElement>("[data-lab-collapse]")!
    .addEventListener("click", () => show(true));
  chip.addEventListener("click", () => show(false));
  document.body.append(panel, chip);
  show(readCollapsed());
}

/**
 * The panel folded away: a small round button in the same corner, so the
 * screen under it can be looked at whole. Its tooltip still says who is
 * looking, and a dot marks a state that is not the default one.
 */
function buildChip(): HTMLButtonElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.setAttribute("data-lab-chip", "");
  chip.setAttribute("aria-label", "Ouvrir le panneau lab");
  const scenario = getScenario();
  chip.title = `Lab : ${LABELS[scenario]} · ${ROLE_LABELS[getRole()]} · ${PRESET_LABELS[effectivePreset()]}`;
  chip.innerHTML = FLASK_ICON;
  chip.style.cssText = [
    "all:unset",
    "position:fixed",
    "bottom:12px",
    "right:12px",
    "z-index:2147483647",
    "width:30px",
    "height:30px",
    "display:grid",
    "place-items:center",
    "border-radius:999px",
    "cursor:pointer",
    "background:rgba(20,20,23,.92)",
    "color:#fff",
    "box-shadow:0 4px 16px rgba(0,0,0,.35)",
  ].join(";");
  if (scenario !== "nominal" || getRole() !== "owner") {
    const dot = document.createElement("span");
    dot.style.cssText =
      "position:absolute;top:1px;right:1px;width:8px;height:8px;border-radius:999px;background:#f59e0b;border:2px solid rgba(20,20,23,1)";
    chip.append(dot);
  }
  return chip;
}

function buildPanel(): HTMLDivElement {
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
  const labRow = row(
    "LAB",
    SCENARIOS.map((value) => pill(LABELS[value], value === scenario, () => setScenario(value))),
  );
  const collapse = document.createElement("button");
  collapse.type = "button";
  collapse.setAttribute("data-lab-collapse", "");
  collapse.setAttribute("aria-label", "Réduire le panneau lab");
  collapse.title = "Réduire";
  collapse.textContent = "×";
  collapse.style.cssText =
    "all:unset;cursor:pointer;margin-left:auto;padding:0 6px;font-size:15px;line-height:1;color:rgba(255,255,255,.55)";
  labRow.append(collapse);
  host.append(labRow);

  // Second row: WHO is looking. Flipping it reloads with a weaker permission
  // set, so a gate that never hides anything shows up here immediately.
  const role = getRole();
  host.append(
    row(
      "ORG",
      LAB_ROLES.map((value) => pill(ROLE_LABELS[value], value === role, () => setRole(value))),
    ),
  );

  // Owner and Admin are `admin` in every space: the row shows it and stays
  // inert, rather than offering a combination the server never produces.
  const preset = effectivePreset();
  const locked = hasFullSpaceAccess();
  const presetRow = row(
    "ESPACE",
    LAB_PRESETS.map((value) =>
      pill(PRESET_LABELS[value], value === preset, () => setPreset(value), locked),
    ),
  );
  if (locked) presetRow.title = "Owner et Admin sont admin dans tous les espaces";
  host.append(presetRow);
  return host;
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

function pill(
  text: string,
  active: boolean,
  onClick: () => void,
  disabled = false,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.disabled = disabled;
  if (!disabled) button.addEventListener("click", onClick);
  style(button, active, disabled);
  return button;
}

function style(button: HTMLButtonElement, active: boolean, disabled: boolean): void {
  button.style.cssText = [
    "all:unset",
    disabled ? "cursor:default" : "cursor:pointer",
    disabled ? "opacity:.4" : "opacity:1",
    "padding:4px 8px",
    "border-radius:6px",
    `background:${active ? "#fff" : "transparent"}`,
    `color:${active ? "#141417" : "rgba(255,255,255,.7)"}`,
    active ? "font-weight:600" : "font-weight:400",
  ].join(";");
}
