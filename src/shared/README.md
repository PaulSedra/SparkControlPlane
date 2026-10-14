# Shared contracts

`src/shared/` contains serializable contracts shared across server and browser
boundaries. Pipeline API records are defined in
`pipelineRegistryTypes.ts`. Status values are separated by domain under
`status/`.

## Status modules

| Module                   | Contract                                                             |
|--------------------------|----------------------------------------------------------------------|
| `status/run.ts`          | Pipeline run lifecycle values                                        |
| `status/node.ts`         | Node outcomes and terminal run-to-node projection                    |
| `status/trigger.ts`      | Trigger lifecycle values                                             |
| `status/execution.ts`    | Spark operation and CLI supervisor vocabularies, with distinct types |
| `status/deployment.ts`   | Deployment state values                                              |
| `status/presentation.ts` | Shared visual states and conversions from domain statuses            |

Cancellation has a separate visual state from failure. For legacy canceled
runs, a `FAILED` node without a completion time is presented as canceled; a
completed `FAILED` node remains failed.

The `node.ts` projection may depend on run contracts. Run contracts do not
depend on node or presentation modules. Trigger contracts remain independent
of run and node lifecycles, while presentation adapters may depend on domain
contracts.

Persisted status values are shared with PostgreSQL and API schemas. Changes to
those values affect storage and browser consumers together.
