// SPDX-License-Identifier: Apache-2.0

import { chromium } from "@playwright/test";

const endpoint = process.env.APPSTRATE_BROWSER_ENDPOINT ?? "http://127.0.0.1:18090";
const token = process.env.APPSTRATE_BROWSER_TOKEN ?? "";
const headers = { Authorization: `Bearer ${token}` };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const unauthorized = await fetch(`${endpoint}/health`);
assert(unauthorized.status === 401, `unauthenticated health returned ${unauthorized.status}`);

const contextResponse = await fetch(`${endpoint}/v1/context`, { method: "POST", headers });
assert(contextResponse.status === 200, `context activation returned ${contextResponse.status}`);
const activation = await contextResponse.json();
assert(activation.defaultContext === true, "worker did not activate its default context");

const mutation = await fetch(`${endpoint}/json/new`, { method: "PUT", headers });
assert(mutation.status === 403, `DevTools HTTP mutation returned ${mutation.status}`);

const browser = await chromium.connectOverCDP(endpoint, { headers });
const contexts = browser.contexts();
assert(contexts.length === 1, `expected one Playwright context, received ${contexts.length}`);

let nestedProtocolDenied = false;
try {
  await browser.newBrowserCDPSession();
} catch (error) {
  nestedProtocolDenied = /nested DevTools protocol channels are forbidden/i.test(
    error instanceof Error ? error.message : String(error),
  );
}
assert(nestedProtocolDenied, "a nested browser CDP session bypassed the worker broker");

const pages = [];
for (let index = 0; index < 4; index += 1) pages.push(await contexts[0].newPage());
let ceilingDenied = false;
try {
  await contexts[0].newPage();
} catch (error) {
  ceilingDenied = /page limit reached/i.test(
    error instanceof Error ? error.message : String(error),
  );
}
assert(ceilingDenied, "the fifth Playwright page bypassed the worker ceiling");

for (const page of pages) await page.close();
const deletion = await fetch(`${endpoint}/v1/context`, { method: "DELETE", headers });
assert(deletion.status === 200, `context cleanup returned ${deletion.status}`);
const staleState = await fetch(`${endpoint}/v1/context/state`, { headers });
assert(staleState.status === 409, `inactive context state returned ${staleState.status}`);
const reactivation = await fetch(`${endpoint}/v1/context`, { method: "POST", headers });
assert(reactivation.status === 410, `retired context reactivation returned ${reactivation.status}`);

process.stdout.write("BROWSER_WORKER_PLAYWRIGHT_SMOKE_OK\n");
process.exit(0);
