#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

import { capturePortableBrowserState } from "./browser-state.ts";
import { launchLocalChrome, openExternal } from "./chrome.ts";
import { startControlServer } from "./control-server.ts";
import {
  parseCompanionCapability,
  readCompanionContext,
  reportCompanionFailure,
  submitBrowserState,
  type CompanionFailureReason,
} from "./protocol.ts";

class LocalAcquisitionError extends Error {
  constructor(
    message: string,
    readonly reason: CompanionFailureReason,
  ) {
    super(message);
    this.name = "LocalAcquisitionError";
  }
}

export async function waitForLocalLogin(input: {
  completed: Promise<void>;
  chromeExited: Promise<number>;
  expiresAt: string;
}): Promise<void> {
  const remainingMs = Date.parse(input.expiresAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new LocalAcquisitionError("Companion attempt expired", "timeout");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new LocalAcquisitionError("Companion attempt expired", "timeout")),
      Math.min(remainingMs, 2_147_483_647),
    );
  });
  try {
    await Promise.race([
      input.completed,
      input.chromeExited.then(() => {
        throw new LocalAcquisitionError(
          "Chrome was closed before the login was confirmed",
          "closed",
        );
      }),
      expired,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForCompletion(
  capability: ReturnType<typeof parseCompanionCapability>,
): Promise<void> {
  let openedInteraction: string | null = null;
  for (;;) {
    const context = await readCompanionContext(capability);
    if (context.status === "complete") return;
    if (context.status === "failed") {
      throw new Error(context.error_code ?? "The target browser rejected the transferred session");
    }
    if (context.status === "interaction_required" && context.interaction_url) {
      if (openedInteraction !== context.interaction_url) {
        openedInteraction = context.interaction_url;
        openExternal(context.interaction_url);
      }
    }
    if (Date.parse(context.expires_at) <= Date.now()) throw new Error("Companion attempt expired");
    await Bun.sleep(1_000);
  }
}

export async function runCompanion(rawCapability: string): Promise<void> {
  const capability = parseCompanionCapability(rawCapability);
  const context = await readCompanionContext(capability);
  if (context.status === "complete") return;
  if (context.status === "failed") {
    throw new Error(context.error_code ?? "The target browser rejected the transferred session");
  }
  // A duplicate URL may arrive after the first worker already handed off the
  // session. Do not open a second local login; simply resume durable polling.
  if (
    context.status === "state_received" ||
    context.status === "provisioning" ||
    context.status === "interaction_required"
  ) {
    await waitForCompletion(capability);
    return;
  }
  const control = startControlServer(context.display_name);
  let chrome: Awaited<ReturnType<typeof launchLocalChrome>>;
  try {
    chrome = await launchLocalChrome([context.start_url, control.url]);
  } catch (error) {
    control.stop();
    await reportCompanionFailure(capability, "failed").catch(() => undefined);
    throw error;
  }
  // The native URL handler replaces an obsolete attempt by sending SIGTERM to
  // this worker. Bun does not unwind `finally` on an unhandled signal, so own
  // that signal explicitly and remove the isolated Chrome profile before exit.
  let superseded = false;
  const terminateGracefully = () => {
    superseded = true;
    control.stop();
    void chrome.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", terminateGracefully);
  let handoffAccepted = false;
  try {
    console.info(`Connexion ${context.display_name} ouverte dans Chrome.`);
    await waitForLocalLogin({
      completed: control.completed,
      chromeExited: chrome.exited,
      expiresAt: context.expires_at,
    });
    console.info("Vérification et transfert sécurisé de la session…");
    const state = await capturePortableBrowserState(
      chrome.debuggingOrigin,
      context.allowed_origins,
    );
    await submitBrowserState(capability, state);
    handoffAccepted = true;
    await waitForCompletion(capability);
    console.info("Connexion Appstrate terminée.");
  } catch (error) {
    if (!handoffAccepted && !superseded) {
      const reason = error instanceof LocalAcquisitionError ? error.reason : "failed";
      await reportCompanionFailure(capability, reason).catch(() => undefined);
    }
    throw error;
  } finally {
    process.off("SIGTERM", terminateGracefully);
    control.stop();
    await chrome.close();
  }
}

if (import.meta.main) {
  const argument = process.argv[2];
  const raw = argument === "--capability-stdin" ? (await Bun.stdin.text()).trim() : argument;
  if (!raw) {
    console.error(
      "Usage: appstrate-browser 'appstrate-browser://connect?...' | --capability-stdin",
    );
    process.exitCode = 2;
  } else {
    await runCompanion(raw).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
