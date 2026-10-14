// SPDX-License-Identifier: Apache-2.0

/**
 * Which slice of fake data lab mode serves. The point of the lab is not to
 * look at one happy screen — it is to flip the same screen through the states
 * that actually break a design.
 */
export const SCENARIOS = ["nominal", "empty", "heavy", "error"] as const;
export type Scenario = (typeof SCENARIOS)[number];

const STORAGE_KEY = "appstrate-lab-scenario";

export function getScenario(): Scenario {
  const stored = localStorage.getItem(STORAGE_KEY);
  return (SCENARIOS as readonly string[]).includes(stored ?? "") ? (stored as Scenario) : "nominal";
}

/** Full reload on purpose: it clears the React Query cache in one step. */
export function setScenario(next: Scenario): void {
  localStorage.setItem(STORAGE_KEY, next);
  // "Vide" lands on onboarding because it removes the orgs. Leaving it must
  // leave onboarding too: reloading in place would keep walking its steps
  // with the orgs back.
  if (next !== "empty" && window.location.pathname.startsWith("/onboarding")) {
    window.location.assign("/");
    return;
  }
  window.location.reload();
}
