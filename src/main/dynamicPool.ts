/**
 * Bounded-concurrency worker pool that accepts tasks dynamically (unlike
 * `runWithConcurrency`, which requires a fully built array up front).
 *
 * The pool starts at most `capacity` tasks at a time. New tasks enqueued while
 * the pool is busy queue up. When a task completes, the next queued task (if
 * any) starts immediately. `close()` returns a promise that resolves once all
 * enqueued tasks have completed; further enqueues after `close()` is invoked
 * are still accepted only if they happen synchronously before the resolver
 * fires (typical use: enqueue everything, then await close()).
 *
 * Per-task errors are NOT caught by the pool — each task is expected to
 * handle (or rethrow) its own errors. The pool only tracks completion, not
 * success/failure.
 */
export class DynamicPool {
  private inFlight = 0
  private queue: Array<() => Promise<void>> = []
  private capacity: number
  private allDoneResolvers: Array<() => void> = []
  private closed = false

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity)
  }

  enqueue(task: () => Promise<void>): void {
    this.queue.push(task)
    this.tryStart()
  }

  private tryStart(): void {
    while (this.inFlight < this.capacity && this.queue.length > 0) {
      const task = this.queue.shift()!
      this.inFlight++
      // Swallow any rejection from the task itself — the pool only tracks
      // completion, not success. Tasks are expected to handle their own
      // errors; this is defense in depth so a stray throw can't leak as an
      // unhandled rejection.
      task()
        .catch(() => undefined)
        .finally(() => {
          this.inFlight--
          this.tryStart()
          this.maybeResolveAllDone()
        })
    }
  }

  private maybeResolveAllDone(): void {
    if (!this.closed) return
    if (this.inFlight > 0 || this.queue.length > 0) return
    const resolvers = this.allDoneResolvers
    this.allDoneResolvers = []
    for (const r of resolvers) r()
  }

  /**
   * Mark the pool closed (no more tasks will be added) and return a promise
   * that resolves when every enqueued task has completed.
   */
  close(): Promise<void> {
    this.closed = true
    if (this.inFlight === 0 && this.queue.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.allDoneResolvers.push(resolve)
    })
  }
}
