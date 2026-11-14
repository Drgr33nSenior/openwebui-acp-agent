import { RequestError, type PromptResponse } from "@agentclientprotocol/sdk";
import { abortable } from "./cancel.js";

export type PromptMode = "interrupt" | "queue" | "steer";
export const promptModes = ["interrupt", "queue", "steer"] as const;
export const MAX_QUEUED_PROMPTS = 10;

type Outcome =
  { kind: "start" } | { kind: "absorbed"; result: Promise<PromptResponse> };

type Entry = {
  abort: AbortController;
  ready: Promise<Outcome>;
  settle: (outcome: Outcome) => void;
  // Present only for steer-mode prompts that may join the active turn.
  steer?: unknown;
  result: Promise<PromptResponse>;
  finish: (result: Promise<PromptResponse>) => void;
};

export type SteeringCandidate = {
  payload: unknown;
  // Atomically removes the prompt from the waiting queue and ties its response
  // to the active turn. Returns false if it was cancelled or already started.
  take: () => boolean;
};

const cancelled: PromptResponse = { stopReason: "cancelled" };
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// One scheduler per session. Reservations precede every await; the active slot
// remains occupied until the handler's tools, transcript and cleanup finish.
export class Turns {
  private active?: Entry;
  private waiting: Entry[] = [];

  get queued() {
    return this.waiting.length;
  }
  get busy() {
    return this.active !== undefined;
  }
  cancel() {
    this.active?.abort.abort();
    this.cancelWaiting();
  }
  cancelWaiting() {
    for (const entry of this.waiting.splice(0)) entry.abort.abort();
  }
  // Resolves once the active turn and every waiting turn have finished.
  async drain() {
    while (this.active || this.waiting.length) {
      const pending = this.active ?? this.waiting[0]!;
      // run() settles this in the same synchronous cleanup that frees the slot.
      await pending.result.catch(() => {});
    }
  }
  // Steering prompts waiting at the front of the queue, in arrival order. The
  // active turn decides at a safe point whether to absorb each one.
  steering(): SteeringCandidate[] {
    const active = this.active;
    const result: SteeringCandidate[] = [];
    for (const entry of this.waiting) {
      if (entry.steer === undefined) break;
      result.push({
        payload: entry.steer,
        take: () => {
          const index = this.waiting.indexOf(entry);
          if (
            !active ||
            this.active !== active ||
            index < 0 ||
            entry.abort.signal.aborted ||
            // Preserve arrival order: only the oldest waiting prompt may join.
            index !== 0
          )
            return false;
          this.waiting.splice(index, 1);
          entry.settle({ kind: "absorbed", result: active.result });
          return true;
        },
      });
    }
    return result;
  }
  private startNext() {
    if (this.active) return;
    this.active = this.waiting.shift();
    this.active?.settle({ kind: "start" });
  }
  async run(
    mode: PromptMode,
    signal: AbortSignal,
    turn: (
      abort: AbortController,
      signal: AbortSignal,
    ) => Promise<PromptResponse>,
    steer?: unknown,
  ): Promise<PromptResponse> {
    if (signal.aborted) return cancelled;
    if (mode === "interrupt") this.cancel();
    else if (this.queued >= MAX_QUEUED_PROMPTS)
      throw RequestError.invalidParams(
        undefined,
        `Prompt queue is full (${MAX_QUEUED_PROMPTS} waiting). Wait for a turn to finish or Stop to cancel active and queued prompts.`,
      );
    const ready = deferred<Outcome>();
    const result = deferred<PromptResponse>();
    // Absorbed prompts may never observe a failed turn; avoid unhandled rejections.
    result.promise.catch(() => {});
    const entry: Entry = {
      abort: new AbortController(),
      ready: ready.promise,
      settle: ready.resolve,
      ...(mode === "steer" && steer !== undefined ? { steer } : {}),
      result: result.promise,
      finish: result.resolve,
    };
    const combined = AbortSignal.any([signal, entry.abort.signal]);
    this.waiting.push(entry);
    this.startNext();
    let outcome: Promise<PromptResponse> = Promise.resolve(cancelled);
    try {
      let started: Outcome;
      try {
        started = await abortable(entry.ready, combined);
        combined.throwIfAborted();
      } catch (error) {
        if (combined.aborted) return cancelled;
        throw error;
      }
      if (started.kind === "absorbed") {
        // The message joined the active turn; its response mirrors that turn.
        // Cancelling only this request does not stop the active turn.
        try {
          return await abortable(started.result, combined);
        } catch (error) {
          if (combined.aborted) return cancelled;
          throw error;
        }
      }
      outcome = turn(entry.abort, combined).then((value) =>
        combined.aborted ? cancelled : value,
      );
      return await outcome;
    } finally {
      entry.finish(outcome);
      if (this.active === entry) this.active = undefined;
      else this.waiting = this.waiting.filter((value) => value !== entry);
      // Release the readiness listener even for an individually cancelled waiter.
      entry.settle({ kind: "start" });
      this.startNext();
    }
  }
}
