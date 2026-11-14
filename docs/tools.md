# MCP and Open WebUI-managed tools

## Direct MCP

Configure MCP servers through the client's ACP `mcpServers` definitions or the
agent's private `mcp.json`. This is different from JetBrains `agent_servers`,
which registers the agent itself. The supported transports are stdio, Streamable
HTTP and SSE. Prefer Streamable HTTP for new servers.

Private `mcp.json` contains an array. HTTP/SSE entries use `type`, `name`, `url`
and `headersFrom`; stdio entries use `type`, `name`, `command`, `args` and
`envFrom`. The `*From` maps contain environment-variable names, not secret values:

```json
[
  {
    "type": "http",
    "name": "research",
    "url": "https://tools.example.org/mcp",
    "headersFrom": { "Authorization": "RESEARCH_MCP_AUTH" }
  }
]
```

Supply the complete header value through the named variable using a secret
manager. MCP authentication is independent of the Open WebUI key. Project
`.mcp.json`, hooks and environment files are not loaded automatically.

Workspace and server activation happen before startup. Approvals disclose the
command/destination and environment names. A connection grant does not approve
its tools. Local stdio runs in the selected command sandbox with a bounded,
explicit program read scope. HTTP/SSE tools execute outside that sandbox.
Local HTTP servers, including the IDE and browser, require approval for each
call except the narrowly matched IDE file-problems diagnostic. Confirmed YOLO
supplies startup/call approval automatically, including per-server
`alwaysApproveTools` decisions, unless administrator rules require approval.
It also removes the local stdio process sandbox; catalog filters and validation
remain enforced.

Catalog discovery uses the official MCP SDK. Names are namespaced, arguments are
validated against supported JSON Schema dialects, and output/cancellation are
bounded. Read-only annotations do not grant authority. A remote server can cause
effects even if the local connection is cancelled.

An optional per-server `options` object accepts exact `includeTools` and
`alwaysApproveTools` lists, `callTimeoutMs`, `maxOutputChars`, `maxFrameBytes`,
`stripImages` and `rejectFileOutput`. Unknown configuration fails closed. See
[the browser configuration](browser.md) for a complete example. Tool filtering
also excludes new tools until explicitly included. A configured output bound
truncates text with a marker; transport frame limits still reject oversized data.
For configured HTTP timeouts, a bounded health check can preserve a responsive
connection. The failed call is never retried.

Search, retrieval and memory use tools actually discovered on your server; the
agent does not invent endpoints or assume standard names. Memory writes and
other remote mutations require the applicable operation approval.

## JetBrains bridge

The client can supply its IDE MCP connection. For supported macOS IDE launchers
with the sole `stdioMcpServer` argument, a validated IDE descriptor maps to its
local SSE endpoint instead of launching another IDE process. The approval shows
the effective destination and project. Supplied authentication/project headers
are preserved without exposing their values.

This does not sandbox IDE tools. Terminal, build, run-configuration and
refactoring tools keep per-call approval outside confirmed YOLO. Only
`get_file_problems` from the recognized client-supplied bridge for the exact
workspace qualifies for automatic diagnostics. See [verification after edits](ide-diagnostics.md).

## Open WebUI-managed tasks

Enable **Open WebUI tools** in the session selector or use `/server-tools on`.
`/server-tools refresh` discovers features and tool IDs without inference;
`/server-tools off` disables delegation. This mode requires **Open WebUI 0.9.0
or newer** for its chat task status/stop endpoints and asynchronous response
format. Older versions are blocked before task creation. Newer versions are
allowed with response validation; compatibility with every release is not
guaranteed. Report failures with the Open WebUI version and redacted error.
Core coding and direct MCP do not require this mode.

The reported version must use `major.minor.patch`, optionally with a `v` prefix,
prerelease suffix or build metadata. The 0.9.0 prereleases precede the minimum;
unparseable versions cannot establish compatibility and are refused for this
mode. See the [endpoint evidence](design.md#server-task-minimum-version).

The model receives `openwebui_task` for web research, image generation, retrieval
and selected server-managed tools. Features depend on server configuration,
account permissions and model metadata. Missing private configuration is labeled
unverified; explicit disabled features are not offered. Advertised capability
alone does not prove that a tool executes successfully.

Approval covers the displayed task prompt, model, features, tool IDs, remote
scope and retained chat. Session or remembered grants cover any prompt with that
exact scope, including mutations and new chats. A change in scope, backend
version or catalog requires approval again. Development mode does not create
remote grants.
Confirmed YOLO approves tasks without a per-task decision while server tools
are enabled; it does not bypass Open WebUI’s own approvals or account policy.
`/permissions revoke-tools` revokes them; Ask each time, approval advice and
administrator rules still apply.

Open WebUI may execute multiple tools internally. These calls do **not** receive
individual ACP approval and are outside the local sandbox. Server tools may read
or mutate remote data or expose execution capabilities. Memory must be selected
explicitly. The agent does not offer the code interpreter or select a terminal.
If Open WebUI pauses for its own approval, use the linked chat; the agent does
not bypass that pause.

Each approved task creates and retains an Open WebUI chat with its explicit
prompt and results. Local project history is not copied automatically. Results
include chat/citation links and bounded previews of supported generated images.
This does not add image inputs, uploads or image editing. Delete retained chats
in Open WebUI when no longer needed.

Cancellation sends a best-effort chat stop request. It cannot undo effects or
guarantee a remote job stops. Unknown outcomes are recorded and never replayed.
Loading a session or changing models resets server tools to Off. Local round
limits do not constrain the server's internal tool loop.

If API-key endpoint restrictions are enabled, this integration also needs these
prefixes. Keep the trailing slash on `/api/v1/tools/`, which matches the
discovery request:

```text
/api/version,/api/config,/api/v1/tools/,/api/v1/chats,/api/tasks/chat,/api/v1/files
```

Preserve `/api/models` and `/api/chat/completions` and any other required entries.
These prefixes cover discovery, owned chat creation/results, task status/stop,
and generated-image content. They also cover other routes below those prefixes;
account permissions must still restrict access. No admin settings change is
performed by the agent.
