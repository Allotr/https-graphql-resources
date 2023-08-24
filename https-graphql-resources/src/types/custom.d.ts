import { UserDbObject } from "allotr-graphql-schema-types";
import { RedisPubSub } from "graphql-redis-subscriptions";
import { MongoDBSingleton } from "../utils/mongodb-connector";
import { RedisSingleton } from "../utils/redis-connector";

declare module "express-serve-static-core" {
    interface Request {
        mongoDBConnection: Promise<{ connection: Promise<MongoClient>, db: Promise<Db> }>;
        redisConnection: { pubsub: RedisPubSub };
        user: UserDbObject;
    }
}

declare module 'express-session' {
    export interface SessionData {
        returnTo: string;
    }
}