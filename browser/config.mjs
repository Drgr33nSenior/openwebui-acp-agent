import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const includeTools = JSON.parse(
  await readFile(new URL("./allowed-tools.json", import.meta.url), "utf8"),
);
const format = process.argv[2] ?? "--agent";
if (process.argv.length > 3 || !["--agent", "--qwen-code"].includes(format)) {
  console.error("Usage: node config.mjs [--agent|--qwen-code]");
  process.exit(2);
}
const result =
  format === "--agent"
    ? [
        {
          type: "http",
          name: "browser",
          url: "http://127.0.0.1:8931/mcp",
          headersFrom: {},
          options: {
            includeTools,
            alwaysApproveTools: ["browser_navigate"],
            maxOutputChars: 24000,
            callTimeoutMs: 60000,
            maxFrameBytes: 1000000,
            stripImages: true,
            rejectFileOutput: true,
          },
        },
      ]
    : {
        mcpServers: {
          browser: {
            command: process.execPath,
            args: [
              fileURLToPath(new URL("./index.mjs", import.meta.url)),
              "--stdio",
            ],
            includeTools,
            trust: false,
            timeout: 60000,
          },
        },
      };
console.log(JSON.stringify(result, null, 2));
