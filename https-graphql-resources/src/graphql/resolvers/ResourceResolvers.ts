
import { Resolvers, OperationResult, ResourceDbObject, UserDbObject, LocalRole, TicketStatusCode, ErrorCode, ResourceManagementResult, TicketViewUserInfo, TicketView, TicketStatus, ResourceUser, UpdateResult, ResourceNotificationDbObject, ResolversTypes } from "allotr-graphql-schema-types";
import { ObjectId, ReadPreference, WriteConcern, ReadConcern, TransactionOptions } from "mongodb"
import { categorizeArrayData, customTryCatch, getFirstQueuePosition, getLastStatus } from "../../utils/data-util";
import { CustomTryCatch } from "../../types/custom-try-catch";
import { canRequestStatusChange, hasAdminAccessInResource } from "../../guards/guards";
import { enqueue, forwardQueue, generateOutputByResource, getResource, pushNotification, notifyFirstInQueue, pushNewStatus, removeAwaitingConfirmation, removeUsersInQueue, clearOutQueueDependantTickets, getUser } from "../../utils/resolver-utils";
import { NOTIFICATIONS, RESOURCES, USERS } from "../../consts/collections";
import { CategorizedArrayData } from "../../types/categorized-array-data";
import { GraphQLContext } from "../../types/yoga-context";


export const ResourceResolvers: Resolvers = {
    Query: {
        myResources: async (parent, args, context: GraphQLContext) => {

            const db = await (await context.mongoDBConnection).db;


            const myCurrentTicket = await db.collection<ResourceDbObject>(RESOURCES).find({
                "tickets.statuses.statusCode": {
                    $ne: TicketStatusCode.Revoked
                },
                "tickets.user._id": context.user._id
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
                }
            }).sort({
                creationDate: 1
            }).toArray();

            const resourceList: Array<ResolversTypes['ResourceCard']> = [];
            const arrayLength = myCurrentTicket.length
            for (let index = 0; index < arrayLength; index++) {
                const { _id, creationDate, createdBy, lastModificationDate, maxActiveTickets, name, tickets, description, activeUserCount } = myCurrentTicket[index];
                const myTicket = tickets?.[0];
                const { statusCode, timestamp: lastStatusTimestamp, queuePosition } = getLastStatus(myTicket);
                resourceList.push({
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
                    id: _id?.toHexString() ?? ""
                });
            }

            return resourceList;
        },
        viewResource: async (parent, args, context: GraphQLContext) => {
            const { resourceId } = args;
            const db = await (await context.mongoDBConnection).db;
            const myResource = await db.collection<ResourceDbObject>(RESOURCES).findOne({
                _id: new ObjectId(resourceId)
            });

            if (myResource == null) {
                return null;
            }

            const tickets = myResource.tickets;

            if (tickets.findIndex(({ user }) => user._id?.equals(context?.user?._id ?? "")) === -1) {
                return null;
            }

            const userDataMap: Record<string, TicketViewUserInfo> = {};
            const userIdList = tickets.map(({ user }) => user._id);

            const userDataList = await db.collection<UserDbObject>(USERS).find(
                {
                    _id: { $in: userIdList }
                }, {
                projection: {
                    _id: 1,
                    username: 1,
                    name: 1,
                    surname: 1
                }
            }).toArray();

            if (userDataList == null) {
                return null;
            }

            for (const user of userDataList) {
                const userId = user._id?.toHexString() ?? "";
                userDataMap[userId] = {
                    userId: userId,
                    name: user.name ?? "",
                    surname: user.surname ?? "",
                    username: user.username ?? "",
                    role: LocalRole.ResourceUser // Default role to be replaced later
                }
            }

            // Add the role to the map
            for (const { user } of tickets) {
                userDataMap[user._id?.toHexString() ?? ""].role = user.role as LocalRole;
            }

            const ticketList: Record<TicketStatusCode, TicketView[]> = {
                ACTIVE: [],
                AWAITING_CONFIRMATION: [],
                QUEUED: [],
                INACTIVE: [],
                INITIALIZED: [],
                // These are not used
                REQUESTING: [],
                REVOKED: []
            };
            const ticketListLength = tickets.length;
            for (let index = 0; index < ticketListLength; index++) {
                const ticket = tickets[index];
                const lastStatus = getLastStatus(ticket) as TicketStatus;
                const statusCode = lastStatus.statusCode;
                // Exclude invalid statuses
                if (
                    statusCode === TicketStatusCode.Requesting ||
                    statusCode === TicketStatusCode.Revoked
                ) {
                    continue;
                }

                ticketList[statusCode].push({
                    ticketId: ticket?._id?.toHexString(),
                    creationDate: ticket?.creationDate,
                    user: userDataMap[ticket?.user._id?.toHexString() ?? ""],
                    lastStatus
                })
            }

            // const filteredTicketList = [
            //     ticketList[TicketStatusCode.Active],
            //     ticketList[TicketStatusCode.AwaitingConfirmation],
            //     ticketList[TicketStatusCode.Queued],
            //     ticketList[TicketStatusCode.Inactive],
            //     ticketList[TicketStatusCode.Initialized]
            // ]

            const filteredTicketList = ticketList[TicketStatusCode.Active].concat(
                ticketList[TicketStatusCode.AwaitingConfirmation],
                ticketList[TicketStatusCode.Queued],
                ticketList[TicketStatusCode.Inactive],
                ticketList[TicketStatusCode.Initialized]
            )



            return {
                id: resourceId,
                activeUserCount: myResource.activeUserCount,
                creationDate: myResource.creationDate,
                lastModificationDate: myResource.lastModificationDate,
                maxActiveTickets: myResource.maxActiveTickets,
                name: myResource.name,
                description: myResource.description ?? "",
                createdBy: { username: myResource.createdBy?.username ?? "", userId: myResource.createdBy?._id?.toHexString() ?? "" },
                tickets: filteredTicketList
            };
        }
    },
    Mutation: {
        // Resource CRUD operations
        createResource: async (parent, args, context: GraphQLContext) => {
            const { name, description, maxActiveTickets, userList } = args.resource
            const timestamp = new Date();

            const db = await (await context.mongoDBConnection).db;

            // Check if user has entered himself as admin, it's important to do so
            const myUserIndex = userList.findIndex(user => new ObjectId(user.id).equals(new ObjectId(context?.user?._id ?? "")));
            if (myUserIndex === -1) {
                userList.push({ id: new ObjectId(new ObjectId(context?.user?._id ?? "")).toHexString(), role: LocalRole.ResourceAdmin });
            }

            // Force the role of my user to be admin when creating
            userList[myUserIndex] = { id: new ObjectId(new ObjectId(context?.user?._id ?? "")).toHexString(), role: LocalRole.ResourceAdmin }


            const userNameList = userList
                .map<Promise<[string, CustomTryCatch<UserDbObject | null | undefined>]>>(async ({ id }) =>
                    [
                        id,
                        await customTryCatch(db.collection<UserDbObject>(USERS).findOne({ _id: new ObjectId(id) }, { projection: { username: 1 } }))
                    ]);
            const { error, result: userListResult } = await customTryCatch(Promise.all(userNameList));

            if (error != null || userListResult == null) {
                return {
                    status: OperationResult.Error,
                    errorCode: ErrorCode.BadData,
                    errorMessage: "Some user in the list does not exist. Please, try with other users",
                    newObjectId: null
                }
            }
            const userNameMap = Object.fromEntries(userListResult.map(([id, { result: user }]) => [id, user?.username ?? ""]));

            const fullUser = await getUser(context.user._id, db);
            if (fullUser == null) {
                return {
                    status: OperationResult.Error,
                    errorCode: ErrorCode.BadData,
                    errorMessage: "Current user does not exist",
                    newObjectId: null
                }
            }

            // Find all results
            const newResource = {
                creationDate: timestamp,
                lastModificationDate: timestamp,
                maxActiveTickets,
                name,
                description,
                tickets: userList.map(({ id, role }) => ({
                    _id: new ObjectId(),
                    creationDate: timestamp,
                    statuses: [
                        { statusCode: TicketStatusCode.Initialized, timestamp, queuePosition: null }
                    ],
                    user: { role, _id: new ObjectId(id), username: userNameMap?.[id] },
                })),
                createdBy: { _id: new ObjectId(context?.user?._id ?? ""), username: fullUser.username },
                activeUserCount: 0
            }
            const result = await db.collection<ResourceDbObject>(RESOURCES).insertOne(newResource);

            if (result == null) {
                return { status: OperationResult.Error, newObjectId: null };
            }


            context?.cache?.invalidate([
                { typename: 'ResourceCard' }
            ])


            return { status: OperationResult.Ok, newObjectId: result.insertedId.toHexString() };
        },
        updateResource: async (parent, args, context: GraphQLContext) => {
            const { name, description, maxActiveTickets, userList: newUserList, id } = args.resource
            const timestamp = new Date();
            const db = await (await context.mongoDBConnection).db;

            const client = await (await context.mongoDBConnection).connection;

            const hasAdminAccess = await hasAdminAccessInResource(new ObjectId(context?.user?._id ?? "").toHexString() ?? "", id ?? "", db)
            if (!hasAdminAccess) {
                return { status: OperationResult.Error }
            }


            let result: UpdateResult = { status: OperationResult.Ok };

            // First let's clear out all awaiting confirmation

            // // Step 1: Start a Client Session
            const sessionInit = client.startSession();

            // Step 2: Optional. Define options to use for the transaction
            const transactionOptions: TransactionOptions = {
                readPreference: new ReadPreference(ReadPreference.PRIMARY),
                readConcern: new ReadConcern("local"),
                writeConcern: new WriteConcern("majority")
            };

            let categorizedUserData: CategorizedArrayData<ResourceUser> = { add: [], delete: [], modify: [] };
            let userNameMap: Record<string, string> = {};

            try {
                await sessionInit.withTransaction(async () => {
                    const userNameList = newUserList
                        .map<Promise<[string, CustomTryCatch<UserDbObject | null | undefined>]>>(async ({ id }) =>
                            [
                                id,
                                await customTryCatch(db.collection<UserDbObject>(USERS).findOne({ _id: new ObjectId(id) }, { projection: { username: 1 } }))
                            ]);
                    const { error, result: userListResult } = await customTryCatch(Promise.all(userNameList));
                    if (error != null || userListResult == null) {
                        return {
                            status: OperationResult.Error,
                            errorCode: ErrorCode.BadData,
                            errorMessage: "Some user in the list does not exist. Please, try with other users",
                            newObjectId: null
                        }
                    }
                    userNameMap = Object.fromEntries(userListResult.map(([id, { result: user }]) => [id, user?.username ?? ""]));

                    const resource = await getResource(id ?? "", db, sessionInit)
                    if (resource == null) {
                        return { status: OperationResult.Error }
                    }
                    const oldUserList = resource?.tickets?.map<ResourceUser>(({ user }) => ({ id: user._id?.toHexString() ?? "", role: user.role as LocalRole }))

                    categorizedUserData = categorizeArrayData(oldUserList, newUserList);
                    await clearOutQueueDependantTickets(resource, categorizedUserData.delete, context, TicketStatusCode.Active, db, sessionInit);
                    await clearOutQueueDependantTickets(resource, categorizedUserData.delete, context, TicketStatusCode.AwaitingConfirmation, db, sessionInit);
                }, transactionOptions);
            } finally {
                await sessionInit.endSession();
            }


            // Step 1: Start a Client Session
            const session = client.startSession();
            // Step 3: Use withTransaction to start a transaction, execute the callback, and commit (or abort on error)
            // Note: The callback for withTransaction MUST be async and/or return a Promise.
            try {
                await session.withTransaction(async () => {
                    const resource = await getResource(id ?? "", db, session)
                    if (resource == null) {
                        return { status: OperationResult.Error }
                    }


                    // Update
                    await db.collection<ResourceDbObject>(RESOURCES).updateMany({
                        _id: new ObjectId(id ?? ""),
                    }, {
                        $push: {
                            tickets: {
                                $each: categorizedUserData.add.map(({ id, role }) => {
                                    return {
                                        _id: new ObjectId(),
                                        creationDate: timestamp,
                                        statuses: [
                                            { statusCode: TicketStatusCode.Initialized, timestamp, queuePosition: null }
                                        ],
                                        user: { role, _id: new ObjectId(id), username: userNameMap?.[id] }
                                    }
                                })

                            }
                        }
                    }, {
                        session
                    })

                    await removeUsersInQueue(resource, categorizedUserData.delete, timestamp, db, context, session);

                    for (const { id: ticketUserId, role } of categorizedUserData.modify) {
                        await db.collection<ResourceDbObject>(RESOURCES).updateMany({
                            _id: new ObjectId(id ?? ""),
                            "tickets.user._id": new ObjectId(ticketUserId)
                        }, {
                            $set: {
                                "tickets.$[toModifyTicket].user.role": role
                            }

                        }, {
                            session,
                            arrayFilters: [
                                {
                                    "toModifyTicket.user._id": new ObjectId(ticketUserId)
                                },
                            ],
                        })

                    }

                    // Find all results
                    await db.collection<ResourceDbObject>(RESOURCES).updateMany({
                        _id: new ObjectId(id ?? "")
                    }, {
                        $set: {
                            lastModificationDate: timestamp,
                            maxActiveTickets,
                            name,
                            description
                        }
                    }, {
                        session
                    });

                    if (result == null) {
                        return { status: OperationResult.Error, newObjectId: null };
                    }
                }, transactionOptions);
            } finally {
                await session.endSession();
            }

            if (result.status === OperationResult.Error) {
                return result;
            }

            context?.cache?.invalidate([
                { typename: 'ResourceView' },
                { typename: 'ResourceCard' }
            ])

            // await deleteAllResourceCachedData(context?.redisConnection?.connection);

            return { status: OperationResult.Ok };
        },
        deleteResource: async (parent, args, context: GraphQLContext) => {
            const { resourceId } = args
            const db = await (await context.mongoDBConnection).db;

            const hasAdminAccess = await hasAdminAccessInResource(new ObjectId(context?.user?._id ?? "").toHexString() ?? "", resourceId, db)
            if (!hasAdminAccess) {
                // console.log("Does not have admin access", hasAdminAccess, new ObjectId(context?.user?._id ?? ""), resourceId);
                return { status: OperationResult.Error }
            }

            const deleteResult = await db.collection<ResourceDbObject>(RESOURCES).deleteOne({ _id: new ObjectId(resourceId) })

            // Delete notifications
            await db.collection<ResourceNotificationDbObject>(NOTIFICATIONS).deleteMany({
                "resource._id": new ObjectId(resourceId ?? "")
            })

            if (!deleteResult.deletedCount) {
                return { status: OperationResult.Error }
            }

            context?.cache?.invalidate([
                { typename: 'ResourceView' },
                { typename: 'ResourceCard' }
            ])


            return { status: OperationResult.Ok };
        },

        // Resource management operations
        requestResource: async (parent, args, context: GraphQLContext) => {
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
                    const {
                        canRequest,
                        ticketId,
                        activeUserCount = 0,
                        maxActiveTickets = 0,
                        previousStatusCode,
                        lastQueuePosition
                    } = await canRequestStatusChange(new ObjectId(context?.user?._id ?? ""), resourceId, TicketStatusCode.Requesting, timestamp, db, session);

                    if (!canRequest) {
                        result = { status: OperationResult.Error }
                        throw result;
                    }

                    // Change status to requesting
                    await pushNewStatus(resourceId, ticketId, {
                        statusCode: TicketStatusCode.Requesting,
                        timestamp
                    }, session, db, previousStatusCode);



                    // Here comes the logic to enter the queue or set the status as active
                    if (activeUserCount < maxActiveTickets && (lastQueuePosition === 0)) {
                        await pushNewStatus(resourceId, ticketId, { statusCode: TicketStatusCode.Active, timestamp }, session, db, TicketStatusCode.Requesting);
                    } else {
                        await enqueue(resourceId, ticketId, timestamp, session, db);
                    }


                }, transactionOptions);
            }
            catch (error) {
                // Implement if needed
            }
            finally {
                await session.endSession();
            }
            if (result.status === OperationResult.Error) {
                return result;
            }


            // Once the session is ended, le't get and return our new data

            const resource = await getResource(resourceId, db)
            if (resource == null) {
                return { status: OperationResult.Error }
            }

            context?.cache?.invalidate([
                { typename: 'ResourceView' },
                { typename: 'ResourceCard' }
            ])

            // Status changed, now let's return the new resource
            return generateOutputByResource[requestFrom](resource, new ObjectId(context?.user?._id ?? ""), resourceId, db);
        },
        acquireResource: async (parent, args, context: GraphQLContext) => {
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
                    const { canRequest, ticketId, previousStatusCode, firstQueuePosition } = await canRequestStatusChange(new ObjectId(context?.user?._id ?? ""), resourceId, TicketStatusCode.Active, timestamp, db, session);
                    if (!canRequest) {
                        result = { status: OperationResult.Error }
                        throw result;
                    }
                    // Change status to active
                    await removeAwaitingConfirmation(resourceId, firstQueuePosition, session, db)
                }, transactionOptions);
            }
            catch (error) {
                // Implement if needed
            }
            finally {
                await session.endSession();
            }

            // // Step 1: Start a Client Session
            const session2 = client.startSession();

            try {
                await session2.withTransaction(async () => {
                    // Check if we can request the resource right now
                    const { canRequest, ticketId, previousStatusCode, firstQueuePosition } = await canRequestStatusChange(new ObjectId(context?.user?._id ?? ""), resourceId, TicketStatusCode.Active, timestamp, db, session2);
                    if (!canRequest) {
                        result = { status: OperationResult.Error }
                        throw result;
                    }
                    // Change status to active
                    // Move people forward in the queue
                    await forwardQueue(resourceId, timestamp, session2, db);
                    await pushNewStatus(resourceId, ticketId, { statusCode: TicketStatusCode.Active, timestamp }, session2, db, previousStatusCode);


                }, transactionOptions);
            }
            catch (error) {
                // Implement if needed
            }
            finally {
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

            context?.cache?.invalidate([
                { typename: 'ResourceView' },
                { typename: 'ResourceCard' }
            ])

            // Status changed, now let's return the new resource
            return generateOutputByResource["HOME"](resource, new ObjectId(context?.user?._id ?? ""), resourceId, db);
        },
        cancelResourceAcquire: async (parent, args, context: GraphQLContext) => {
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
            }
            catch (error) {
                // Implement if needed
            }
            finally {
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
            }
            catch (error) {
                // Implement if needed
            }
            finally {
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

            context?.cache?.invalidate([
                { typename: 'ResourceView' },
                { typename: 'ResourceCard' }
            ])

            // Status changed, now let's return the new resource
            return generateOutputByResource["HOME"](resource, new ObjectId(context?.user?._id ?? ""), resourceId, db);
        },
        releaseResource: async (parent, args, context: GraphQLContext) => {
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
            }
            catch (error) {
                // Implement if needed
            }
            finally {
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


            context?.cache?.invalidate([
                { typename: 'ResourceView' },
                { typename: 'ResourceCard' }
            ])

            // Status changed, now let's return the new resource
            return generateOutputByResource[requestFrom](resource, new ObjectId(context?.user?._id ?? ""), resourceId, db);
        }
    }
}