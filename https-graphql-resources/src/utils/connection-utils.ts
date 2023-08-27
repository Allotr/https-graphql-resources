import { Redis } from "ioredis";

async function deleteAllResourceCachedData(redis: Redis, id = "*"): Promise<void> {
    console.log("Delete all cached data for resource: " + id);
    await deleteStringsByKeyInSet(redis, `ResourceCard`);
    await deleteStringsByKeyInSet(redis, `ResourceView`);
    await deleteStringsByKeyInSet(redis, `ResourceCard:${id}`);
    await deleteStringsByKeyInSet(redis, `ResourceView:${id}`);
}

async function deleteStringsByKeyInSet(redis: Redis, match: string): Promise<void> {
    if (match == null) {
        console.log("No expression provided");
        return;
    }
    return new Promise((resolve, rejected) => {
        // Create a readable stream (object mode)
        const stream = redis.scanStream({ match });
        stream.on('data', (keys) => {
            // `keys` is an array of strings representing key names
            if (keys.length) {
                const pipeline = redis.pipeline();

                keys.forEach(async (key) => {
                    // Or ioredis returns a promise if the last argument isn't a function
                    const result = await redis.smembers(key)
                    for (const innerKey of result) {
                        pipeline.del(innerKey);
                    }

                    pipeline.del(key);
                    pipeline.exec();
                });

            }
        });
        stream.on('end', function () {
            resolve();
        });
    })

}

export { deleteAllResourceCachedData }