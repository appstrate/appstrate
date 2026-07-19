// SPDX-License-Identifier: Apache-2.0

/**
 * First-party Leboncoin browser driver.
 *
 * The package is dependency-free because MCP runner images contain only the
 * selected runtime and the extracted AFPS bundle. It speaks MCP over
 * line-delimited JSON-RPC and CDP directly over the browser worker's guarded
 * WebSocket endpoint.
 *
 * Security properties:
 * - `acquire_session` is hidden by both the integration manifest and the
 *   platform's private-connect-tool policy.
 * - Email/password arrive only in the private sidecar-to-driver call after an
 *   exact system-package grant has been authorized.
 * - Credentials and cookie values are never logged or returned by public
 *   tools. Only the declared `cookie_header` acquisition output leaves the
 *   driver, through the platform's encrypted credential path.
 * - Navigation is constructed from fixed Leboncoin origins. `get_listing`
 *   validates its URL before CDP sees it.
 * - DataDome/CAPTCHA pages are detected and reported; the driver never tries
 *   to solve or bypass them.
 */

const SERVER_INFO = { name: "appstrate-leboncoin-browser", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";
const LOGIN_COOKIE = "__Secure-login";
const LEBONCOIN_ORIGIN = "https://www.leboncoin.fr";
const LOGIN_TIMEOUT_MS = 45_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_COOKIE_HEADER_BYTES = 64 * 1024;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface BrowserCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
}

export interface PageSnapshot {
  url: string;
  title: string;
  bodyText: string;
  frameUrls: string[];
  readyState: string;
}

interface CdpResponse {
  id?: number;
  sessionId?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
  params?: unknown;
}

interface PendingCdpCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface BrowserConfiguration {
  endpoint: string;
  token: string;
}

interface AcquisitionArgs {
  browser_endpoint?: unknown;
  browser_token?: unknown;
  inputs?: unknown;
  allowed_origins?: unknown;
  session_mode?: unknown;
}

interface SearchArgs {
  query?: unknown;
  limit?: unknown;
}

interface ListingArgs {
  url?: unknown;
}

export const TOOLS = [
  {
    name: "acquire_session",
    description:
      "Private Appstrate connect hook. Signs in through the isolated browser and returns a " +
      "proven exportable cookie session. Never exposed to the agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["browser_endpoint", "browser_token", "inputs", "allowed_origins", "session_mode"],
      properties: {
        browser_endpoint: { type: "string" },
        browser_token: { type: "string" },
        inputs: {
          type: "object",
          additionalProperties: { type: "string" },
          required: ["email", "password"],
        },
        allowed_origins: { type: "array", items: { type: "string" } },
        session_mode: { const: "exportable" },
      },
    },
  },
  {
    name: "search_listings",
    description:
      "Search Leboncoin in the authenticated isolated browser. Returns at most 20 visible " +
      "listing summaries and never mutates the account.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 120 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
    },
  },
  {
    name: "get_listing",
    description:
      "Open one canonical https://www.leboncoin.fr/ad/... URL and return bounded visible " +
      "details. Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", format: "uri" },
      },
    },
  },
  {
    name: "session_status",
    description:
      "Report whether the browser has an authenticated Leboncoin cookie. Cookie values are " +
      "never returned.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
] as const;

class ProtocolError extends Error {}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new ProtocolError(`${field} must be a non-empty string of at most ${maxLength} chars`);
  }
  return value;
}

function canonicalBrowserEndpoint(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ProtocolError("browser_endpoint must be a valid URL");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.origin !== raw ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ProtocolError("browser_endpoint must be an HTTP origin");
  }
  return parsed.origin;
}

export function normalizeListingUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ProtocolError("url must be a valid Leboncoin listing URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "www.leboncoin.fr" ||
    !parsed.pathname.startsWith("/ad/") ||
    parsed.username ||
    parsed.password
  ) {
    throw new ProtocolError("url must use https://www.leboncoin.fr/ad/...");
  }
  parsed.hash = "";
  return parsed.toString();
}

function isLeboncoinCookie(
  cookie: BrowserCookie,
): cookie is BrowserCookie & { name: string; value: string; domain: string } {
  if (
    typeof cookie.name !== "string" ||
    typeof cookie.value !== "string" ||
    typeof cookie.domain !== "string"
  ) {
    return false;
  }
  const domain = cookie.domain.replace(/^\./, "").toLowerCase();
  return (
    (domain === "leboncoin.fr" || domain.endsWith(".leboncoin.fr")) &&
    cookie.name.length > 0 &&
    cookie.name.length <= 256 &&
    cookie.value.length > 0 &&
    !/[;\r\n]/.test(cookie.name) &&
    !/[;\r\n]/.test(cookie.value)
  );
}

export function buildLeboncoinCookieHeader(cookies: readonly BrowserCookie[]): string {
  const byName = new Map<string, { value: string; score: number }>();
  for (const cookie of cookies.slice(0, 256)) {
    if (!isLeboncoinCookie(cookie)) continue;
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    const path = typeof cookie.path === "string" ? cookie.path : "/";
    const score = (domain === "www.leboncoin.fr" ? 10_000 : 0) + path.length;
    const previous = byName.get(cookie.name);
    if (!previous || score >= previous.score) {
      byName.set(cookie.name, { value: cookie.value, score });
    }
  }
  const header = [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, item]) => `${name}=${item.value}`)
    .join("; ");
  if (Buffer.byteLength(header) > MAX_COOKIE_HEADER_BYTES) {
    throw new Error("BROWSER_RESOURCE_LIMIT: exported Leboncoin cookie header is too large");
  }
  return header;
}

export function hasLeboncoinSession(cookies: readonly BrowserCookie[]): boolean {
  return cookies.some(
    (cookie) =>
      isLeboncoinCookie(cookie) && cookie.name === LOGIN_COOKIE && cookie.value.length > 0,
  );
}

export function detectDataDomeChallenge(
  snapshot: Pick<PageSnapshot, "url" | "title" | "bodyText" | "frameUrls">,
): boolean {
  const dataDomeHosts = new Set([
    "ct.captcha-delivery.com",
    "geo.captcha-delivery.com",
    "static.captcha-delivery.com",
  ]);
  const hasDataDomeUrl = [snapshot.url, ...snapshot.frameUrls].some((raw) => {
    try {
      return dataDomeHosts.has(new URL(raw).hostname.toLowerCase());
    } catch {
      return false;
    }
  });
  const visibleText = [snapshot.title, snapshot.bodyText].join("\n").toLowerCase();
  return (
    hasDataDomeUrl ||
    visibleText.includes("datadome") ||
    visibleText.includes("pardon the interruption") ||
    visibleText.includes("verify you are human") ||
    visibleText.includes("vérifiez que vous êtes humain") ||
    visibleText.includes("confirmez que vous n'êtes pas un robot")
  );
}

export function detectRejectedCredentials(bodyText: string): boolean {
  const text = bodyText.toLowerCase();
  return [
    "adresse email ou mot de passe incorrect",
    "email ou mot de passe incorrect",
    "mot de passe incorrect",
    "identifiants incorrects",
    "incorrect password",
  ].some((candidate) => text.includes(candidate));
}

class CdpConnection {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCdpCall>();

  constructor(private readonly config: BrowserConfiguration) {}

  async connect(): Promise<void> {
    const response = await fetch(`${this.config.endpoint}/json/version`, {
      headers: { Authorization: `Bearer ${this.config.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`BROWSER_UNAVAILABLE: browser discovery returned ${response.status}`);
    }
    const version = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    if (typeof version.webSocketDebuggerUrl !== "string") {
      throw new Error("BROWSER_UNAVAILABLE: browser discovery omitted its WebSocket endpoint");
    }

    const HeaderWebSocket = WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string> },
    ) => WebSocket;
    const socket = new HeaderWebSocket(version.webSocketDebuggerUrl, {
      headers: { Authorization: `Bearer ${this.config.token}` },
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("BROWSER_UNAVAILABLE: CDP WebSocket connection timed out")),
        5_000,
      );
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("BROWSER_UNAVAILABLE: CDP WebSocket connection failed"));
      };
    });
    socket.onmessage = (event) => this.onMessage(String(event.data));
    socket.onclose = () => this.failPending("BROWSER_CRASHED: CDP WebSocket closed");
    socket.onerror = () => this.failPending("BROWSER_CRASHED: CDP WebSocket failed");
    this.socket = socket;
  }

  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("BROWSER_UNAVAILABLE: CDP connection is not open");
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`BROWSER_NAVIGATION_TIMEOUT: CDP ${method} timed out`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(payload);
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.failPending("BROWSER_CRASHED: CDP connection closed");
  }

  private onMessage(raw: string): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(raw) as CdpResponse;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new Error(`BROWSER_UNAVAILABLE: CDP command rejected (${message.error.code ?? "unknown"})`),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private failPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}

class LeboncoinBrowserDriver {
  private configuration: BrowserConfiguration | null = null;
  private cdp: CdpConnection | null = null;
  private targetId: string | null = null;
  private sessionId: string | null = null;

  configure(config: BrowserConfiguration): void {
    if (
      this.configuration?.endpoint === config.endpoint &&
      this.configuration.token === config.token
    ) {
      return;
    }
    this.close();
    this.configuration = config;
  }

  async acquire(email: string, password: string): Promise<Record<string, unknown>> {
    await this.ensurePage();
    const authorize = new URL("https://auth.leboncoin.fr/api/authorizer/v2/authorize");
    authorize.searchParams.set("client_id", "lbc-front-web");
    authorize.searchParams.set("redirect_uri", "https://www.leboncoin.fr/oauth2callback");
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "* offline");
    authorize.searchParams.set("state", crypto.randomUUID());

    let snapshot = await this.navigate(authorize.toString(), LOGIN_TIMEOUT_MS);
    this.assertNoChallenge(snapshot);

    const emailSelectors = [
      "input[type=email]",
      "input[name=email]",
      "input[autocomplete=username]",
    ];
    const passwordSelectors = [
      "input[type=password]",
      "input[name=password]",
      "input[autocomplete=current-password]",
    ];

    if (!(await this.waitForVisible(emailSelectors, 15_000))) {
      throw new Error("BROWSER_AUTH_REQUIRED: Leboncoin email field was not found");
    }
    const passwordAlreadyVisible = await this.isAnyVisible(passwordSelectors);
    await this.fillFirst(emailSelectors, email, !passwordAlreadyVisible);

    if (!passwordAlreadyVisible && !(await this.waitForVisible(passwordSelectors, 20_000))) {
      snapshot = await this.snapshot();
      this.assertNoChallenge(snapshot);
      throw new Error("BROWSER_AUTH_REQUIRED: Leboncoin password step was not reached");
    }

    await this.fillFirst(passwordSelectors, password, true);
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const cookies = await this.cookies();
      if (hasLeboncoinSession(cookies)) {
        const cookieHeader = buildLeboncoinCookieHeader(cookies);
        if (!cookieHeader) {
          throw new Error("BROWSER_AUTH_REQUIRED: Leboncoin session could not be exported");
        }
        return {
          outputs: { cookie_header: cookieHeader },
          proof: { kind: "leboncoin-browser-session", succeeded: true },
          identity_claims: { email },
          scopes_granted: ["read:listings"],
          expires_at: null,
        };
      }
      snapshot = await this.snapshot();
      this.assertNoChallenge(snapshot);
      if (detectRejectedCredentials(snapshot.bodyText)) {
        throw new Error("BROWSER_AUTH_REQUIRED: Leboncoin rejected the credentials");
      }
      await delay(500);
    }
    throw new Error("BROWSER_NAVIGATION_TIMEOUT: Leboncoin login did not complete");
  }

  async search(query: string, limit: number): Promise<Record<string, unknown>> {
    await this.ensurePage();
    const url = new URL("/recherche", LEBONCOIN_ORIGIN);
    url.searchParams.set("text", query);
    const snapshot = await this.navigate(url.toString(), NAVIGATION_TIMEOUT_MS);
    this.assertNoChallenge(snapshot);
    const listings = await this.evaluate<
      Array<{ url: string; title: string; price?: string; summary: string; image?: string }>
    >(`(() => {
      const seen = new Set();
      const out = [];
      for (const anchor of document.querySelectorAll('a[href*="/ad/"]')) {
        const href = anchor.href;
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const card = anchor.closest('article, li, [data-test-id], [class*="adcard"]') || anchor;
        const lines = (card.innerText || anchor.innerText || '').split('\\n')
          .map((line) => line.trim()).filter(Boolean);
        const title = (anchor.getAttribute('title') || lines[0] || '').trim();
        if (!title) continue;
        const price = lines.find((line) => /\\d[\\d . ]*\\s*€/.test(line));
        const image = card.querySelector('img');
        out.push({
          url: href,
          title: title.slice(0, 300),
          ...(price ? { price: price.slice(0, 80) } : {}),
          summary: lines.slice(0, 8).join(' · ').slice(0, 1000),
          ...(image && image.currentSrc ? { image: image.currentSrc } : {}),
        });
        if (out.length >= ${limit}) break;
      }
      return out;
    })()`);
    return { query, url: snapshot.url, count: listings.length, listings };
  }

  async getListing(url: string): Promise<Record<string, unknown>> {
    await this.ensurePage();
    const snapshot = await this.navigate(url, NAVIGATION_TIMEOUT_MS);
    this.assertNoChallenge(snapshot);
    return this.evaluate<Record<string, unknown>>(`(() => {
      const text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
      const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
      const h1 = document.querySelector('h1')?.textContent?.trim() || document.title;
      const price = [...document.querySelectorAll('body *')]
        .map((node) => node.children.length === 0 ? (node.textContent || '').trim() : '')
        .find((value) => /^\\d[\\d . ]*\\s*€$/.test(value));
      const images = [...document.querySelectorAll('img')]
        .map((image) => image.currentSrc || image.src).filter(Boolean).slice(0, 12);
      return {
        url: location.href,
        canonical_url: canonical,
        title: h1.slice(0, 500),
        ...(price ? { price: price.slice(0, 80) } : {}),
        visible_text: text.slice(0, 12000),
        images,
      };
    })()`);
  }

  async sessionStatus(): Promise<Record<string, unknown>> {
    await this.ensurePage();
    const cookies = await this.cookies();
    const cookieNames = cookies
      .filter(isLeboncoinCookie)
      .map((cookie) => cookie.name)
      .filter((name, index, all) => all.indexOf(name) === index)
      .sort();
    return {
      authenticated: hasLeboncoinSession(cookies),
      cookie_names: cookieNames,
      current_url: (await this.snapshot()).url,
    };
  }

  close(): void {
    this.cdp?.close();
    this.cdp = null;
    this.targetId = null;
    this.sessionId = null;
  }

  private async ensurePage(): Promise<void> {
    if (this.cdp && this.targetId && this.sessionId) return;
    const config = this.configuration;
    if (!config) throw new Error("BROWSER_UNAVAILABLE: browser driver is not configured");

    const contextResponse = await fetch(`${config.endpoint}/v1/context`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!contextResponse.ok && contextResponse.status !== 409) {
      throw new Error(
        `BROWSER_UNAVAILABLE: browser context creation returned ${contextResponse.status}`,
      );
    }

    const cdp = new CdpConnection(config);
    await cdp.connect();
    const created = await cdp.call<{ targetId?: string }>("Target.createTarget", {
      url: "about:blank",
    });
    if (!created.targetId) throw new Error("BROWSER_UNAVAILABLE: browser page was not created");
    const attached = await cdp.call<{ sessionId?: string }>("Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true,
    });
    if (!attached.sessionId) {
      throw new Error("BROWSER_UNAVAILABLE: browser page attachment failed");
    }
    this.cdp = cdp;
    this.targetId = created.targetId;
    this.sessionId = attached.sessionId;
    await Promise.all([
      cdp.call("Page.enable", {}, attached.sessionId),
      cdp.call("Runtime.enable", {}, attached.sessionId),
    ]);
  }

  private async navigate(url: string, timeoutMs: number): Promise<PageSnapshot> {
    const result = await this.callPage<{ errorText?: string }>("Page.navigate", { url });
    if (result.errorText) {
      throw new Error("BROWSER_UNAVAILABLE: Leboncoin navigation was rejected");
    }
    const deadline = Date.now() + timeoutMs;
    let latest = await this.snapshot();
    while (Date.now() < deadline) {
      latest = await this.snapshot();
      if (latest.readyState === "interactive" || latest.readyState === "complete") return latest;
      await delay(150);
    }
    throw new Error("BROWSER_NAVIGATION_TIMEOUT: Leboncoin page did not become ready");
  }

  private async snapshot(): Promise<PageSnapshot> {
    return this.evaluate<PageSnapshot>(`(() => ({
      url: location.href,
      title: document.title || '',
      bodyText: (document.body?.innerText || '').slice(0, 20000),
      frameUrls: [...document.querySelectorAll('iframe')]
        .map((frame) => frame.src).filter(Boolean).slice(0, 20),
      readyState: document.readyState,
    }))()`);
  }

  private async cookies(): Promise<BrowserCookie[]> {
    const config = this.configuration;
    if (!config) throw new Error("BROWSER_UNAVAILABLE: browser driver is not configured");
    const response = await fetch(`${config.endpoint}/v1/context/state`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`BROWSER_UNAVAILABLE: browser state returned ${response.status}`);
    }
    const state = (await response.json()) as { cookies?: unknown };
    return Array.isArray(state.cookies) ? (state.cookies as BrowserCookie[]) : [];
  }

  private assertNoChallenge(snapshot: PageSnapshot): void {
    if (detectDataDomeChallenge(snapshot)) {
      throw new Error("BROWSER_INTERACTION_REQUIRED: Leboncoin presented a DataDome challenge");
    }
  }

  private async isAnyVisible(selectors: readonly string[]): Promise<boolean> {
    return this.evaluate<boolean>(`(() => {
      const selectors = ${JSON.stringify(selectors)};
      return selectors.some((selector) => [...document.querySelectorAll(selector)]
        .some((element) => element.getClientRects().length > 0 && !element.disabled));
    })()`);
  }

  private async waitForVisible(selectors: readonly string[], timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isAnyVisible(selectors)) return true;
      const snapshot = await this.snapshot();
      this.assertNoChallenge(snapshot);
      await delay(200);
    }
    return false;
  }

  private async fillFirst(
    selectors: readonly string[],
    value: string,
    submit: boolean,
  ): Promise<void> {
    const filled = await this.evaluate<boolean>(`(() => {
      const selectors = ${JSON.stringify(selectors)};
      const value = ${JSON.stringify(value)};
      const element = selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
        .find((candidate) => candidate.getClientRects().length > 0 && !candidate.disabled);
      if (!(element instanceof HTMLInputElement)) return false;
      element.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(element, value); else element.value = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      if (${submit ? "true" : "false"}) {
        const form = element.form;
        const button = form?.querySelector('button[type="submit"], input[type="submit"]') ||
          [...document.querySelectorAll('button')].find((candidate) =>
            /continuer|connexion|se connecter|valider/i.test(candidate.textContent || ''));
        if (button instanceof HTMLElement && !button.hasAttribute('disabled')) button.click();
        else if (form) form.requestSubmit();
        else element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      return true;
    })()`);
    if (!filled) throw new Error("BROWSER_AUTH_REQUIRED: Leboncoin login field disappeared");
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const response = await this.callPage<{
      result?: { value?: T; subtype?: string; description?: string };
      exceptionDetails?: unknown;
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error("BROWSER_UNAVAILABLE: page evaluation failed");
    }
    return response.result?.value as T;
  }

  private async callPage<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.cdp || !this.sessionId) {
      throw new Error("BROWSER_UNAVAILABLE: browser page is not attached");
    }
    return this.cdp.call<T>(method, params, this.sessionId);
  }
}

const defaultDriver = new LeboncoinBrowserDriver();
let callQueue: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = callQueue.then(operation, operation);
  callQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function configureFromEnv(driver: LeboncoinBrowserDriver, env: NodeJS.ProcessEnv): void {
  const endpoint = canonicalBrowserEndpoint(
    requiredString(env.APPSTRATE_BROWSER_ENDPOINT, "APPSTRATE_BROWSER_ENDPOINT", 2048),
  );
  const token = requiredString(env.APPSTRATE_BROWSER_TOKEN, "APPSTRATE_BROWSER_TOKEN", 4096);
  if (Buffer.byteLength(token) < 32) {
    throw new ProtocolError("APPSTRATE_BROWSER_TOKEN is invalid");
  }
  driver.configure({ endpoint, token });
}

function parseAcquisitionArgs(args: AcquisitionArgs): {
  config: BrowserConfiguration;
  email: string;
  password: string;
} {
  if (args.session_mode !== "exportable") {
    throw new ProtocolError("session_mode must be exportable");
  }
  if (!Array.isArray(args.allowed_origins) || args.allowed_origins.length === 0) {
    throw new ProtocolError("allowed_origins must be a non-empty array");
  }
  const origins = new Set(
    args.allowed_origins.filter((value): value is string => typeof value === "string"),
  );
  for (const required of [LEBONCOIN_ORIGIN, "https://auth.leboncoin.fr"]) {
    if (!origins.has(required)) throw new ProtocolError(`allowed_origins omits ${required}`);
  }
  const inputs = asObject(args.inputs);
  if (!inputs) throw new ProtocolError("inputs must be an object");
  const endpoint = canonicalBrowserEndpoint(
    requiredString(args.browser_endpoint, "browser_endpoint", 2048),
  );
  const token = requiredString(args.browser_token, "browser_token", 4096);
  if (Buffer.byteLength(token) < 32) throw new ProtocolError("browser_token is invalid");
  const email = requiredString(inputs.email, "inputs.email", 320);
  const password = requiredString(inputs.password, "inputs.password", 4096);
  return { config: { endpoint, token }, email, password };
}

interface HandleRequestDeps {
  driver?: LeboncoinBrowserDriver;
  env?: NodeJS.ProcessEnv;
}

export async function handleRequest(
  request: JsonRpcRequest,
  deps: HandleRequestDeps = {},
): Promise<JsonRpcResponse | null> {
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }
  if (request.method === "tools/list") {
    return { jsonrpc: "2.0", id: request.id ?? null, result: { tools: TOOLS } };
  }
  if (request.method === "ping") {
    return { jsonrpc: "2.0", id: request.id ?? null, result: {} };
  }
  if (request.method !== "tools/call") {
    if (request.id === undefined || request.id === null) return null;
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    };
  }

  const params = asObject(request.params) ?? {};
  const name = typeof params.name === "string" ? params.name : "";
  const args = asObject(params.arguments) ?? {};
  const driver = deps.driver ?? defaultDriver;
  try {
    let output: unknown;
    switch (name) {
      case "acquire_session": {
        const parsed = parseAcquisitionArgs(args as AcquisitionArgs);
        driver.configure(parsed.config);
        output = await serialize(() => driver.acquire(parsed.email, parsed.password));
        break;
      }
      case "search_listings": {
        const query = requiredString((args as SearchArgs).query, "query", 120).trim();
        if (!query) throw new ProtocolError("query must not be blank");
        const rawLimit = (args as SearchArgs).limit ?? 10;
        if (!Number.isInteger(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 20) {
          throw new ProtocolError("limit must be an integer from 1 to 20");
        }
        configureFromEnv(driver, deps.env ?? process.env);
        output = await serialize(() => driver.search(query, Number(rawLimit)));
        break;
      }
      case "get_listing": {
        const url = normalizeListingUrl(requiredString((args as ListingArgs).url, "url", 2048));
        configureFromEnv(driver, deps.env ?? process.env);
        output = await serialize(() => driver.getListing(url));
        break;
      }
      case "session_status": {
        configureFromEnv(driver, deps.env ?? process.env);
        output = await serialize(() => driver.sessionStatus());
        break;
      }
      default:
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: -32602, message: `Unknown tool: ${name || "<unset>"}` },
        };
    }
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: { content: [{ type: "text", text: JSON.stringify(output) }] },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ProtocolError) {
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32602, message },
      };
    }
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: { isError: true, content: [{ type: "text", text: message }] },
    };
  }
}

async function main(): Promise<void> {
  let buffer = "";
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        continue;
      }
      const response = await handleRequest(request);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

if ((import.meta as unknown as { main?: boolean }).main === true) {
  main()
    .catch((error) => {
      process.stderr.write(
        `[leboncoin-browser] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    })
    .finally(() => defaultDriver.close());
}
