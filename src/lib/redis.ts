import Redis from "ioredis";

/**
 * Create a fresh Redis connection per request.
 * Serverless functions have ephemeral lifecycles — cached TCP sockets
 * go stale between warm invocations. A fresh connection per request
 * is the most reliable pattern.
 */
export function getRedis(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST || "redis-14697.c52.us-east-1-4.ec2.cloud.redislabs.com",
    port: parseInt(process.env.REDIS_PORT || "14697", 10),
    password: process.env.REDIS_PASSWORD || "",
    maxRetriesPerRequest: 3,
    connectTimeout: 10000,
    commandTimeout: 10000,
  });
}

export async function disconnectRedis(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
