import { TicketStatusCode } from "allotr-graphql-schema-types";

const VALID_STATUES_MAP: Record<TicketStatusCode, TicketStatusCode[]> = {
    INITIALIZED: [
        TicketStatusCode.Requesting,
        TicketStatusCode.Revoked
    ],
    REQUESTING: [
        TicketStatusCode.Active,
        TicketStatusCode.Queued,
        TicketStatusCode.Revoked
    ],
    QUEUED: [
        TicketStatusCode.AwaitingConfirmation,
        TicketStatusCode.Revoked
    ],
    AWAITING_CONFIRMATION: [
        TicketStatusCode.Active,
        TicketStatusCode.Inactive,
        TicketStatusCode.Revoked
    ],
    ACTIVE: [
        TicketStatusCode.Inactive,
        TicketStatusCode.Revoked
    ],
    INACTIVE: [
        TicketStatusCode.Requesting,
        TicketStatusCode.Revoked
    ],
    REVOKED: []
}

export { VALID_STATUES_MAP }