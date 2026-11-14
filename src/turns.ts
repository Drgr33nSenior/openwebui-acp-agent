import { RequestError, type PromptResponse } from "@agentclientprotocol/sdk";
import { abortable } from "./cancel.js";

export type PromptMode = "interrupt" | "queue";
export const MAX_QUEUED_PROMPTS = 10;

type Entry = {
  abort: AbortController;
  ready: Promise<void>;
  start: () => void;
};

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
  private startNext() {
    if (this.active) return;
    this.active = this.waiting.shift();
    this.active?.start();
  }
  async run(
    mode: PromptMode,
    signal: AbortSignal,
    turn: (
      abort: AbortController,
      signal: AbortSignal,
    ) => Promise<PromptResponse>,
  ): Promise<PromptResponse> {
    if (signal.aborted) return { stopReason: "cancelled" };
    if (mode === "interrupt") this.cancel();
    else if (this.queued >= MAX_QUEUED_PROMPTS)
      throw RequestError.invalidParams(
        undefined,
        `Prompt queue is full (${MAX_QUEUED_PROMPTS} waiting). Wait for a turn to finish or Stop to cancel active and queued prompts.`,
      );
    let start!: () => void;
    const ready = new Promise<void>((resolve) => {
      start = resolve;
    });
    const entry: Entry = {
      abort: new AbortController(),
      ready,
      start,
    };
    const combined = AbortSignal.any([signal, entry.abort.signal]);
    this.waiting.push(entry);
    this.startNext();
    try {
      try {
        await abortable(entry.ready, combined);
        combined.throwIfAborted();
      } catch (error) {
        if (combined.aborted) return { stopReason: "cancelled" };
        throw error;
      }
      const result = await turn(entry.abort, combined);
      return combined.aborted ? { stopReason: "cancelled" } : result;
    } finally {
      if (this.active === entry) this.active = undefined;
      else this.waiting = this.waiting.filter((value) => value !== entry);
      // Release the readiness listener even for an individually cancelled waiter.
      entry.start();
      this.startNext();
    }
  }
}
