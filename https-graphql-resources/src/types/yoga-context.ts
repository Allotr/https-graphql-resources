import { UserDbObject } from "allotr-graphql-schema-types";
import { RedisPubSub } from "graphql-redis-subscriptions";
import { UseResponseCacheParameter } from "yoga-response-cache-custom/dist";
import { MongoClient, Db } from "mongodb";
import { Redis } from "ioredis";
import { HttpRequest, HttpResponse } from "uWebSockets.js";


interface ServerContext {
    req: HttpRequest
    res: HttpResponse
  }

type UserContext = {
    mongoDBConnection: Promise<{ connection: Promise<MongoClient>, db: Promise<Db> }>;
    redisConnection: { pubsub: RedisPubSub, connection: Redis };
    user: UserDbObject;
    cache: UseResponseCacheParameter["cache"]
    sid: string,
    logout: (sid: string) => Promise<void>
}

type GraphQLContext = ServerContext & UserContext;


export { ServerContext, UserContext, GraphQLContext }