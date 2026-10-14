/**
 * @fileoverview Provides ordered bounded asynchronous mapping for pipeline workflows.
 *
 * A worker rejection does not cancel other workers; all workers settle before
 * the first rejection in worker order is propagated.
 */
/**
 * Maps items with a fixed number of workers while preserving their input order.
 * All workers settle before the first rejection in worker order is propagated.
 */
export async function mapWithConcurrency<T, Result>(
    items: readonly T[],
    concurrency: number,
    mapItem: (item: T) => Promise<Result>,
): Promise<Result[]> {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new RangeError('Concurrency must be a positive safe integer.');
    }

    const results = new Array<Result>(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await mapItem(items[index]!);
        }
    });
    const workerResults = await Promise.allSettled(workers);
    const failure = workerResults.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
        throw failure.reason;
    }
    return results;
}
