import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  validateCommandTimeout,
  utf8Prefix,
  type OutputCallback,
} from "./commands.js";
import { abortable } from "./cancel.js";

export type JobInfo = {
  id: string;
  state: "running" | "completed" | "failed" | "stopped";
  code: number | null;
  limitedOrCancelled: boolean;
  startedAt: string;
  finishedAt?: string;
  // Retained output length in characters, matching poll offsets.
  outputChars: number;
};
export type JobPoll = JobInfo & { output: string; nextOffset: number };
export type JobRunner = (
  signal: AbortSignal,
  onOutput: OutputCallback,
) => Promise<string>;
type Options = {
  timeoutMs?: number;
  signal?: AbortSignal;
  // onOutput runs at most once per progressMs with the latest running snapshot.
  progressMs?: number;
  onOutput?: (snapshot: JobPoll) => void | Promise<void>;
  onComplete?: (snapshot: JobPoll) => void | Promise<void>;
};
type Job = {
  info: JobInfo;
  output: string;
  reported: boolean;
  controller: AbortController;
  done: Promise<void>;
};
const resultSchema = z.object({
  code: z.number().int().nullable(),
  output: z.string(),
  limitedOrCancelled: z.boolean(),
});
const OUTPUT_BYTES = 100000;
const PROGRESS_MS = 1000;
const TAIL_CHARS = 2000;

// A bounded, human-readable status for client tool-call updates and notices.
// Only the output tail is included; poll_job and /jobs poll page the rest.
export function jobStatusText(snapshot: JobPoll): string {
  const start = Math.max(0, snapshot.output.length - TAIL_CHARS);
  // Do not begin the tail with the second half of a surrogate pair.
  const tail = snapshot.output.slice(start).replace(/^[\uDC00-\uDFFF]/, "");
  const ended = snapshot.finishedAt
    ? Date.parse(snapshot.finishedAt)
    : Date.now();
  const seconds = Math.max(
    0,
    Math.round((ended - Date.parse(snapshot.startedAt)) / 1000),
  );
  return [
    `Background job ${snapshot.id}: ${snapshot.state}` +
      (snapshot.state === "running" ? "" : `, exit code ${snapshot.code}`) +
      `, ${seconds}s, ${snapshot.outputChars} output characters` +
      (snapshot.limitedOrCancelled ? " (limited or cancelled)" : ""),
    start
      ? `Last ${snapshot.output.length - start} characters; /jobs poll ${snapshot.id} ${start} shows them, offset 0 shows the start:`
      : "Output:",
    tail,
  ].join("\n");
}

// A manager belongs to exactly one live ACP session. It has no persisted or
// global process registry: restoration must never restart an executed command.
export class Jobs {
  private readonly jobs = new Map<string, Job>();

  get hasRunning() {
    return [...this.jobs.values()].some((j) => j.info.state === "running");
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].map((job) => ({ ...job.info }));
  }

  // Finished jobs whose final state has not yet been reported to the model.
  // Each job is returned once, so the model need not poll for completion.
  takeFinished(): JobInfo[] {
    const result: JobInfo[] = [];
    for (const job of this.jobs.values())
      if (job.info.state !== "running" && !job.reported) {
        job.reported = true;
        result.push({ ...job.info });
      }
    return result;
  }

  private get(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown job in this session");
    return job;
  }

  poll(id: string, offset = 0): JobPoll {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid job output offset");
    const job = this.get(id);
    const start = Math.min(offset, job.output.length);
    let end = Math.min(start + 16000, job.output.length);
    // Do not split a surrogate pair at the end of a page.
    if (end < job.output.length && /[\uD800-\uDBFF]/.test(job.output[end - 1]))
      end--;
    return {
      ...job.info,
      output: job.output.slice(start, end),
      nextOffset: end,
    };
  }

  start(run: JobRunner, options: Options = {}): JobInfo {
    options.signal?.throwIfAborted();
    const timeout = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    validateCommandTimeout(timeout);
    if (
      [...this.jobs.values()].filter((j) => j.info.state === "running")
        .length >= 4
    )
      throw new Error("At most four background jobs may run in a session");
    // Retain bounded recent results; never evict a running process.
    if (this.jobs.size >= 16) {
      const oldest = [...this.jobs.values()].find(
        (j) => j.info.state !== "running",
      );
      if (oldest) this.jobs.delete(oldest.info.id);
    }
    const controller = new AbortController();
    const job: Job = {
      info: {
        id: randomUUID(),
        state: "running",
        code: null,
        limitedOrCancelled: false,
        startedAt: new Date().toISOString(),
        outputChars: 0,
      },
      controller,
      output: "",
      reported: false,
      done: Promise.resolve(),
    };
    this.jobs.set(job.info.id, job);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    // Progress is coalesced: a dev server or test run can print continuously,
    // and each client update replaces the previous one anyway.
    let progress: ReturnType<typeof setTimeout> | undefined;
    let lastProgress = 0;
    const publish = () => {
      progress = undefined;
      if (job.info.state !== "running" || !options.onOutput) return;
      lastProgress = Date.now();
      void Promise.resolve()
        .then(() =>
          options.onOutput!({
            ...job.info,
            output: job.output,
            nextOffset: job.output.length,
          }),
        )
        .catch(() => {});
    };
    const output = async (snapshot: string) => {
      if (controller.signal.aborted || job.info.state !== "running") return;
      const bytes = Buffer.from(snapshot);
      job.output = utf8Prefix(bytes, OUTPUT_BYTES);
      job.info.outputChars = job.output.length;
      if (bytes.length > OUTPUT_BYTES) controller.abort();
      if (options.onOutput && !progress) {
        const wait = Math.max(
          0,
          lastProgress + (options.progressMs ?? PROGRESS_MS) - Date.now(),
        );
        progress = setTimeout(publish, wait);
        progress.unref();
      }
    };
    job.done = Promise.resolve()
      .then(async () => {
        controller.signal.throwIfAborted();
        const raw = await run(controller.signal, output);
        if (raw.length > OUTPUT_BYTES * 8)
          throw new Error("Job result exceeds limits");
        const result = resultSchema.parse(JSON.parse(raw));
        job.output = utf8Prefix(Buffer.from(result.output), OUTPUT_BYTES);
        job.info.outputChars = job.output.length;
        job.info.code = result.code;
        job.info.limitedOrCancelled =
          result.limitedOrCancelled ||
          controller.signal.aborted ||
          Buffer.byteLength(result.output) > OUTPUT_BYTES;
        job.info.state = controller.signal.aborted
          ? "stopped"
          : result.code === 0 && !job.info.limitedOrCancelled
            ? "completed"
            : "failed";
      })
      .catch(() => {
        job.info.state = controller.signal.aborted ? "stopped" : "failed";
        job.info.limitedOrCancelled = controller.signal.aborted;
        // Never relay arbitrary runner exceptions, argv, environment or credentials.
        if (!job.output)
          job.output = controller.signal.aborted
            ? "Job stopped."
            : "Job failed to start or returned invalid output.";
        job.info.outputChars = job.output.length;
      })
      .finally(async () => {
        clearTimeout(timer);
        clearTimeout(progress);
        options.signal?.removeEventListener("abort", abort);
        job.info.finishedAt = new Date().toISOString();
        if (options.onComplete)
          try {
            await abortable(
              Promise.resolve().then(() =>
                options.onComplete!(this.poll(job.info.id)),
              ),
              AbortSignal.timeout(2000),
            );
          } catch {
            /* Completion remains recorded if the client disconnected. */
          }
      });
    // Notification failure must not create an unhandled rejection or restart work.
    void job.done.catch(() => {});
    return { ...job.info };
  }

  async stop(id: string): Promise<JobPoll> {
    const job = this.get(id);
    if (job.info.state === "running") job.controller.abort();
    await job.done;
    return this.poll(id);
  }

  async stopAll(): Promise<void> {
    const jobs = [...this.jobs.values()];
    for (const job of jobs)
      if (job.info.state === "running") job.controller.abort();
    await Promise.all(jobs.map((job) => job.done));
  }
}
