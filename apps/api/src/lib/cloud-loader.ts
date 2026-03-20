export interface CloudModule {
  initCloud(config: { databaseUrl: string; redisUrl: string }): Promise<void>;
  getCloudConfig(): { platform: "cloud" };
  cloudHooks: {
    checkQuota(orgId: string): Promise<{ allowed: boolean; remaining: number; reserved: number }>;
    recordUsage(orgId: string, executionId: string, cost: number, reserved: number): Promise<void>;
    releaseReservation(orgId: string, reserved: number): Promise<void>;
    onOrgCreated(orgId: string): Promise<void>;
    onOrgDeleted(orgId: string): Promise<void>;
  };
  registerCloudRoutes(app: unknown): void;
}

let _cloud: CloudModule | null | undefined = undefined;

export async function loadCloud(): Promise<CloudModule | null> {
  if (_cloud !== undefined) return _cloud;
  try {
    // @ts-expect-error — @appstrate/cloud only exists in EE builds
    _cloud = (await import("@appstrate/cloud")) as CloudModule;
    return _cloud;
  } catch {
    _cloud = null;
    return null;
  }
}

export function getCloudModule(): CloudModule | null {
  if (_cloud === undefined) throw new Error("Cloud not initialized. Call loadCloud() at boot.");
  return _cloud;
}
