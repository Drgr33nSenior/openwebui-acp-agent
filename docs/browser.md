# Browser tools through Playwright MCP

This optional package gives the agent a headless browser through a local
container. Every browser tool call requires ACP approval, including reads,
clicks and navigation. The model uses accessibility snapshots and `browser_find`;
image responses, screenshots and arbitrary-code tools are excluded.

The browser integration is separate from Open WebUI inference. It does not use
or receive an Open WebUI API key. Install the matching agent source first; an
older agent rejects the new strict `mcp.json` options.

## Versions and installation

The wrapper is in [`browser/`](../browser), outside the application's private
configuration directory. Its own package and lockfile pin:

| Component                          | Version                                                  |
| ---------------------------------- | -------------------------------------------------------- |
| Microsoft `@playwright/mcp`        | `0.0.85` (Apache-2.0)                                    |
| `playwright` and `playwright-core` | `1.66.0-alpha-2026-11-09`                                |
| Chromium headless shell            | `158.0.8127.18`, revision `1254`                         |
| Official MCP SDK                   | `1.32.2`                                                 |
| Docker base                        | Node `24.22.3` on Debian bookworm-slim, pinned by digest |

The SDK provides the bounded HTTP transport. The wrapper
uses Microsoft's public `createConnection` API with fixed settings equivalent to
`--headless --isolated --no-webmcp --block-service-workers --image-responses omit
--snapshot-mode none --timeout-navigation 20000 --timeout-action 5000
--idle-timeout 600000`. Context options also disable downloads. The API avoids
CLI environment/config-file overrides and permits HTTP Origin checks that the
inspected upstream CLI listener lacks.

The wrapper owns Chromium through Playwright's public `launch` and `newContext`
APIs and supplies that fresh, nonpersistent context to MCP. Chromium starts on
the first tool call, not during initialization or tool discovery. MCP session
termination waits for the owned browser to close; cancellation during launch
also closes a late browser. Ten minutes without MCP activity closes the session.
No persistent browser profile is used.

From a reviewed source checkout with Node and Docker Desktop installed:

```sh
cd browser
npm ci --ignore-scripts
npm test
docker compose build
docker compose up -d
npm run smoke
```

The build installs dependencies without lifecycle scripts, then runs the pinned
Playwright CLI with `PLAYWRIGHT_BROWSERS_PATH=0` and
`install --with-deps --only-shell chromium` inside the image. Chromium and FFmpeg
stay in image-local `node_modules`. No host browser is downloaded by this setup.
The base image and JavaScript dependencies are pinned; Debian runtime packages
are resolved during the image build. Build the image locally; no prebuilt image is provided.

`npm run smoke` serves a fixture on host loopback and uses Docker Desktop's
`host.docker.internal` routing. It verifies navigation, finding controls, typing,
clicking, text snapshots and six successive fresh MCP browser sessions. The
repeated sessions exercise browser cleanup under the container's existing PID
limit. It does not call public web services or make a model inference request.
This is a direct MCP smoke check; interactive ACP/IDE acceptance is separate.

Stop this package's container when it is no longer needed:

```sh
docker compose down
```

## Connect the agent

Generate the complete entry, including the canonical tool allowlist:

```sh
node config.mjs --agent
```

Merge that entry into the array in the agent's private `mcp.json`, preserving
existing entries. Its default POSIX location is
`~/.config/openwebui-acp-agent/mcp.json`, or the directory selected by
`OPENWEBUI_ACP_HOME`. This is explicit user configuration, not a project file or
JetBrains `agent_servers` entry. No credentials are needed for this single-user
loopback service. Reconnect the agent after changing the configuration.

The entry connects to `http://127.0.0.1:8931/mcp`. The strict `options` include:

- `includeTools`: exact names from [`allowed-tools.json`](../browser/allowed-tools.json).
  Unknown tools, including tools introduced by a future upstream version, are
  excluded. Code execution, evaluation, upload, browser installation, screenshots
  and PDF tools are absent.
- `alwaysApproveTools: ["browser_navigate"]`: the normal per-navigation default.
  A loopback HTTP server requires approval on **every** call regardless of this
  list or remembered tool grants. The approval includes the complete arguments,
  with secrets redacted, so the requested navigation URL is visible.
- `callTimeoutMs: 60000`: a timed-out configured HTTP call is not retried. A
  bounded ping preserves a responsive connection; an unresponsive connection
  closes. Cancellation sends MCP cancellation and closes the owned session.
- `maxOutputChars: 24000`, `maxFrameBytes: 1000000`, `stripImages: true`: bounded
  text results truncate with a marker recommending `browser_find`. Oversized
  transport frames still fail closed; truncation is not unlimited buffering.
- `rejectFileOutput: true`: hide optional `filename` fields and reject supplied
  file-output arguments before execution. Upstream snapshot/find/console/network
  tools can otherwise save explicitly named files despite `--output-dir`.

The pinned Playwright catalog declares JSON Schema 2020-12. The agent selects
the corresponding validator from its existing Ajv dependency; it keeps the
declared schema and validates arguments before execution. Older or undeclared
schemas retain the previous validator, and unknown dialects fail closed. See
[Ajv's dialect guidance](https://ajv.js.org/json-schema.html#draft-2020-12-breaking).
After building the agent and installing the wrapper dependencies,
`node test/browser-catalog.mjs` verifies the real pinned catalog through the
agent without launching Chromium. The browser CI workflow runs this check too.

Browser calls can change remote state. They are not read-only simply because
some upstream tool annotations say so. The agent closes MCP sessions at the end
of each turn; browser state survives responsive call timeouts within that turn,
not a new user turn. Closing a session does not undo a completed web action.

A development server on the Mac is reached from the browser as
`http://host.docker.internal:PORT`, not `http://localhost:PORT` (the latter points
inside the container). The MCP connection itself remains host loopback. Linux
host-service routing differs; do not assume the Mac fixture path proves Linux
host routing or native Windows support.

## Isolation and trust limits

The supplied Compose service runs as UID/GID 1000, with no capabilities, no new
privileges, a read-only root filesystem, bounded temporary filesystems, process,
memory and CPU limits, and no host workspace, home, credential, browser-profile
or Docker-socket mounts. Output and profile state are temporary. The wrapper
sets Playwright's supported `XDG_CACHE_HOME` inside its private temporary
directory before importing Playwright; the real container home remains read-only.
The browser receives the same private cache location. The wrapper
passes only named environment variables to its worker and a smaller environment
to Chromium. Provider credentials and inherited `PLAYWRIGHT_MCP_*`, `PWTEST_*`,
`DEBUG` and `NODE_OPTIONS` settings are not forwarded.

Playwright launches this Chromium with `chromiumSandbox: false`; the container
runtime is the boundary. Playwright MCP itself is not a security boundary. The
macOS agent sandbox is not applied to the container's browser or its network.
The container can make outbound Internet and LAN requests permitted by Docker
and the host network. It does not use the agent's per-host/per-port proxy approval.

The HTTP port is published only at `127.0.0.1`. The wrapper accepts only `/mcp`,
requires a loopback Host name, rejects duplicate Host headers, rejects Origin
headers and cross-site/same-site fetch metadata, and bounds JSON requests and
concurrent sessions. These checks reduce browser-origin and DNS-rebinding access;
they are **not authentication**. Other local processes, or containers explicitly
attached to this service's network, can reach the endpoint. This route is for
one trusted local OS user. Do not expose the port to a LAN, shared host or remote
proxy without adding and verifying authentication.

Tool filtering is enforced by this ACP agent, not by the raw Playwright MCP
endpoint. Another direct MCP client can see upstream tools unless it applies its
own filter. Page content can contain prompt injection. Per-call approval lets
the user inspect requested actions, but approval of a navigation or click does
not separately mediate redirects, subresources, form submissions or later
page-generated requests. Do not treat it as a complete URL exfiltration filter.

## Refresh the pinned browser package

Use explicit versions that the upstream MCP package pins together:

```sh
node refresh.mjs 0.0.85 1.66.0-alpha-2026-11-09
```

For an update, replace both arguments with the reviewed new pair. The script
checks the MCP package's declared dependencies, updates package/lock and Compose
image-tag files, installs with `--ignore-scripts`, runs wrapper tests, builds a
new local image and runs the fixture smoke in a disposable loopback-published
container. It stops only that container on completion. A failure leaves working
changes for review; it does not publish, commit, or install user configuration.

Review the new Chromium revision, tool schemas, dependency audit, Node base-image
digest and agent integration tests before accepting an update. `includeTools`
remains the same explicit allowlist; new tools do not become available merely
because the dependency changed. Refresh does not automatically update the Node
base digest or weaken container controls.

## References

- [Microsoft MCP pinned source](https://github.com/microsoft/playwright-mcp/tree/v0.0.85).
- [Playwright browser installation](https://playwright.dev/docs/browsers#hermetic-install).
- [Testing and compatibility](verification.md).
