import { computeIntegrity } from "@appstrate/core/integrity";
import type {
  RegistryConfig,
  RegistryDiscovery,
  RegistrySearchResult,
  RegistrySearchOptions,
  RegistryPackageDetail,
  RegistryAccount,
  RegistryScope,
  PublishResult,
} from "./types.ts";

export class RegistryClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "RegistryClientError";
  }
}

const DEFAULT_TIMEOUT = 30_000;
const DOWNLOAD_TIMEOUT = 120_000;
const DEFAULT_MAX_RETRIES = 2;

export class RegistryClient {
  private baseUrl: string;
  private accessToken?: string;
  private timeout: number;
  private downloadTimeout: number;
  private maxRetries: number;
  private logger?: RegistryConfig["logger"];

  constructor(config: RegistryConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.accessToken = config.accessToken;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.downloadTimeout = config.timeout ?? DOWNLOAD_TIMEOUT;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.logger = config.logger;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }
    return headers;
  }

  private async handleErrorResponse(
    res: Response,
    defaultCode: string,
    defaultMessage: string,
  ): Promise<never> {
    let body: { error?: string; message?: string } = {};
    try {
      body = (await res.json()) as { error?: string; message?: string };
    } catch {
      // ignore JSON parse errors
    }
    throw new RegistryClientError(
      res.status,
      body.error ?? defaultCode,
      body.message ?? defaultMessage,
    );
  }

  private isRetryable(error: unknown, status?: number): boolean {
    // Retry on network errors (TypeError from fetch)
    if (error instanceof TypeError) return true;
    // Retry on 5xx server errors
    if (status && status >= 500) return true;
    return false;
  }

  private async request<T>(
    path: string,
    options?: RequestInit & { timeoutMs?: number },
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = options?.timeoutMs ?? this.timeout;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            ...this.headers(),
            ...options?.headers,
          },
        });

        this.logger?.debug("registry request", {
          method: options?.method ?? "GET",
          url,
          status: res.status,
          attempt,
        });

        if (!res.ok) {
          if (this.isRetryable(null, res.status) && attempt < this.maxRetries) {
            lastError = new RegistryClientError(
              res.status,
              "UNKNOWN",
              `Request failed with status ${res.status}`,
            );
            continue;
          }
          await this.handleErrorResponse(
            res,
            "UNKNOWN",
            `Request failed with status ${res.status}`,
          );
        }

        return res.json() as Promise<T>;
      } catch (error) {
        lastError = error;
        if (error instanceof RegistryClientError) throw error;
        if (this.isRetryable(error) && attempt < this.maxRetries) continue;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError;
  }

  // ─────────────────────────────────────────────
  // Discovery
  // ─────────────────────────────────────────────

  async discover(): Promise<RegistryDiscovery> {
    return this.request<RegistryDiscovery>("/.well-known/appstrate-registry.json");
  }

  // ─────────────────────────────────────────────
  // Packages
  // ─────────────────────────────────────────────

  async search(opts?: RegistrySearchOptions): Promise<RegistrySearchResult> {
    const params = new URLSearchParams();
    if (opts?.q) params.set("q", opts.q);
    if (opts?.type) params.set("type", opts.type);
    if (opts?.sort) params.set("sort", opts.sort);
    if (opts?.page) params.set("page", String(opts.page));
    if (opts?.perPage) params.set("per_page", String(opts.perPage));

    const qs = params.toString();
    return this.request<RegistrySearchResult>(`/api/v1/packages${qs ? `?${qs}` : ""}`);
  }

  async getPackage(scope: string, name: string): Promise<RegistryPackageDetail> {
    const res = await this.request<{ package: RegistryPackageDetail }>(
      `/api/v1/packages/${scope}/${name}`,
    );
    return res.package;
  }

  async downloadArtifact(
    scope: string,
    name: string,
    version: string,
    options?: { verifyIntegrity?: boolean },
  ): Promise<{ data: Uint8Array; integrity: string | null; verified: boolean }> {
    const url = `${this.baseUrl}/api/v1/packages/${scope}/${name}/${version}/download`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.downloadTimeout);

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        const res = await fetch(url, {
          headers: this.headers(),
          signal: controller.signal,
        });

        this.logger?.debug("registry download", {
          url,
          status: res.status,
          attempt,
        });

        if (!res.ok) {
          if (this.isRetryable(null, res.status) && attempt < this.maxRetries) {
            lastError = new RegistryClientError(
              res.status,
              "DOWNLOAD_FAILED",
              `Download failed with status ${res.status}`,
            );
            continue;
          }
          await this.handleErrorResponse(
            res,
            "DOWNLOAD_FAILED",
            `Download failed with status ${res.status}`,
          );
        }

        const data = new Uint8Array(await res.arrayBuffer());
        const integrity = res.headers.get("x-integrity");

        const shouldVerify = options?.verifyIntegrity !== false;
        let verified = false;

        if (shouldVerify && integrity) {
          const computed = computeIntegrity(data);
          verified = computed === integrity;
        }

        return { data, integrity, verified };
      } catch (error) {
        lastError = error;
        if (error instanceof RegistryClientError) throw error;
        if (this.isRetryable(error) && attempt < this.maxRetries) continue;
        throw error;
      }
    }

    clearTimeout(timer);
    throw lastError;
  }

  // ─────────────────────────────────────────────
  // Authenticated user endpoints
  // ─────────────────────────────────────────────

  async getMe(): Promise<RegistryAccount> {
    const res = await this.request<{ account: RegistryAccount }>("/api/v1/auth/me");
    return res.account;
  }

  async getMyScopes(): Promise<RegistryScope[]> {
    const res = await this.request<{ scopes: RegistryScope[] }>("/api/v1/auth/scopes");
    return res.scopes;
  }

  async claimScope(name: string): Promise<RegistryScope> {
    return this.request<RegistryScope>("/api/v1/scopes", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  async publish(artifact: Uint8Array): Promise<PublishResult> {
    const url = `${this.baseUrl}/api/v1/publish`;
    const formData = new FormData();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    formData.append("artifact", new Blob([artifact as any]), "artifact.zip");

    const headers: Record<string, string> = {};
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.downloadTimeout);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: formData,
        signal: controller.signal,
      });

      this.logger?.debug("registry publish", { url, status: res.status });

      if (!res.ok) {
        await this.handleErrorResponse(
          res,
          "PUBLISH_FAILED",
          `Publish failed with status ${res.status}`,
        );
      }

      return res.json() as Promise<PublishResult>;
    } finally {
      clearTimeout(timer);
    }
  }
}
