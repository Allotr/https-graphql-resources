import { getRedisConnection } from "../utils/redis-connector";

const LOCK_NAME = "allotr-resources-cache-lock";

export async function lockCacheWrite(){
    const redis = getRedisConnection().connection;
    await redis.set(LOCK_NAME, "");
}

export async function unlockCacheWrite(){
    const redis = getRedisConnection().connection;
    await redis.del(LOCK_NAME);
}

export async function isCacheWriteLocked(): Promise<boolean>{
    const redis = getRedisConnection().connection;
    const keyFoundCount = await redis.exists(LOCK_NAME);
    return keyFoundCount > 0;
}