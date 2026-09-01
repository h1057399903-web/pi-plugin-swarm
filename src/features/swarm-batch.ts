/**
 * A small, framework-neutral batch scheduler inspired by Kimi's swarm runner.
 * MIT attribution: scheduling behaviour is adapted from Kimi Code's
 * agentRunBatch.ts and agent-swarm.ts. This file intentionally has no Kimi
 * or application-internal imports.
 */

export type SwarmTaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "rate_limited"
  /** Waiting for its rate-limit retry deadline; this is a transient status. */
  | "suspended";

export interface SwarmBatchResult<T, R> {
  readonly index: number;
  readonly task: T;
  /** A completed batch result is always terminal; suspended is progress-only. */
  readonly status: Exclude<SwarmTaskStatus, "suspended">;
  readonly attempts: number;
  readonly value?: R;
  readonly error?: unknown;
}

type SwarmProgressResult<T, R> = Omit<SwarmBatchResult<T, R>, "status"> & {
  readonly status: SwarmTaskStatus;
};

export interface SwarmBatchProgress<T, R> {
  readonly results: readonly SwarmProgressResult<T, R>[];
  readonly active: number;
  readonly queued: number;
  readonly completed: number;
  readonly capacity: number;
}

export interface SwarmLaunchContext {
  readonly index: number;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export type SwarmLauncher<T, R> = (task: T, context: SwarmLaunchContext) => Promise<R> | R;

export interface SwarmBatchClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delay: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface SwarmBatchOptions<T, R> {
  /** Falls back to callerConcurrency, then the number of tasks. */
  readonly maxConcurrency?: number;
  readonly callerConcurrency?: number;
  readonly initialLaunchLimit?: number;
  readonly launchStaggerMs?: number;
  readonly timeoutMs?: number;
  /** Number of requeues after the first attempt. */
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  readonly capacityRecoveryMs?: number;
  /** Return true for a successful-looking launcher result that means rate limit. */
  readonly isRateLimitedResult?: (result: R, context: SwarmLaunchContext) => boolean;
  readonly isRateLimitedError?: (error: unknown, context: SwarmLaunchContext) => boolean;
  readonly signal?: AbortSignal;
  readonly clock?: SwarmBatchClock;
  readonly onProgress?: (progress: SwarmBatchProgress<T, R>) => void;
}

type Timer = unknown;
type State<T, R> = {
  index: number;
  task: T;
  status: SwarmTaskStatus;
  attempts: number;
  readyAt: number;
  result?: SwarmBatchResult<T, R>;
};

const realClock: SwarmBatchClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const positive = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

export class SwarmBatch<T, R> {
  private readonly states: State<T, R>[];
  private readonly clock: SwarmBatchClock;
  private readonly maxConcurrency: number;
  private readonly initialLimit: number;
  private readonly staggerMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly recoveryMs: number;
  private readonly options: SwarmBatchOptions<T, R>;
  private readonly active = new Map<number, AbortController>();
  private readonly timers = new Set<Timer>();
  private wakeTimer?: Timer;
  private capacity: number;
  private nextLaunchAt = 0;
  private launchCount = 0;
  private lastRateLimitAt = -Infinity;
  private lastRecoveryAt = -Infinity;
  private started = false;
  private aborting = false;
  private finished = false;
  private resolve!: (results: SwarmBatchResult<T, R>[]) => void;
  private abortListener?: () => void;

  constructor(
    tasks: readonly T[],
    private readonly launcher: SwarmLauncher<T, R>,
    options: SwarmBatchOptions<T, R> = {},
  ) {
    if (tasks.length > 128) throw new RangeError("Swarm batches may contain at most 128 tasks.");
    this.options = options;
    this.clock = options.clock ?? realClock;
    this.maxConcurrency = positive(options.maxConcurrency ?? options.callerConcurrency ?? tasks.length, Math.max(1, tasks.length));
    this.initialLimit = Math.min(positive(options.initialLaunchLimit ?? 5, 5), this.maxConcurrency);
    this.staggerMs = Math.max(0, options.launchStaggerMs ?? 700);
    this.timeoutMs = Math.max(0, options.timeoutMs ?? 0);
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 3));
    this.retryBaseMs = positive(options.retryBaseMs ?? 3000, 3000);
    this.recoveryMs = positive(options.capacityRecoveryMs ?? 180_000, 180_000);
    this.capacity = this.maxConcurrency;
    this.states = tasks.map((task, index) => ({ index, task, status: "queued", attempts: 0, readyAt: 0 }));
  }

  run(): Promise<SwarmBatchResult<T, R>[]> {
    if (this.started) throw new Error("SwarmBatch.run() can only be called once.");
    this.started = true;
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.abortListener = () => this.abort();
      if (this.options.signal?.aborted) this.abort();
      else this.options.signal?.addEventListener("abort", this.abortListener!, { once: true });
      this.emit();
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.finished) return;
    if (this.states.every((state) => state.result)) return this.finish();
    if (this.aborting) { this.emit(); return; }
    this.recover();
    const now = this.clock.now();
    // A retry is suspended until its exact backoff deadline. The wake timer
    // brings it back into the runnable queue; never launch it early.
    for (const state of this.states) {
      if (!state.result && state.status === "suspended" && state.readyAt <= now) state.status = "queued";
    }
    // scheduler state is intentionally synchronous up to launcher invocation
    while (this.active.size < this.capacity) {
      const state = this.states.find((item) => !item.result && item.status === "queued" && item.readyAt <= now);
      if (!state) break;
      if (this.launchCount >= this.initialLimit && now < this.nextLaunchAt) break;
      this.launch(state);
      this.launchCount += 1;
      this.nextLaunchAt = now + this.staggerMs;
      if (this.active.size >= this.initialLimit && this.staggerMs === 0) continue;
      if (this.active.size >= this.initialLimit) break;
    }
    this.armNextWakeup();
    this.emit();
  }

  private launch(state: State<T, R>): void {
    state.status = "starting";
    state.attempts += 1;
    const context: SwarmLaunchContext = { index: state.index, attempt: state.attempts, signal: new AbortController().signal };
    const controller = new AbortController();
    (context as { signal: AbortSignal }).signal = controller.signal;
    this.active.set(state.index, controller);
    state.status = "running";
    this.emit();
    void this.withTimeout(() => this.launcher(state.task, context), controller).then(
      (value) => this.outcome(state, context, value),
      (error) => this.failure(state, context, error),
    );
  }

  private async withTimeout(fn: () => Promise<R> | R, controller: AbortController): Promise<R> {
    const signal = controller.signal;
    if (!this.timeoutMs) {
      if (signal.aborted) throw signal.reason ?? new Error("Aborted");
      return fn();
    }
    return new Promise<R>((resolve, reject) => {
      let done = false;
      const timer = this.addTimer(() => {
        if (!done) {
          done = true;
          signal.removeEventListener("abort", onAbort);
          controller.abort(new Error("Task timed out."));
          reject(new Error("Task timed out."));
        }
      }, this.timeoutMs);
      const settle = (callback: () => void) => {
        if (done) return;
        done = true;
        this.cancelTimer(timer);
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => settle(() => reject(signal.reason ?? new Error("Aborted")));
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(fn).then((value) => settle(() => resolve(value)), (error) => settle(() => reject(error)));
    });
  }

  private outcome(state: State<T, R>, context: SwarmLaunchContext, value: R): void {
    if (!this.active.delete(state.index) || this.finished) return;
    if (this.aborting) {
      state.status = "aborted";
      state.result = { index: state.index, task: state.task, status: "aborted", attempts: state.attempts, error: "Batch aborted." };
      return this.schedule();
    }
    if (this.options.isRateLimitedResult?.(value, context)) return this.rateLimit(state);
    state.status = "completed";
    state.result = { index: state.index, task: state.task, status: "completed", attempts: state.attempts, value };
    this.schedule();
  }

  private failure(state: State<T, R>, context: SwarmLaunchContext, error: unknown): void {
    if (!this.active.delete(state.index) || this.finished) return;
    if (this.aborting) {
      state.status = "aborted";
      state.result = { index: state.index, task: state.task, status: "aborted", attempts: state.attempts, error: "Batch aborted." };
      return this.schedule();
    }
    if (this.options.isRateLimitedError?.(error, context)) return this.rateLimit(state);
    state.status = "failed";
    state.result = { index: state.index, task: state.task, status: "failed", attempts: state.attempts, error };
    this.schedule();
  }

  private rateLimit(state: State<T, R>): void {
    const now = this.clock.now();
    if (state.attempts > this.maxRetries) {
      state.status = "rate_limited";
      state.result = { index: state.index, task: state.task, status: "rate_limited", attempts: state.attempts, error: "Rate limit retry budget exhausted." };
    } else {
      // Keep retrying work out of the runnable queue. It remains visible to
      // progress observers while its wake timer is pending.
      state.status = "suspended";
      state.readyAt = now + this.retryBaseMs * 2 ** (state.attempts - 1);
    }
    this.lastRateLimitAt = now;
    this.capacity = Math.max(1, this.capacity - 1);
    this.nextLaunchAt = Math.max(this.nextLaunchAt, now + this.retryBaseMs);
    this.schedule();
  }

  private recover(): void {
    const now = this.clock.now();
    if (this.lastRateLimitAt > -Infinity && now - Math.max(this.lastRecoveryAt, this.lastRateLimitAt) >= this.recoveryMs && this.capacity < this.maxConcurrency) {
      this.capacity += 1;
      this.lastRecoveryAt = now;
    }
  }

  private armNextWakeup(): void {
    if (this.finished || this.wakeTimer !== undefined) return;
    const queued = this.states.filter((s) => !s.result && (s.status === "queued" || s.status === "suspended"));
    if (!queued.length || this.active.size >= this.capacity) return;
    const now = this.clock.now();
    const readyAt = queued.reduce((at, s) => Math.min(at, s.readyAt), Number.POSITIVE_INFINITY);
    const next = Math.max(this.nextLaunchAt, readyAt);
    if (!Number.isFinite(next)) return;
    this.wakeTimer = this.addTimer(() => { this.wakeTimer = undefined; this.schedule(); }, Math.max(0, next - now));
  }

  private addTimer(callback: () => void, delay: number): Timer {
    let handle: Timer;
    handle = this.clock.setTimeout(() => { this.timers.delete(handle); callback(); }, Math.max(0, delay));
    this.timers.add(handle);
    return handle;
  }

  private cancelTimer(handle: Timer): void {
    this.clock.clearTimeout(handle);
    this.timers.delete(handle);
    if (this.wakeTimer === handle) this.wakeTimer = undefined;
  }

  private abort(): void {
    if (this.finished || this.aborting) return;
    this.aborting = true;
    for (const [index, controller] of this.active) {
      this.states[index].status = "aborted";
      controller.abort(this.options.signal?.reason ?? new Error("Aborted"));
    }
    for (const state of this.states) if (!state.result && !this.active.has(state.index)) {
      state.result = { index: state.index, task: state.task, status: "aborted", attempts: state.attempts, error: "Batch aborted." };
      state.status = "aborted";
    }
    for (const timer of this.timers) this.clock.clearTimeout(timer);
    this.timers.clear();
    this.wakeTimer = undefined;
    if (this.active.size === 0) this.finish(); else this.emit();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const timer of this.timers) this.clock.clearTimeout(timer);
    this.timers.clear();
    this.wakeTimer = undefined;
    if (this.options.signal && this.abortListener) this.options.signal.removeEventListener("abort", this.abortListener);
    this.resolve(this.states.map((state) => state.result!));
  }

  private emit(): void {
    if (!this.options.onProgress) return;
    const results: SwarmProgressResult<T, R>[] = this.states.map((s) => s.result ?? { index: s.index, task: s.task, status: s.status, attempts: s.attempts });
    this.options.onProgress({ results, active: this.active.size, queued: this.states.filter((s) => !s.result && (s.status === "queued" || s.status === "suspended")).length, completed: this.states.filter((s) => s.result).length, capacity: this.capacity });
  }
}

export function runSwarmBatch<T, R>(tasks: readonly T[], launcher: SwarmLauncher<T, R>, options?: SwarmBatchOptions<T, R>): Promise<SwarmBatchResult<T, R>[]> {
  return new SwarmBatch(tasks, launcher, options).run();
}
