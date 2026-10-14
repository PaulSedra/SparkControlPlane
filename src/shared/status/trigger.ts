/** Trigger event states shared across ingestion, delivery, and web diagnostics. */
export const TriggerEventStatus = {
    DUPLICATE: 'DUPLICATE',
    FAILED: 'FAILED',
    IGNORED: 'IGNORED',
    RECEIVED: 'RECEIVED',
    ROUTED: 'ROUTED',
} as const;

/** Status of a canonical event as it moves through ingestion. */
export type TriggerEventStatus =
    typeof TriggerEventStatus[keyof typeof TriggerEventStatus];

/** Outcomes recorded when an event is evaluated against a trigger. */
export const TriggerRoutingOutcome = {
    DEBOUNCED: 'DEBOUNCED',
    DISABLED: 'DISABLED',
    DUPLICATE: 'DUPLICATE',
    FAILED: 'FAILED',
    INVALID: 'INVALID',
    MATCHED: 'MATCHED',
    NO_MATCH: 'NO_MATCH',
} as const;

/** Result recorded when an event is evaluated against a trigger. */
export type TriggerRoutingOutcome =
    typeof TriggerRoutingOutcome[keyof typeof TriggerRoutingOutcome];

/** Delivery outcomes shared by server attempts and web trigger summaries. */
export const TriggerDeliveryStatus = {
    ACCEPTED: 'ACCEPTED',
    DISCARDED: 'DISCARDED',
    DUPLICATE: 'DUPLICATE',
    FAILED: 'FAILED',
    IGNORED: 'IGNORED',
    PENDING: 'PENDING',
    REPLAYED: 'REPLAYED',
} as const;

/** Delivery status recorded for trigger attempts and outcomes. */
export type TriggerDeliveryStatus =
    typeof TriggerDeliveryStatus[keyof typeof TriggerDeliveryStatus];

/** Delivery attempts grouped by a final reported outcome. */
export const FINAL_TRIGGER_DELIVERY_STATUSES: readonly TriggerDeliveryStatus[] = [
    TriggerDeliveryStatus.ACCEPTED,
    TriggerDeliveryStatus.FAILED,
    TriggerDeliveryStatus.REPLAYED,
];

/** Aggregate statuses returned after a trigger event is ingested. */
export const TriggerIngestionStatus = {
    ACCEPTED: 'ACCEPTED',
    DEBOUNCED: 'DEBOUNCED',
    DUPLICATE: 'DUPLICATE',
    FAILED: 'FAILED',
    IGNORED: 'IGNORED',
} as const;

/** Aggregate status returned after a trigger event is ingested. */
export type TriggerIngestionStatus =
    typeof TriggerIngestionStatus[keyof typeof TriggerIngestionStatus];

/** Ingestion outcomes counted as accepted or routed for summary totals. */
export const ACCEPTED_TRIGGER_INGESTION_STATUSES: readonly TriggerIngestionStatus[] = [
    TriggerIngestionStatus.ACCEPTED,
    TriggerIngestionStatus.DEBOUNCED,
];

/** Lifecycle values for a stored trigger dead-letter event. */
export const TriggerDeadLetterStatus = {
    DISCARDED: 'DISCARDED',
    PENDING: 'PENDING',
    REPLAYED: 'REPLAYED',
} as const;

/** Lifecycle state of a stored dead-letter event. */
export type TriggerDeadLetterStatus =
    typeof TriggerDeadLetterStatus[keyof typeof TriggerDeadLetterStatus];

/** Complete persisted dead-letter status vocabulary used by API validation. */
export const TRIGGER_DEAD_LETTER_STATUSES: readonly TriggerDeadLetterStatus[] =
    Object.values(TriggerDeadLetterStatus);
