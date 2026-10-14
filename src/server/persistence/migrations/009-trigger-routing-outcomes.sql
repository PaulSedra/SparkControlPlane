ALTER TABLE trigger_routing_decisions
    DROP CONSTRAINT IF EXISTS trigger_routing_decisions_outcome_check;

ALTER TABLE trigger_routing_decisions
    ADD CONSTRAINT trigger_routing_decisions_outcome_check CHECK (
        outcome IN (
            'MATCHED', 'NO_MATCH', 'DISABLED', 'INVALID', 'DUPLICATE',
            'DEBOUNCED', 'FAILED'
        )
    );
