import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { startSandbox, type SandboxRun } from "./sandbox.js";

// Uses the official SDK's framing/validation with our process owner. No shell,
// environment-file loading, inherited agent credentials or unbounded line buffer.
export class SandboxMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private process?: Awaited<ReturnType<typeof startSandbox>>;
  private buffer = new ReadBuffer({ maxBufferSize: 256000 });
  private failed = false;
  constructor(
    private executable: string,
    private args: string[],
    private run: SandboxRun,
    private signal: AbortSignal,
  ) {}
  async start() {
    if (this.process) throw new Error("MCP transport already started");
    this.process = await startSandbox(
      this.executable,
      this.args,
      this.run,
      this.signal,
    );
    let stderrBytes = 0;
    this.process.child.stderr!.on("data", (b: Buffer) => {
      // Drain but never disclose MCP startup diagnostics or credentials.
      if ((stderrBytes += b.length) > 100000) this.process?.stop();
    });
    this.process.child.stdout!.on("data", (b: Buffer) => {
      this.receive(b);
    });
    this.process.child.stdin!.on("error", () =>
      this.onerror?.(new Error("MCP input closed")),
    );
    void this.process.done.then((r) => {
      if (r.error) this.onerror?.(new Error(r.error));
      this.buffer.clear();
      this.onclose?.();
    });
  }
  private receive(chunk: Buffer) {
    // stop() terminates the owned process asynchronously. Already queued pipe
    // data must never resurrect this stream after ReadBuffer clears on error.
    if (this.failed) return;
    try {
      this.buffer.append(chunk);
      let message;
      while ((message = this.buffer.readMessage())) this.onmessage?.(message);
    } catch {
      this.failed = true;
      this.buffer.clear();
      this.process?.stop();
      this.onerror?.(new Error("MCP frame invalid or oversized"));
    }
  }
  async send(message: JSONRPCMessage) {
    if (!this.process || this.failed)
      throw new Error("MCP transport not started or failed");
    const line = serializeMessage(message);
    if (Buffer.byteLength(line) > 256000)
      throw new Error("MCP message too large");
    await new Promise<void>((resolve, reject) => {
      this.process!.child.stdin!.write(line, (e) =>
        e ? reject(new Error("MCP input closed")) : resolve(),
      );
    });
  }
  async close() {
    this.process?.stop();
    await this.process?.done;
  }
}
