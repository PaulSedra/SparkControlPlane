# Trigger module

The trigger module separates source-specific trigger handling from the shared
delivery and recovery path. Webhook and AIStor events enter through the event
service, scheduled occurrences enter through the scheduler, and both use the
same delivery service.

## Module structure

```text
                  triggerServices.ts
                  ├─ shared runtime
                  ├─ shared delivery
                  └─ dead-letter recovery
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
triggerEventService  triggerScheduler  triggerDeadLetterService
├─ ingestion          └─ schedule runner ├─ replay
└─ debounce                              └─ discard
          │              │              │
          └──────────────┴──────────────┘
                         ▼
                  triggerDelivery.ts
                  ├─ submit run
                  ├─ record attempt
                  ├─ record outcome
                  └─ create dead letter
```

## Responsibilities

- `triggerServices.ts` is the composition point. It creates the runtime,
  shared delivery function, and dead-letter recovery service.
- `triggerEventService.ts` handles canonical event ingestion, matching, and
  file-arrival debounce windows.
- `triggerScheduler.ts` owns timer lifecycle. `triggerScheduleRunner.ts`
  evaluates due schedule occurrences and calls the shared delivery function.
- `triggerDeadLetterService.ts` replays or discards failed deliveries without
  belonging to either event ingestion or schedule execution.
- `triggerDelivery.ts` is the common side-effect boundary for run submission,
  delivery-attempt auditing, routing outcomes, trigger outcomes, and dead-letter
  creation.
- `triggerServiceTypes.ts` contains the neutral runtime and delivery contracts
  shared by all trigger sources.

`triggerServices.ts` supplies the same delivery function to the scheduler and
event service. Shared delivery gives each trigger type the same idempotency,
audit, failure-handling, and dead-letter behavior.

Schedule evaluation, event routing, and dead-letter replay use the effective
`active` and `enabled` state from PostgreSQL. Pausing a trigger updates that
state and stops new work; it does not cancel a delivery already in progress.
Pause and Resume remain in effect during normal reads. An explicit pipeline
source refresh reconciles YAML-owned triggers and sets `enabled` back to the
value in the refreshed YAML.
