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

export class RegistryClient {
  private baseUrl: string;
  private accessToken?: string;

  constructor(config: RegistryConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.accessToken = config.accessToken;
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

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        ...this.headers(),
        ...options?.headers,
      },
    });

    if (!res.ok) {
      await this.handleErrorResponse(res, "UNKNOWN", `Request failed with status ${res.status}`);
    }

    return res.json() as Promise<T>;
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
  ): Promise<{ data: Uint8Array; integrity: string | null }> {
    const url = `${this.baseUrl}/api/v1/packages/${scope}/${name}/${version}/download`;
    const res = await fetch(url, {
      headers: this.headers(),
    });

    if (!res.ok) {
      await this.handleErrorResponse(res, "DOWNLOAD_FAILED", `Download failed with status ${res.status}`);
    }

    const data = new Uint8Array(await res.arrayBuffer());
    const integrity = res.headers.get("x-integrity");

    return { data, integrity };
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
    formData.append("artifact", new Blob([artifact]), "artifact.zip");

    const headers: Record<string, string> = {};
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: formData,
    });

    if (!res.ok) {
      await this.handleErrorResponse(res, "PUBLISH_FAILED", `Publish failed with status ${res.status}`);
    }

    return res.json() as Promise<PublishResult>;
  }

}
