import { OperationResult, ResourceDbObject, UserDbObject, LocalRole, TicketStatusCode, RequestSource, ResourceManagementResult, ResourceNotificationDbObject, ResourceUser } from "allotr-graphql-schema-types";
import { ObjectId, ClientSession, Db, ReadPreference, WriteConcern, ReadConcern, TransactionOptions } from "mongodb"
import { generateChannelId, getLastQueuePosition, getLastStatus, getFirstQueuePosition } from "./data-util";
import { canRequestStatusChange } from "../guards/guards";
import { NOTIFICATIONS, RESOURCES, USERS } from "../consts/collections";
import { sendNotification } from "../notifications/web-push";
import { RESOURCE_READY_TO_PICK } from "../consts/connection-tokens";
import { getRedisConnection } from "./redis-connector";
import express from "express";
async function getUserTicket(userId: string | ObjectId, resourceId: string, db: Db, session?: ClientSession): Promise<ResourceDbObject | null> {
    const [parsedUserId, parsedResourceId] = [new ObjectId(userId), new ObjectId(resourceId)];

    const [userTikcet] = await db.collection<ResourceDbObject>(RESOURCES).find({
        _id: parsedResourceId,
        "tickets.statuses.statusCode": {
            $ne: TicketStatusCode.Revoked
        },
        "tickets.user._id": parsedUserId
    }, {
        projection: {
            "tickets.$": 1,
            name: 1,
            createdBy: 1,
            description: 1,
            maxActiveTickets: 1,
            lastModificationDate: 1,
            _id: 1,
            creationDate: 1,
            activeUserCount: 1
        },
        session
    }).sort({
        lastModificationDate: -1
    }).toArray();

    return userTikcet;
}

async function getResource(resourceId: string, db: Db, session?: ClientSession): Promise<ResourceDbObject | null | undefined> {


    const userTikcet = await db.collection<ResourceDbObject>(RESOURCES).findOne({
        _id: new ObjectId(resourceId),
        "tickets.statuses.statusCode": {
            $ne: TicketStatusCode.Revoked
        }
    }, { session });

    return userTikcet;
}

async function getAwaitingTicket(resourceId: string, db: Db, session?: ClientSession): Promise<ResourceDbObject | null> {

    const parsedResourceId = new ObjectId(resourceId);
    const [userTikcet] = await db.collection<ResourceDbObject>(RESOURCES).find({
        _id: parsedResourceId,
        "tickets.statuses.statusCode": TicketStatusCode.AwaitingConfirmation
    }, {
        projection: {
            "tickets.$": 1,
            name: 1,
            createdBy: 1,
            description: 1,
            maxActiveTickets: 1,
            lastModificationDate: 1,
            _id: 1,
            creationDate: 1,
            activeUserCount: 1
        },
        session
    }).sort({
        lastModificationDate: -1
    }).toArray();

    return userTikcet;
}


async function getUser(userId: ObjectId | null | undefined, db: Db, session?: ClientSession): Promise<UserDbObject | null | undefined> {
    const userTikcet = await db.collection<UserDbObject>(USERS).findOne({
        _id: userId,
    }, { session })

    return userTikcet;
}



// Resource Utils
async function pushNewStatus(
    resourceId: string,
    ticketId: ObjectId | undefined | null,
    {
        statusCode,
        timestamp,
        queuePosition
    }: {
        statusCode: TicketStatusCode,
        timestamp: Date,
        queuePosition?: number
    },
    session: ClientSession,
    db: Db,
    previousStatus?: TicketStatusCode,
) {
    const increment: Record<TicketStatusCode, number> = {
        ACTIVE: 1,
        INACTIVE: previousStatus === TicketStatusCode.Active ? -1 : 0,
        AWAITING_CONFIRMATION: 0,
        INITIALIZED: 0,
        QUEUED: 0,
        REQUESTING: 0,
        REVOKED: 0
    }

    await db.collection(RESOURCES).updateOne({ _id: new ObjectId(resourceId) }, {
        $inc: {
            activeUserCount: increment[statusCode]
        },
        $set: {
            lastModificationDate: timestamp
        },
        $push: {
            "tickets.$[myTicket].statuses": { statusCode, timestamp, queuePosition }
        }
    }, {
        session,
        arrayFilters: [
            {
                "myTicket._id": ticketId
            },
        ],
    })

}

async function enqueue(
    resourceId: string,
    ticketId: ObjectId | undefined | null,
    timestamp: Date,
    session: ClientSession,
    db: Db
) {
    const resource = await getResource(resourceId, db)


    await db.collection(RESOURCES).updateOne({ _id: new ObjectId(resourceId) }, {
        $set: {
            lastModificationDate: timestamp
        },
        $push: {
            "tickets.$[myTicket].statuses": {
                statusCode: TicketStatusCode.Queued,
                timestamp,
                queuePosition: getLastQueuePosition(resource?.tickets) + 1
            }
        }
    }, {
        session,
        arrayFilters: [
            {
                "myTicket._id": ticketId
            },
        ],
    })
}

async function forwardQueue(
    resourceId: string,
    timestamp: Date,
    session: ClientSession,
    db: Db
) {

    await db.collection(RESOURCES).updateOne({
        _id: new ObjectId(resourceId)
    }, {
        $set: {
            lastModificationDate: timestamp,
            "tickets.$[].statuses.$[myStatus].timestamp": timestamp
        },
        $inc: {
            activeUserCount: 0,
            "tickets.$[].statuses.$[myStatus].queuePosition": -1
        }
    }, {
        session,
        arrayFilters: [
            {
                "myStatus.queuePosition": { $nin: [null, 0] }
            },
        ],
    })
}

async function clearOutQueueDependantTickets(
    resource: ResourceDbObject,
    userList: ResourceUser[],
    context: express.Request,
    status: typeof TicketStatusCode.Active | typeof TicketStatusCode.AwaitingConfirmation,
    db: Db,
    session?: ClientSession
) {

    const functionMap: Record<typeof status, Function> = {
        ACTIVE: async (parent, args, context: express.Request) => {
            const { requestFrom, resourceId } = args
            let timestamp = new Date();

            const client = await (await context.mongoDBConnection).connection;
            const db = await (await context.mongoDBConnection).db;

            let result: ResourceManagementResult = { status: OperationResult.Ok };

            // Step 1: Start a Client Session
            const session = client.startSession();
            // Step 2: Optional. Define options to use for the transaction
            const transactionOptions: TransactionOptions = {
                readPreference: new ReadPreference(ReadPreference.PRIMARY),
                readConcern: new ReadConcern("local"),
                writeConcern: new WriteConcern("majority")
            };
            // Step 3: Use withTransaction to start a transaction, execute the callback, and commit (or abort on error)
            // Note: The callback for withTransaction MUST be async and/or return a Promise.
            try {
                await session.withTransaction(async () => {
                    // Check if we can request the resource right now
                    const { canRequest, ticketId, previousStatusCode, firstQueuePosition } = await canRequestStatusChange(new ObjectId(context?.user?._id ?? ""), resourceId, TicketStatusCode.Inactive, timestamp, db, session);
                    if (!canRequest) {
                        result = { status: OperationResult.Error }
                        throw result;
                    }
                    // Change status to inactive
                    await pushNewStatus(resourceId, ticketId, { statusCode: TicketStatusCode.Inactive, timestamp }, session, db, previousStatusCode);


                    // Notify our next in queue user
                    await notifyFirstInQueue(resourceId, timestamp, firstQueuePosition, db, session);
                }, transactionOptions);
            } finally {
                await session.endSession();
            }
            if (result.status === OperationResult.Error) {
                return result;
            }


            // Here comes the notification code


            // Once the session is ended, let's get and return our new data

            const resource = await getResource(resourceId, db)
            if (resource == null) {
                return { status: OperationResult.Error }
            }

            await pushNotification(resource?.name, resource?._id, resource?.createdBy?._id, resource?.createdBy?.username, timestamp, db);


            // Status changed, now let's return the new resource
            return generateOutputByResource[requestFrom](resource, new ObjectId(context?.user?._id ?? ""), resourceId, db);
        },
        AWAITING_CONFIRMATION: async (parent, args, context: express.Request) => {
            const { resourceId } = args
            let timestamp = new Date();

            const client = await (await context.mongoDBConnection).connection;
            const db = await (await context.mongoDBConnection).db;

            let result: ResourceManagementResult = { status: OperationResult.Ok };

            // Step 1: Start a Client Session
            const session = client.startSession();
            // Step 2: Optional. Define options to use for the transaction
            const transactionOptions: TransactionOptions = {
                readPreference: new ReadPreference(ReadPreference.PRIMARY),
                readConcern: new ReadConcern("local"),
                writeConcern: new WriteConcern("majority")
            };
            // Step 3: Use withTransaction to start a transaction, execute the callback, and commit (or abort on error)
            // Note: The callback for withTransaction MUST be async and/or return a Promise.
            try {
                await session.withTransaction(async () => {
                    // Check if we can request the resource right now
                    const { canRequest, firstQueuePosition } = await canRequestStatusChange(new ObjectId(context?.user?._id ?? ""), resourceId, TicketStatusCode.Inactive, timestamp, db, session);
                    if (!canRequest) {
                        result = { status: OperationResult.Error }
                        throw result;
                    }
                    // Remove our awaiting confirmation
                    await removeAwaitingConfirmation(resourceId, firstQueuePosition, session, db)
                }, transactionOptions);
            } finally {
                await session.endSession();
            }

            // // Step 1: Start a Client Session
            const session2 = client.startSession();

            try {
                await session2.withTransaction(async () => {
                    // Check if we can request the resource right now
                    const { canRequest, ticketId, previousStatusCode, firstQueuePosition } = await canRequestStatusChange(new ObjectId(context?.user?._id ?? ""), resourceId, TicketStatusCode.Queued, timestamp, db, session2);
                    if (!canRequest) {
                        result = { status: OperationResult.Error }
                        throw result;
                    }
                    // Change status to active
                    // Move people forward in the queue
                    await forwardQueue(resourceId, timestamp, session2, db);
                    await pushNewStatus(resourceId, ticketId, { statusCode: TicketStatusCode.Inactive, timestamp }, session2, db, previousStatusCode);


                }, transactionOptions);
            } finally {
                await session2.endSession();
            }
            if (result.status === OperationResult.Error) {
                return result;
            }

            // Once the session is ended, let's get and return our new data

            const resource = await getResource(resourceId, db)
            if (resource == null) {
                return { status: OperationResult.Error }
            }

            const firstQueuePosition = getFirstQueuePosition(resource?.tickets ?? []);
            await notifyFirstInQueue(resourceId, timestamp, firstQueuePosition, db);

            await pushNotification(resource?.name, resource?._id, resource?.createdBy?._id, resource?.createdBy?.username, timestamp, db);

            // Status changed, now let's return the new resource
            return generateOutputByResource["HOME"](resource, new ObjectId(context?.user?._id ?? ""), resourceId, db);
        }
    }

    const argMap: Record<typeof status, Function> = {
        ACTIVE: (resourceId: ObjectId, requestFrom: RequestSource) => ({ resourceId, requestFrom }),
        AWAITING_CONFIRMATION: (resourceId: ObjectId) => ({ resourceId })
    }

    const filteredUserList = userList.filter(({ id }) => {
        const myTicket = resource.tickets.find(({ user }) => new ObjectId(user._id ?? "").equals(id));
        if (myTicket == null) {
            return false;
        }
        return getLastStatus(myTicket).statusCode === status;
    });
    for (const user of filteredUserList) {
        try {
            const args = argMap[status](new ObjectId(resource?._id ?? "").toHexString() ?? "", RequestSource.Resource)
            const functionContext = {
                ...context,
                user: await getUser(new ObjectId(user.id), db, session)
            }
            await functionMap[status]?.(undefined, args, functionContext);
        } catch (e) {
            console.log("Some resource could not be let go. Perhaps it was not in the correct status", e);
        }
    }

}

async function removeUsersInQueue(resource: ResourceDbObject, userList: ResourceUser[], timestamp: Date,
    db: Db, context: Express.Request, session?: ClientSession) {

    const deletionUsersQueuePosition = userList
        .map<number>(
            ({ id }) => {
                const myTicket = resource.tickets.find(({ user }) => new ObjectId(user._id ?? "").equals(id));
                if (myTicket == null) {
                    return -1;
                }
                const queuedStatus = myTicket.statuses.find(({ statusCode }) => statusCode === TicketStatusCode.Queued);
                if (queuedStatus == null) {
                    return -1;
                }
                return queuedStatus.queuePosition ?? -1;
            }
        )
        .filter(value => value !== -1)
        .sort();
    for (let index = 0; index < deletionUsersQueuePosition.length; index++) {
        const queuePosition = deletionUsersQueuePosition[index];
        const nextQueuePosition = deletionUsersQueuePosition?.[index + 1] ?? Number.MAX_SAFE_INTEGER;
        await db.collection(RESOURCES).updateOne({
            _id: new ObjectId(resource._id ?? ""),
        }, {
            $set: {
                lastModificationDate: timestamp,
                "tickets.$[].statuses.$[myStatus].timestamp": timestamp
            },
            $inc: {
                "tickets.$[].statuses.$[myStatus].queuePosition": -1
            }
        }, {
            session,
            arrayFilters: [
                {
                    $and: [{ "myStatus.queuePosition": { $gt: queuePosition } }, { "myStatus.queuePosition": { $lt: nextQueuePosition } }]
                },
            ],
        })
    }
    // Delete notifications
    await db.collection<ResourceNotificationDbObject>(NOTIFICATIONS).deleteMany({
        "resource._id": new ObjectId(resource._id ?? ""),
        "user._id": {
            $in: [...userList?.map(({ id }) => !!id ? new ObjectId(id) : null).filter(Boolean)]
        }
    }, { session })


    await db.collection<ResourceDbObject>(RESOURCES).updateMany({
        _id: new ObjectId(resource._id ?? ""),
    }, {
        $pull: {
            tickets: {
                "user._id": { $in: [...userList?.map(({ id }) => !!id ? new ObjectId(id) : null).filter(Boolean)] }
            }
        } as any
    }, {
        session
    })
}

async function removeAwaitingConfirmation(
    resourceId: string,
    firstQueuePosition: number,
    session: ClientSession,
    db: Db
) {

    // Delete notification
    const userId = (await getAwaitingTicket(resourceId, db))?.tickets?.[0].user?._id;
    await db.collection<ResourceNotificationDbObject>(NOTIFICATIONS).deleteOne(
        {
            "resource._id": new ObjectId(resourceId),
            "user._id": userId
        }, {
        session
    })

    const result = await db.collection<ResourceDbObject>(RESOURCES).updateMany({
        _id: new ObjectId(resourceId),
        "tickets.statuses.statusCode": TicketStatusCode.AwaitingConfirmation
    }, {
        $pull: {
            "tickets.$[myTicket].statuses": { $or: [{ statusCode: TicketStatusCode.AwaitingConfirmation }, { statusCode: TicketStatusCode.Queued, queuePosition: firstQueuePosition }] }
        }
    }, {
        session,
        arrayFilters: [
            {
                "myTicket.statuses.statusCode": TicketStatusCode.AwaitingConfirmation
            },
        ],
    })
}

async function notifyFirstInQueue(
    resourceId: string,
    timestamp: Date,
    firstQueuePosition: number,
    db: Db,
    session?: ClientSession
) {
    await db.collection(RESOURCES).updateOne({
        _id: new ObjectId(resourceId),
        "tickets.statuses.queuePosition": firstQueuePosition
    }, {
        $push: {
            "tickets.$[myTicket].statuses": { statusCode: TicketStatusCode.AwaitingConfirmation, timestamp, queuePosition: firstQueuePosition }
        }
    }, {
        session,
        arrayFilters: [
            {
                "myTicket.statuses.queuePosition": firstQueuePosition
            },
        ],
    })
}


const generateOutputByResource: Record<RequestSource, (resource: ResourceDbObject, userId: ObjectId, resourceId: string, db: Db) => ResourceManagementResult> = {
    HOME: ({ activeUserCount, creationDate, createdBy, lastModificationDate, name, description, tickets, maxActiveTickets }, userId, resourceId) => {
        const myTicket = tickets?.[0];
        const { statusCode, timestamp: lastStatusTimestamp, queuePosition } = getLastStatus(tickets.find(({ user }) => user._id?.equals(userId)));
        return {
            status: OperationResult.Ok,
            updatedResourceCard: {
                activeUserCount,
                creationDate,
                createdBy: { userId: createdBy?._id?.toHexString(), username: createdBy?.username ?? "" },
                lastModificationDate,
                maxActiveTickets,
                name,
                queuePosition,
                description,
                lastStatusTimestamp,
                statusCode: statusCode as TicketStatusCode,
                role: myTicket.user?.role as LocalRole,
                ticketId: myTicket._id?.toHexString(),
                resourceId
            }
        }
    },
    RESOURCE: (resource) => ({
        status: OperationResult.Ok,
        // TO BE IMPLEMENTED WHEN VIEW IS READY
        // updatedResourceView: {

        // }
    }),
}



async function pushNotification(resourceName: string, resourceId: ObjectId | null | undefined,
    createdByUserId: ObjectId | null | undefined, createdByUsername: string | undefined, timestamp: Date, db: Db, session?: ClientSession) {


    // let's notify all the WebPush links associated with the user
    const resource = await getAwaitingTicket(resourceId?.toHexString() ?? "", db);
    const ticket = resource?.tickets[0];
    const user = ticket?.user;

    // Now we insert the record
    if (user?._id == null) {
        return;
    }

    const notificationData = {
        _id: new ObjectId(),
        ticketStatus: TicketStatusCode.AwaitingConfirmation,
        user: { username: user?.username ?? "", _id: user?._id },
        titleRef: "ResourceAvailableNotification",
        descriptionRef: "ResourceAvailableDescriptionNotification",
        resource: { _id: resourceId, name: resourceName, createdBy: { _id: createdByUserId, username: createdByUsername ?? "" } },
        timestamp
    };
    await db.collection<ResourceNotificationDbObject>(NOTIFICATIONS).insertOne(notificationData, { session });

    // Finally, we obtain the destined user subscriptions
    const fullReceivingUser = await getUser(user?._id, db);
    if (fullReceivingUser == null) {
        return;
    }

    // Send WebPush notification
    for (const subscription of fullReceivingUser?.webPushSubscriptions ?? []) {
        if (subscription == null) {
            return;
        }
        try {
            await sendNotification({
                endpoint: subscription.endpoint ?? "",
                keys: {
                    auth: subscription.keys?.auth ?? "",
                    p256dh: subscription.keys?.p256dh ?? ""
                }
            })
        } catch (e) {
            console.log("ERROR PUSHING", e)
            // Let's delete the bad subscription
            await db.collection(USERS).updateOne({
                _id: user._id
            }, {
                $pull: {
                    "webPushSubscriptions": subscription
                }
            }, {
                session,
                arrayFilters: [],
            })
        }
    }

    // Send message to Redis pubsub so that GraphQL subscription web service can publish the value
    getRedisConnection().pubsub.publish(generateChannelId(RESOURCE_READY_TO_PICK, user?._id), {
        myNotificationDataSub: [
            {
                ticketStatus: notificationData.ticketStatus as TicketStatusCode,
                user: { username: notificationData.user.username, id: notificationData.user._id.toHexString() },
                descriptionRef: notificationData.descriptionRef,
                id: notificationData._id?.toHexString(),
                resource: {
                    id: notificationData.resource?._id as any, name: notificationData.resource?.name ?? "", createdBy: {
                        username: notificationData.resource?.createdBy?.username ?? "",
                        id: notificationData.resource?.createdBy?._id as any
                    }
                },
                timestamp: notificationData.timestamp,
                titleRef: notificationData.titleRef
            }
        ]
    })

}

export { getUserTicket, getResource, pushNewStatus, enqueue, forwardQueue, notifyFirstInQueue, generateOutputByResource, clearOutQueueDependantTickets, pushNotification, getAwaitingTicket, removeAwaitingConfirmation, removeUsersInQueue }