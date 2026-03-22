export interface CloudModule {
  initCloud(config: { databaseUrl: string; redisUrl: string; appUrl: string }): Promise<void>;
  getCloudConfig(): { platform: "cloud" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  QuotaExceededError: new (...args: any[]) => Error & { code: "QUOTA_EXCEEDED" };
  publicPaths: string[];
  cloudHooks: {
    checkQuota(orgId: string, runningExecutionCount: number): Promise<void>;
    recordUsage(orgId: string, executionId: string, cost: number): Promise<void>;
    onOrgCreated(orgId: string, userEmail: string): Promise<void>;
    onOrgDeleted(orgId: string): Promise<void>;
  };
  registerCloudRoutes(app: unknown): void;
}

let _cloud: CloudModule | null | undefined = undefined;

export async function loadCloud(): Promise<CloudModule | null> {
  if (_cloud !== undefined) return _cloud;

  // Step 1: try to import the module — if absent, OSS mode (silent)
  let mod: CloudModule;
  try {
    // Dynamic import of optional module — variable specifier prevents tsc from resolving it statically
    const pkg = "@appstrate/cloud";
    mod = await import(/* webpackIgnore: true */ pkg);
  } catch {
    _cloud = null;
    return null;
  }

  // Step 2: module found — init must succeed or crash (misconfiguration)
  await mod.initCloud({
    databaseUrl: process.env.DATABASE_URL!,
    redisUrl: process.env.REDIS_URL!,
    appUrl: process.env.APP_URL ?? "http://localhost:3000",
  });
  _cloud = mod;
  return _cloud;
}

export function getCloudModule(): CloudModule | null {
  if (_cloud === undefined) throw new Error("Cloud not initialized. Call loadCloud() at boot.");
  return _cloud;
}
