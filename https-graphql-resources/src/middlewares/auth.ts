import { getLoadedEnvVariables } from "../utils/env-loader";
import { Store } from "express-session";
import MongoStore from 'connect-mongo';
import { ObjectId } from "mongodb";
import { GraphQLError, parse } from "graphql";
import { GraphQLParams } from "graphql-yoga";

let store: Store;
let sessionSecret: string;

function initializeSessionStore() {
    const {
        MONGO_DB_ENDPOINT,
        SESSION_SECRET
    } = getLoadedEnvVariables();

    store = new MongoStore({ mongoUrl: MONGO_DB_ENDPOINT });
    sessionSecret = SESSION_SECRET;
}

async function getUserInfoFromRequest(request: Request, params: GraphQLParams<Record<string, any>, Record<string, any>>): Promise<[sid: string | null, userId: ObjectId | null]> {
    const sid = getSessionIdFromHeader(request);
    const userId = await getUserIdFromSessionStore(sid);
  
    if (!isSDLQuery(params) && userId == null) {
        throw new GraphQLError("Unauthorized, log in!");
    }
    return [sid, userId];
}

function isSDLQuery(params: GraphQLParams<Record<string, any>, Record<string, any>>): boolean {
    const parsedQuery = parse(params?.query ?? "");

    return (parsedQuery?.definitions?.[0] as any)?.name?.value === "_sdlResource"
}

function getSessionIdFromHeader(request: Request): string | null {
    const authHeader = request.headers.get('authorization') ?? "";

    if (authHeader.startsWith("Bearer ")) {
        return authHeader.substring(7, authHeader.length);
    } else {
        console.log("Bad auth header: " + authHeader);
        return null
    }

}

async function getUserIdFromSessionStore(sid: string | null): Promise<ObjectId | null> {
    if (sid == null) {
        return null;
    }
    return new Promise((resolve) => {
        store.get(sid, (err, session: any) => {
            if (err != null) {
                resolve(null);
                return;
            }

            const userId = session?.passport?.user ?? "";

            resolve(new ObjectId(userId));
        })
    })
}


function logoutSession(sid: string): Promise<void> {
    return new Promise((resolve, reject) => {
        store.destroy(sid, (err) => {
            if (err != null) {
                console.log("Error logging out")
                reject();
            }

            resolve();
        })
    })
}


export { initializeSessionStore, getUserInfoFromRequest, logoutSession }