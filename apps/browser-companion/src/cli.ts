#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

import { capturePortableBrowserState } from "./browser-state.ts";
import { launchLocalChrome, openExternal } from "./chrome.ts";
import { startControlServer } from "./control-server.ts";
import { parseCompanionCapability, readCompanionContext, submitBrowserState } from "./protocol.ts";

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
  const control = startControlServer(context.display_name);
  const chrome = await launchLocalChrome([context.start_url, control.url]);
  try {
    console.info(`Connexion ${context.display_name} ouverte dans Chrome.`);
    await control.completed;
    console.info("Vérification et transfert sécurisé de la session…");
    const state = await capturePortableBrowserState(
      chrome.debuggingOrigin,
      context.allowed_origins,
    );
    await submitBrowserState(capability, state);
    await waitForCompletion(capability);
    console.info("Connexion Appstrate terminée.");
  } finally {
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
