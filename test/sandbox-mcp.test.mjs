import test from "node:test";
import assert from "node:assert/strict";
import { SandboxMcpTransport } from "../dist/sandbox-mcp.js";

for (const badChunks of [
  [Buffer.alloc(200000, "x"), Buffer.alloc(60001, "x")],
  [Buffer.from("invalid JSON\n")],
]) {
  test(`MCP framing failure is terminal before process cleanup (${badChunks.length} chunks)`, async () => {
    const transport = new SandboxMcpTransport(
      "unused",
      [],
      { root: "/unused", mode: "workspace", network: async () => false },
      new AbortController().signal,
    );
    let stops = 0,
      writes = 0;
    // Keep process cleanup pending to deterministically reproduce queued data
    // arriving after stop(). Real OS enforcement remains in mcp.test.mjs.
    transport.process = {
      stop() {
        stops++;
      },
      child: {
        stdin: {
          write() {
            writes++;
          },
        },
      },
    };
    const messages = [],
      errors = [];
    transport.onmessage = (message) => messages.push(message);
    transport.onerror = (error) => errors.push(error.message);
    const valid = Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    transport.receive(valid);
    assert.equal(messages.length, 1);
    for (const chunk of badChunks) transport.receive(chunk);
    // SDK ReadBuffer clears itself on overflow. Without a terminal state,
    // this later complete response would be delivered despite the violation.
    transport.receive(valid);
    transport.receive(badChunks[0]);
    assert.equal(messages.length, 1);
    assert.deepEqual(errors, ["MCP frame invalid or oversized"]);
    assert.equal(stops, 1);
    await assert.rejects(
      transport.send({ jsonrpc: "2.0", id: 2, method: "ping" }),
      /failed/,
    );
    assert.equal(writes, 0);
  });
}
