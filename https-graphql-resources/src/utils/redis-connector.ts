import * as Redis from 'ioredis';
import { RedisPubSub } from "graphql-redis-subscriptions";
import { getLoadedEnvVariables } from "./env-loader";


let getRedisConnection = (): { pubsub: RedisPubSub } => {
    var instance: { pubsub: RedisPubSub };

    getRedisConnection = () => {
        return instance;
    }

    function createConnection() {
        if (instance) {
            return instance;
        }
        const { REDIS_ENDPOINT, REDIS_PORT } = getLoadedEnvVariables();
        const options = {
            host: REDIS_ENDPOINT,
            port: Number(REDIS_PORT),
            retryStrategy: (times: number) => {
                // reconnect after
                return Math.min(times * 50, 2000);
            }
        };
        instance = {
            pubsub: new RedisPubSub({
                messageEventName: 'messageBuffer',
                pmessageEventName: 'pmessageBuffer',
                publisher: new Redis.default(options),
                subscriber: new Redis.default(options)
            })
        };
        return instance;
    }
    return createConnection();
}

export { getRedisConnection };