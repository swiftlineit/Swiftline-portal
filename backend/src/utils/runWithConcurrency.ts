/**
 * Runs independent work with a fixed upper bound and preserves input order.
 *
 * Every item is attempted and every started operation is awaited before the
 * first failure is rethrown. That matters for storage writes: callers must not
 * enter reconciliation while uploads are still running in the background.
 */
export async function runWithConcurrency<TInput, TResult>(
  items: readonly TInput[],
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TResult>
): Promise<TResult[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer.");
  }
  if (!items.length) return [];

  const results = new Array<TResult>(items.length);
  const errors = new Array<unknown>(items.length);
  const failed = new Array<boolean>(items.length).fill(false);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;

      try {
        results[index] = await worker(items[index] as TInput, index);
      } catch (error) {
        failed[index] = true;
        errors[index] = error;
      }
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  const firstFailedIndex = failed.findIndex(Boolean);
  if (firstFailedIndex >= 0) throw errors[firstFailedIndex];
  return results;
}
