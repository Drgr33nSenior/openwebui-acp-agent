import {
  RequestError,
  type AuthMethod,
  type ClientCapabilities,
} from "@agentclientprotocol/sdk";
import { Backend, BackendHttpError } from "./backend.js";
import { config, key } from "./config.js";
import { fileURLToPath } from "node:url";

export const SETUP_ID = "login";
export const SETUP_ARGS = ["--setup"];
export function authMethods(capabilities: ClientCapabilities): AuthMethod[] {
  const method = {
    id: SETUP_ID,
    name: "Set up Open WebUI",
    description:
      "Enter your installation URL and API key in the IDE’s setup terminal. The key is stored in your OS credential store.",
  };
  if (capabilities.auth?.terminal === true)
    return [{ ...method, type: "terminal", args: [...SETUP_ARGS] }];
  // Verified compatibility with JetBrains' AcpTerminalAuthMetadata and Air's
  // LegacyTerminalAuthMetadata. This is an opt-in extension, not ACP v2.
  if (capabilities._meta?.["terminal-auth"] === true)
    return [
      {
        ...method,
        _meta: {
          "terminal-auth": {
            // This client replaces the normal launch arguments. Include our
            // entrypoint so an absolute Node command works without PATH lookup.
            // The CLI also accepts this when an older launcher appends it.
            args: [
              fileURLToPath(new URL("./cli.js", import.meta.url)),
              ...SETUP_ARGS,
            ],
            env: {},
            label: "Set up Open WebUI",
          },
        },
      },
    ];
  return [];
}
export function authRequired(
  capabilities: ClientCapabilities,
  explanation = "",
) {
  return RequestError.authRequired(
    undefined,
    (explanation ? explanation + " " : "") +
      (authMethods(capabilities).length
        ? "Choose “Set up Open WebUI” in your IDE to connect or replace an expired API key."
        : "This client does not advertise terminal authentication. Use a client with setup support, or see the documented manual-login fallback."),
  );
}
export async function authenticatedBackend(capabilities: ClientCapabilities) {
  let c;
  try {
    c = await config();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Setup required:"))
      throw authRequired(capabilities);
    throw error;
  }
  let secret;
  try {
    secret = await key(c);
  } catch {
    throw authRequired(capabilities);
  }
  return new Backend(c, secret);
}
export function rethrowAuthentication(
  error: unknown,
  capabilities: ClientCapabilities,
): never {
  if (error instanceof BackendHttpError && error.status === 401)
    throw authRequired(capabilities);
  throw error;
}
