import express from "express";
import { getMongoDBConnection } from "./mongodb-connector";
import { getRedisConnection } from "./redis-connector";

function connectionMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
    req.mongoDBConnection = getMongoDBConnection();
    req.redisConnection = getRedisConnection();
    next();
}

export { connectionMiddleware }