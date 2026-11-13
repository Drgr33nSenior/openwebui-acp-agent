#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { runSetup, TerminalSetupUI } from "./setup.js";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createAgent } from "./agent.js";
import { config, key, logout, directory } from "./config.js";
import { Backend } from "./backend.js";
import { trust, changeTrust, root } from "./workspace.js";
import { sandboxDiagnostics } from "./sandbox.js";
import { PolicyError } from "./policy.js";
export function mode(args: string[]) {
  if (
    args.includes("--setup") ||
    args.includes("login") ||
    args.includes("--login")
  )
    return "login";
  return args[0] ?? "acp";
}
async function main() {
  const args = process.argv.slice(2);
  switch (mode(args)) {
    case "acp": {
      const agent = createAgent();
      const connection = agent.app.connect(
        ndJsonStream(
          Writable.toWeb(process.stdout),
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
          { maxMessageBytes: 2_000_000 },
        ),
      );
      const stop = () => connection.close();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      await connection.closed;
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      await agent.close();
      return;
    }
    case "login": {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        await runSetup(
          new TerminalSetupUI(),
          AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]),
        );
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
      return;
    }
    case "logout":
      await logout();
      process.stderr.write(
        "Signed out; stored credential removed. Complete IDE setup to sign in again. Remove any externally supplied OPENWEBUI_API_KEY before reconnecting.\n",
      );
      return;
    case "models":
    case "doctor":
    case "status": {
      const sandbox = await sandboxDiagnostics(mode(args) === "doctor");
      const c = await config();
      const b = new Backend(c, await key(c));
      const models = await b.models(AbortSignal.timeout(c.timeoutMs));
      process.stdout.write(
        JSON.stringify({
          backend: c.url,
          model: c.model,
          models,
          storage: directory,
          sandbox,
          diagnostic:
            "Model discovery only; inference and tool compatibility unverified",
        }) + "\n",
      );
      return;
    }
    case "trust": {
      if (args[1] === "revoke" || args[1] === "allow") {
        if (!args[2]) throw new Error("Supply exact workspace path");
        const c = await config();
        await changeTrust(await root(args[2]), c.url, args[1] === "allow");
      } else process.stdout.write(JSON.stringify(await trust()) + "\n");
      return;
    }
    default:
      throw new Error(
        "Commands: acp, login, logout, models, status, doctor, trust [allow|revoke PATH]",
      );
  }
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  if (
    error instanceof PolicyError ||
    /^(Run login|Setup|Choose|Signed out|Use an HTTPS|Connection failed|Authentication|Access denied|Endpoint or model|Rate limited|Backend failed|Configuration directory|Persistent storage|Commands:|Supply exact|Unsafe application|Trust store)/.test(
      message,
    )
  )
    process.stderr.write(message + "\n");
  process.stderr.write(
    "Open WebUI agent failed. Check setup, secure storage, URL/API permissions, and command usage. Credentials and raw errors are withheld.\n",
  );
  process.exitCode = 1;
});
