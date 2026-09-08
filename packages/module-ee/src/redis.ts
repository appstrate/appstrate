import Redis from "ioredis";

let cloudRedis: Redis | null = null;

export function getCloudRedis(): Redis | null {
  return cloudRedis;
}

export function initCloudRedis(redisUrl: string): void {
  if (!redisUrl) return; // Redis is optional — cloud features degrade gracefully
  cloudRedis = new Redis(redisUrl, {
    keyPrefix: "cloud:",
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
}
