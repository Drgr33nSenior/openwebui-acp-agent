import {
  configSchema,
  endpoint,
  readJson,
  privateDir,
  saveKey,
  writeJson,
  type Config,
} from "./config.js";
import { Backend } from "./backend.js";

export interface SetupUI {
  ask(label: string, secret: boolean, signal: AbortSignal): Promise<string>;
  write(message: string): void;
}
// Small test seam for this flow; production always uses the OS credential store.
export interface SetupServices {
  previous(): Promise<Config | undefined>;
  models(
    config: Config,
    secret: string,
    signal: AbortSignal,
  ): Promise<string[]>;
  save(config: Config, secret: string): Promise<void>;
}
const services: SetupServices = {
  previous: async () => {
    const raw = await readJson("config.json");
    if (raw === undefined) return undefined;
    const result = configSchema.parse(raw);
    endpoint(result.url, "api/models");
    return result;
  },
  models: (config, secret, signal) =>
    new Backend(config, secret).models(signal),
  save: async (config, secret) => {
    await privateDir();
    await saveKey(config, secret);
    await writeJson("config.json", config);
  },
};
export async function runSetup(
  ui: SetupUI,
  signal: AbortSignal,
  store = services,
) {
  signal.throwIfAborted();
  const previous = await store.previous();
  ui.write(
    "Connect Open WebUI\nYour API key stays in your OS credential store. Press Ctrl+C to cancel.\n",
  );
  const url =
    (
      await ui.ask(
        previous
          ? `Installation URL [${previous.url}]: `
          : "Installation URL: ",
        false,
        signal,
      )
    ).trim() ||
    previous?.url ||
    "";
  endpoint(url, "api/models");
  const secret = await ui.ask("API key: ", true, signal);
  if (!secret.trim()) throw new Error("Setup requires an API key");
  // A different installation never inherits a custom credential header.
  const config = configSchema.parse({
    ...(previous?.url === url ? previous : {}),
    url,
    model: previous?.model ?? "pending",
  });
  ui.write("Checking access…\n");
  const models = await store.models(config, secret, signal);
  if (!models.length)
    throw new Error(
      "Setup found no available models. Ask your Open WebUI administrator for model access.",
    );
  config.model =
    previous?.url === url && models.includes(previous.model)
      ? previous.model
      : models[0];
  signal.throwIfAborted();
  // All input and validation are complete before persistent state changes.
  await store.save(config, secret);
  ui.write("Connected to Open WebUI. Return to your IDE and choose a model.\n");
}

export class TerminalSetupUI implements SetupUI {
  write(message: string) {
    process.stderr.write(message);
  }
  ask(label: string, secret: boolean, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!process.stdin.isTTY)
      throw new Error(
        "Setup needs the interactive terminal opened by your IDE. Choose Set up Open WebUI.",
      );
    return new Promise((resolve, reject) => {
      let value = "";
      const wasRaw = process.stdin.isRaw;
      const finish = (error?: Error) => {
        process.stdin.off("data", input);
        process.stdin.off("end", closed);
        process.stdin.off("close", closed);
        signal.removeEventListener("abort", aborted);
        process.stdin.setRawMode(wasRaw);
        process.stdin.pause();
        this.write("\n");
        if (error) reject(error);
        else resolve(value);
      };
      const closed = () => finish(new Error("Setup cancelled"));
      const aborted = () => finish(new Error("Setup cancelled"));
      const input = (bytes: Buffer) => {
        for (const character of bytes.toString("utf8")) {
          if (character === "\u0003" || character === "\u0004") {
            closed();
            return;
          }
          if (character === "\r" || character === "\n") {
            finish();
            return;
          }
          if (character === "\u007f" || character === "\b") {
            if (value.length) {
              value = value.slice(0, -1);
              this.write("\b \b");
            }
          } else if (character >= " " && character <= "~") {
            value += character;
            this.write(secret ? "*" : character);
          }
          if (value.length > (secret ? 8192 : 2048)) {
            finish(new Error("Setup input exceeds the size limit"));
            return;
          }
        }
      };
      // Disable terminal echo before showing the key prompt.
      process.stdin.setRawMode(true);
      process.stdin.on("data", input);
      process.stdin.once("end", closed);
      process.stdin.once("close", closed);
      signal.addEventListener("abort", aborted, { once: true });
      process.stdin.resume();
      this.write(label);
    });
  }
}
