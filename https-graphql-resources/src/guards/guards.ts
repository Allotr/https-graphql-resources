import { GlobalRole, LocalRole, TicketStatusCode, UserDbObject } from "allotr-graphql-schema-types";
import { ObjectId, ClientSession, Db } from "mongodb";
import { getFirstQueuePosition, getLastQueuePosition, getLastStatus } from "../utils/data-util";
import { VALID_STATUES_MAP } from "../consts/valid-statuses-map";
import { getUserTicket, getResource } from "../utils/resolver-utils";
import { GraphQLError } from "graphql";


async function canRequestStatusChange(userId: string | ObjectId, resourceId: string, targetStatus: TicketStatusCode, timestamp: Date, db: Db, session?: ClientSession): Promise<{
    canRequest: boolean,
    ticketId?: ObjectId | null,
    activeUserCount?: number,
    maxActiveTickets?: number,
    queuePosition?: number | null,
    previousStatusCode?: TicketStatusCode,
    lastQueuePosition: number,
    firstQueuePosition: number
}> {
    const resource = await getResource(resourceId, db, session);
    const lastQueuePosition = getLastQueuePosition(resource?.tickets);
    const firstQueuePosition = getFirstQueuePosition(resource?.tickets);
    const userTicket = await getUserTicket(userId, resourceId, db, session);
    const ticket = userTicket?.tickets?.[0];
    const { statusCode, queuePosition } = getLastStatus(ticket);
    return {
        canRequest: userTicket != null && VALID_STATUES_MAP[statusCode as TicketStatusCode].includes(targetStatus),
        ticketId: ticket?._id,
        activeUserCount: userTicket?.activeUserCount,
        maxActiveTickets: userTicket?.maxActiveTickets,
        queuePosition,
        previousStatusCode: statusCode as TicketStatusCode,
        lastQueuePosition,
        firstQueuePosition
    }

}

async function hasUserAccessInResource(userId: string | ObjectId, resourceId: string, db: Db, session?: ClientSession): Promise<boolean> {
    const resource = await getUserTicket(userId, resourceId, db, session);
    return resource?.tickets?.[0]?.user?.role === LocalRole.ResourceUser;
}

async function hasAdminAccessInResource(userId: string | ObjectId, resourceId: string, db: Db, session?: ClientSession): Promise<boolean> {
    const resource = await getUserTicket(userId, resourceId, db, session);
    return resource?.tickets?.[0]?.user?.role === LocalRole.ResourceAdmin;
}

function hasGlobalAdminAccess(sessionUser: UserDbObject): boolean {
    return sessionUser.globalRole === GlobalRole.Admin;
}

function getTargetUserId(sessionUser: UserDbObject, targetUserId?: string | null): ObjectId {
    const isAdmin = hasGlobalAdminAccess(sessionUser);

    // USER role
    if (!isAdmin) {
        // Session is authenticated before this, so the session user is never null
        return sessionUser?._id!;
    }

    // ADMIN role but targetUserId is null
    if (targetUserId == null) {
        throw new GraphQLError("ADMIN users need to provide a userId as parameter. This request will be done on behalf of that user");
    }

    // ADMIN role with targetUserId
    return new ObjectId(targetUserId);
}



export { hasUserAccessInResource, hasAdminAccessInResource, canRequestStatusChange, getTargetUserId }