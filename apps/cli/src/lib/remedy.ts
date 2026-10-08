// SPDX-License-Identifier: Apache-2.0

/** Commands the CLI tells the user, or Claude, to run: none prompts, since Claude has no TTY. */

import { shellArg } from "./shell.ts";

export interface Actionable {
  problem: string;
  remedy: string;
}

/** An error one command fixes when it carries `fix`; `code sync` also tells the next session. */
export class ActionableError extends Error {
  readonly fix?: Actionable;

  constructor(cause: string | Actionable) {
    super(typeof cause === "string" ? cause : remedyLine(cause));
    if (typeof cause !== "string") this.fix = cause;
    this.name = "ActionableError";
  }
}

export function remedyLine({ problem, remedy }: Actionable): string {
  return `${problem}. Run: ${remedy}`;
}

/** `login` prompts for the instance unless `--instance` names it. */
export function loginRemedy(profileName: string, instance?: string): string {
  const target = instance ? shellArg(instance) : "<url>";
  return `appstrate login --profile ${shellArg(profileName)} --instance ${target}`;
}

export function loginFix(problem: string, profileName: string, instance?: string): Actionable {
  return { problem, remedy: loginRemedy(profileName, instance) };
}

export function profileMissing(profileName: string): Actionable {
  return loginFix(`Profile "${profileName}" not configured`, profileName);
}

const PICKERS = {
  org: "appstrate org switch <org-id-or-slug>",
  space: "appstrate space switch <space-id>",
};

/** `switch` opens a picker unless given a ref; `--profile` keeps Claude off the active profile. */
export function switchFix(
  problem: string,
  pin: keyof typeof PICKERS,
  profileName: string,
): Actionable {
  return { problem, remedy: `${PICKERS[pin]} --profile ${shellArg(profileName)}` };
}

export function pinMissing(pin: keyof typeof PICKERS, profileName: string): Actionable {
  return switchFix(`No ${pin === "org" ? "organization" : "space"} pinned`, pin, profileName);
}

export function logoutRetry(profileName: string): string {
  return `Retry appstrate logout --profile ${shellArg(profileName)}.`;
}
