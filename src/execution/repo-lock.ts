/**
 * In-memory async mutex keyed by client_id. Ensures only one pipeline at a
 * time is actively driving the Execution agent for a given client repo —
 * setupExecutionEnvironment + runExecution, or rehydrateExecutionContext +
 * resumeExecution. Two pipelines at `awaiting_input` for the same client
 * are still possible (the first pipeline pauses, the second starts), but
 * the mutex makes sure their *active* phases never overlap.
 *
 * The lock lives in-process. A server restart wipes it, but persisted
 * pipeline state in Supabase is fine — operators can retry. When we move
 * off a single Fastify process this becomes a Postgres advisory lock.
 */
const holders = new Map<string, Promise<unknown>>();

export async function withClientRepoLock<T>(
  clientId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const head = holders.get(clientId) ?? Promise.resolve();
  const tail: Promise<T> = head.catch(() => undefined).then(() => fn());
  holders.set(clientId, tail);
  tail.finally(() => {
    if (holders.get(clientId) === tail) holders.delete(clientId);
  });
  return tail;
}
