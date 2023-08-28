import { LocalRole, TicketStatusCode } from "allotr-graphql-schema-types";
import { ObjectId, ClientSession, Db } from "mongodb";
import { getFirstQueuePosition, getLastQueuePosition, getLastStatus } from "../utils/data-util";
import { VALID_STATUES_MAP } from "../consts/valid-statuses-map";
import { getUserTicket, getResource, getUserTicketFromResource } from "../utils/resolver-utils";


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
    const userTicket = getUserTicketFromResource(userId, resource);
    const { statusCode, queuePosition } = getLastStatus(userTicket);
    return {
        canRequest: userTicket != null && VALID_STATUES_MAP[statusCode as TicketStatusCode].includes(targetStatus),
        ticketId: resource?._id,
        activeUserCount: resource?.activeUserCount,
        maxActiveTickets: resource?.maxActiveTickets,
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



export { hasUserAccessInResource, hasAdminAccessInResource, canRequestStatusChange }