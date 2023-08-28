import { CustomTryCatch } from "../types/custom-try-catch";
import { TicketDbObject, TicketStatusCode, TicketStatusDbObject } from "allotr-graphql-schema-types";
import { ObjectId } from "mongodb";
import { CategorizedArrayData } from "../types/categorized-array-data";

async function customTryCatch<T>(promise: Promise<T>): Promise<CustomTryCatch<T>> {
    try {
        const result = await promise;
        return { result, error: null }
    } catch (error) {
        return { result: null, error }
    }
}

function generateChannelId(communicationToken: string, userId?: ObjectId | null): string {
    return communicationToken + "_" + (userId ? new ObjectId(userId).toHexString() : "")
}

function getLastStatus(myTicket?: TicketDbObject): TicketStatusDbObject {
    return myTicket?.statuses[myTicket?.statuses.length - 1] ?? {
        statusCode: TicketStatusCode.Initialized,
        timestamp: new Date(),
        queuePosition: null
    };
}

function getLastQueuePosition(tickets: TicketDbObject[] | undefined = []): number {
    let maxPosition = 0;
    const ticketsLength = tickets.length;
    for (let index = 0; index < ticketsLength; index++) {
        const ticket = tickets[index];
        
        const { queuePosition } = getLastStatus(ticket);
        const parsedQueuePosition = queuePosition ?? 0;
        
        if (parsedQueuePosition > maxPosition){
            maxPosition = parsedQueuePosition;
        }
    }

    return maxPosition;
}

function getFirstQueuePosition(tickets: TicketDbObject[] | undefined = []): number {
    let minPosition = Number.MAX_SAFE_INTEGER;
    const ticketsLength = tickets.length;
    for (let index = 0; index < ticketsLength; index++) {
        const ticket = tickets[index];
        
        const { queuePosition } = getLastStatus(ticket);
        const parsedQueuePosition = queuePosition ?? Number.MAX_SAFE_INTEGER;
        
        if (parsedQueuePosition < minPosition){
            minPosition = parsedQueuePosition;
        }
    }

    return minPosition;
}

function categorizeArrayData<T extends { id: string }>(previousList: T[], newList: T[]): CategorizedArrayData<T> {
    const newListCopy = [...newList];
    const total: CategorizedArrayData<T> = {
        add: [],
        delete: [],
        modify: []
    }

    for (const previousData of previousList) {
        const indexInNewList = newListCopy.findIndex(({ id }) => id === previousData.id);
        if (indexInNewList !== -1) {
            // If found, we modify
            total.modify.push({ ...previousData, ...newListCopy[indexInNewList] })
            // And we remove the found value from the new list
            newListCopy.splice(indexInNewList, 1);
        } else {
            // If not found, we delete
            total.delete.push(previousData)
        }
    }
    // The rest is added
    total.add = newListCopy;
    return total;
}

function getBooleanByString(value: string): boolean {
    return value.toLowerCase() === 'true' || value.toUpperCase() === 'Y';
}

export { customTryCatch, generateChannelId, getLastStatus, getLastQueuePosition, categorizeArrayData, getFirstQueuePosition, getBooleanByString }