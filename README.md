# Open WebUI ACP Agent (unofficial)

A local TypeScript coding agent for ACP v1 clients. It runs a model/tool loop against an Open WebUI installation, with workspace consent and separate approval for edits, commands and MCP calls. It is model independent and does not require another coding-agent runtime or a JetBrains companion plugin.

Open WebUI supplies the model catalog and advertised model controls. The agent uses the returned model IDs and supported metadata rather than assumptions about a model family. A model must provide usable function calling for the coding workflow. Advertised server features do not enable local capabilities or bypass permissions. Contributor guidance is in [AGENTS.md](AGENTS.md).

**Source preview; package release is blocked.** Version 0.3.0 includes administrator rules, optional approval advice, scoped tool approvals, Open WebUI-managed tasks and metadata-driven reasoning selection. Real macOS and Ubuntu VM enforcement tests pass; the runtime/Zod advisory is remediated by a tested compatibility pin and bundled dependency tree. Hosted CI and full acceptance results are recorded separately. See the [sandbox guide and Codex comparison](docs/sandbox.md). The user reports successful login and messaging in PyCharm. Full AI Assistant, Air and registry acceptance still requires the recorded checks. Windows persistent storage fails closed pending ACL implementation and testing. See [verification](docs/verification.md) and [release gates](docs/release.md).

## Build and install locally

Use Node.js 26 LTS (tested with 26.11.1) and npm. Node 24 LTS is permitted but has not been exercised here.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm pack
npm install --prefix /path/to/isolated-install ./openwebui-acp-agent-0.3.0.tgz
```

The package is not published. The registry entry is a version-pinned proposal; installing it from the public registry cannot work until publication and inclusion are separately authorized and completed.

For development only, configure the client's `agent_servers` object using an
absolute Node executable and the installed agent entrypoint. This also works
when the IDE setup terminal has a minimal PATH. Preserve all existing entries.
Do not use this as the final registry installation experience.

```json
{
  "agent_servers": {
    "openwebui-preview": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/installation/node_modules/openwebui-acp-agent/dist/cli.js", "acp"],
      "env": {}
    }
  }
}
```

Use a supported Node version. No wrapper script or shell startup configuration
is required. The standard terminal-auth descriptor appends `--setup`. The legacy
JetBrains descriptor also supplies the installed entrypoint because that client
replaces the normal launch arguments.

## Setup and credentials

Select the agent in your IDE and choose **Set up Open WebUI** when prompted. The IDE opens the agent’s built-in setup terminal. Enter the installation URL and API key; the key is masked. After access is validated and the key is stored securely, setup exits and the IDE reconnects. Choose your model with the session model selector. No shell command, helper script, browser, or authentication entry in `acp.json` is needed.

A path prefix such as `https://example.org/openwebui` is supported. Do not enter an OpenAI gateway URL or append `/v1`. On first setup, the first discovered model is used until you choose another in the IDE. Repeating setup for the same installation preserves an available configured default and leaves MCP settings unchanged. Configure MCP through your client's MCP settings or the explicit user configuration documented below.

Open WebUI administrators must enable API keys and grant the user's API-key permission. If endpoint restrictions are enabled, both `/api/models` and `/api/chat/completions` must be allowed. This agent never changes those settings.

If model discovery returns HTTP 403, the agent opens a restricted session so
`/login`, `/logout`, `/status` and `/doctor` remain available. It does not activate
the workspace, start MCP servers or enable coding tools. `/doctor` can recheck
model access; after access is restored, reconnect to enable normal operation.
Replacing a key does not override server permissions or endpoint restrictions.

Persistent keys use the OS credential store through `@napi-rs/keyring` (Keychain on macOS). If secure storage is unavailable, login fails. Alternatively, supply `OPENWEBUI_API_KEY` to that process using a local secret manager. Never put it in ACP JSON, shell arguments, project files or chat. No plaintext fallback exists. These are agent-owned credentials, separate from JetBrains' provider settings.

Use `/login` in an existing chat to request the IDE's **Set up Open WebUI** action, including when you want to replace a key. It does not delete the existing key or send a model request. The client controls how it presents authentication-required errors; if no setup action appears, reconnect and use the IDE's authentication controls. Never add a key or URL as a slash-command argument.

Use `/logout` to remove the saved key and cancel active work in the agent connection. Clients can also use the standard ACP `logout` method, advertised through `agentCapabilities.auth.logout`. Other running agent processes detect the authentication change before protected operations and during active turns. Pending approval cannot restart cancelled work. Logout retains transcripts and workspace trust; the changed authentication generation invalidates tool grants. It does not revoke the API key on the server or undo remote operations that already started.

After logout, complete setup and reconnect. A signed-out marker prevents an inherited environment key from silently signing the agent back in. Remove any externally supplied `OPENWEBUI_API_KEY` before reconnecting, because it otherwise takes precedence again after successful setup. If secure-store deletion fails, the agent reports the failure and blocks further authenticated work; retry logout when the store is available. The fallback CLI `logout` uses the same persistent sign-out behavior. The new chat and ACP logout controls still need interactive IDE acceptance testing.

The agent supports standard `auth.terminal` and the verified legacy JetBrains `_meta.terminal-auth` capability. It advertises only the form the client supports. Missing or expired credentials return ACP's authentication-required error so the IDE can offer setup again. Cancellation exits unsuccessfully and does not complete the login flow. Interactive IDE acceptance is still pending; the implemented launch/reconnect behavior is tested with simulated clients and a real macOS pseudo-terminal.

For clients that advertise neither form, `openwebui-acp-agent login` remains an optional manual fallback. It is not the normal JetBrains setup path. The internal `--setup` entrypoint accepts both appended and replacement launch arguments and always exits after setup. OAuth and browser authentication are not implemented.

Non-secret configuration and transcripts use `${XDG_CONFIG_HOME:-~/.config}/openwebui-acp-agent` on POSIX, including macOS. `OPENWEBUI_ACP_HOME` overrides the entire directory for isolated profiles/tests. Files must be 0600 and the directory 0700. Windows' intended default is `%APPDATA%/openwebui-acp-agent`, but this preview refuses persistent state there until ACL enforcement is implemented.

`config.json` contains `url`, `model`, optional `header` (default `Authorization`), `rounds` (default 40 when omitted, maximum 100; existing configured values are preserved), `timeoutMs` for model-list and discovery requests (default 120000, maximum 3600000), and two budgets for each model request: `firstContentTimeoutMs`, the wait for its first streamed content including queueing and silent thinking (default 900000), and `idleTimeoutMs`, the longest silence between streamed chunks (default 300000), each at most 3600000. A turn has no overall deadline: a reply that keeps streaming runs to completion, and **Stop** cancels at any time. Configure a different credential header only after verifying the reverse proxy requirement. Use `NODE_EXTRA_CA_CERTS` before launch for a private CA. TLS verification cannot be disabled through this application's configuration. Redirects are refused.

## Session controls

- `/status`: backend, model, reasoning choices, workspace, trust and tool state.
- `/doctor`: check sandbox dependency presence and model discovery without an inference request.
- `/permissions`: inspect the selected policy, workspace trust and tool grants. `/permissions mode MODE_ID` is the fallback for the Permissions selector. `/permissions revoke-tools` clears session and remembered tool grants for this workspace/backend. `/permissions revoke` also blocks workspace access.
- `/login`: request IDE setup to connect or replace a key; no arguments.
- `/logout`: sign out, remove the stored key and cancel active work; no arguments.
- `/model MODEL_ID`: fallback for the ACP model selector.
- `/reasoning`: show advertised choices; `/reasoning default` clears the override. Other values are the exact choice identifiers shown by `/reasoning`.

The **Permissions** dropdown uses ACP's `mode` category and changes only the current session:

| Mode | Effect |
| --- | --- |
| Read only (`read_only`) | File inspection tools only; no edits, commands or MCP startup/calls. |
| Ask each time (`ask`) | Ask for each edit, command or MCP operation, ignoring existing tool grants. |
| Use scoped approvals (`scoped`, default) | Reuse explicitly granted session/remembered permissions; otherwise ask. |
| Allow workspace edits (`edits`) | Automatically approve text edits in the activated workspace for this session. Commands and MCP retain scoped approvals. |
| Allow edits and development commands (`development`) | Also automatically approve recognized inspection/test/build commands, including supported GitHub reads, for this session. Other commands and MCP retain approval requirements. |

For example, `/permissions mode development` selects the broader session policy.
Selecting a policy does not activate the workspace. Automatic modes reset to
`scoped` on reconnect/load and after `/permissions revoke-tools`; restrictive modes
persist with the saved session. Finish or cancel a turn before changing modes.
Switching to `ask` does not delete saved grants; revoke them explicitly if needed.

The separate **Sandbox** selector defaults to **Workspace write**. It also offers
**Read-only filesystem** and **Unsandboxed (session)**. The fallback is
`/permissions sandbox workspace|read_only|full_access`. Unsandboxed launches and
filesystem scope expansions always require explicit approval; the unsandboxed
selection resets on restore/revocation. Network destinations use separate
host-and-port approvals. See [isolation, platform limits and the dependency
advisory](docs/sandbox.md). Model-based automatic approval review is not implemented.

GitHub read operations such as `gh pr list`, `gh pr view`, `gh issue list` and
`gh run view` support exact grants and the broader development policy. Basic
relative-path `gh api` GET requests also qualify. Mutations, credential commands,
GraphQL, request payloads/header overrides, browser launches and unrecognized
forms still require per-call approval. The agent does not change GitHub login or
forward the Open WebUI key to `gh`.

Use the IDE's **Reasoning** dropdown; `/reasoning` is a fallback. The selector uses
ACP's `thought_level` category. Saved reasoning/thinking model controls map to
`params.model_controls[modelId][controlId]`. If these are absent, deployments
advertising `provider_model_controls.reasoning_effort` supply the available
choices, which map to the request's `reasoning_effort` field. This additional
metadata contract was verified on a deployed build reporting Open WebUI 0.13.3;
it is absent from the upstream 0.13.3 tag. It is not required for ordinary use.
No model names or universal effort levels are hardcoded.

**Model default** omits the override. A model change refreshes metadata and resets
the choice; session restoration preserves a still-supported choice. Models
without recognized metadata expose only Model default. A live Off/Low probe
showed different reasoning output; other levels and providers still need
behavioral verification. See [API evidence](docs/design.md#reasoning).

The IDE's **context usage wheel** receives standard ACP usage updates after each
model call that reports token counts. It shows the latest reported prompt plus
completion tokens against the model's advertised full window (`context_window`),
falling back to the input budget (`max_input_tokens`) when that field is absent,
not a cumulative token bill or an estimate while you type. It requests streaming
usage and also handles non-streaming replies. The provider may omit counts.
Without counts or a known limit, the agent does not invent a percentage.
`/status` exposes the last snapshot and its basis.

The snapshot survives session restoration when the model budget still matches.
Changing models clears it in the agent until the new model reports usage; the
client may keep its previous display until that update arrives. Rendering depends
on the ACP client. See [context reporting](docs/design.md#context-usage).

Use `/compact` to summarize older completed history for subsequent model requests.
The original transcript stays on disk. Automatic compaction is on by default:
when older history can be reduced, it runs before inference at 80% of the reported
context budget or 700,000 serialized context characters. Use the **Automatic
compaction** selector or `/autocompact on|off` to control it. `/status` reports the
setting and completed compaction count. Summary generation uses the selected
model with tools disabled; it can cost inference time and tokens. Failed or
cancelled compaction retains the original context. Automatic failure warns and
continues within existing limits, without retrying compaction in that turn.
Token usage refreshes on the next coding response; no guessed percentage is sent.
Compaction does not remove the existing 2 MB session-storage budget or guarantee
that a model preserves every fact. It cannot repair an oversized indivisible
message/tool group; start a new session when no safe reduction is possible.

Use **Workflow → Plan** or `/plan on` to inspect files and propose work before
implementation. This mode permits only list/read/search and `update_plan`;
commands, edits, MCP and server tasks are blocked. **Workflow → Code** or
`/plan off` restores tool availability under the existing permissions and sandbox.
For multi-step tasks the model can send a structured progress plan to the IDE.
The plan survives restoration and compaction; it never authorizes execution.
`/help` lists commands, and unknown slash commands return explicit guidance.
`/status` distinguishes configured MCP servers from connections open during a turn.
See the [feature audit and proposed roadmap](docs/feature-audit.md).

The CLI provides `acp`, `login`, `logout`, `models`, `status`, `doctor`, `trust`, `trust revoke /absolute/workspace`, and `trust allow /absolute/workspace`. The last command explicitly clears a block and remembers trust; use it deliberately.

## Permissions and tools

Prompts accept text, resource links and embedded text context from the IDE. Links are retained as references; they are not automatically fetched. Embedded file text preserves unsaved editor contents and is checked against the approved workspace before transmission. The combined prompt and attachment limit is 100 KB. Images, audio and non-text binary attachments are unsupported and produce an actionable error. `/status` and `/doctor` use the text command without transmitting attached context.

The first ordinary prompt requests workspace activation through ACP. Approval covers the canonical session cwd and the disclosed inference destination. Remembered trust is exact-root; siblings and Air worktrees require their own decisions. Home and filesystem roots are rejected. Session-only grants are not saved. A block requires explicit CLI action to clear.

Tools list files, read bounded text, search literal text, propose/create/replace text files and execute a program with argv. Edits show old and new content through ACP diff content. The agent re-reads before writing and rejects stale proposals. Client filesystem capabilities take precedence, preserving unsaved editor content. Client denial never triggers a local fallback. Local writes use temporary files and rename. Concurrent hostile filesystem replacement cannot be fully eliminated by these checks; this is not an OS sandbox.

With the default scoped policy, commands initially require approval showing executable, arguments and cwd. Recognized inspection and development commands offer reuse for that exact executable and argument list. These include `ls`, `find` without side-effect predicates, `rg` without subprocess preprocessors or `--hostname-bin`, common text inspection tools, Git inspection commands and test/build tools without options that delete or overwrite other paths (such as `pytest --basetemp` or an output-file option). Only bare program names or programs in standard system directories qualify; a path such as `./tools/cat` always asks. Literal `sh`/`bash`/`zsh -c` or `-lc` forms can also offer reuse when every command is recognized. Shell expansion, redirection, arbitrary scripts, Git mutations, deployment, cleanup and unrecognized forms require approval each time, with an explanation in the request. Full shell scripts remain part of the exact grant; no command prefix is automatically approved. See the [Codex comparison](docs/codex-comparison.md) for the boundaries and remaining gaps. Local commands get a small environment allowlist, a 30-second timeout and a 100 KB output bound. A shell runs only when explicitly selected as the executable. Commands use the agent-owned sandbox runner even when the client offers terminals. A terminal capability does not establish OS isolation. Sandboxed commands receive a private temporary directory and network proxy settings; an unavailable sandbox never silently falls back to unrestricted execution.

Tool approvals offer **Allow once**, **Allow for this session**, **Remember for this workspace and backend**, and **Decline** where repeat approval is supported. Edit grants cover text edits inside the approved root; diffs and stale-content checks still apply. Command grants match exact arguments, not prefixes. MCP connection grants cover the disclosed server configuration; MCP tool grants cover that server and tool with any valid arguments, including mutations. Grant only tools whose future calls you intend to permit. Tools from a local HTTP/SSE MCP server, including the IDE bridge (terminal, run configurations), run on this machine outside the sandbox, so each call needs its own approval, like any unsandboxed command.

Session tool grants expire when the agent disconnects and are not restored from history. Remembered grants survive reconnects in `permissions.json`, separately from workspace trust. Workspace, backend/header, authentication generation and MCP configuration changes invalidate the applicable grants. `/permissions` lists the scope and grant fingerprints without storing raw command arguments or credentials. `/permissions revoke-tools` clears all tool grants for the current workspace/backend across sessions; pending approvals cannot restore a revoked grant. It does not undo completed actions or guarantee cancellation of remote work already started. The IDE controls the presentation of the supplied choices.

A remembered command approval authorizes future executions, not immutable program contents. Scripts and dependencies can change within the sandbox, and allowed workspace writes can still damage the project. Revoke grants before running changed code that you no longer trust. Unsandboxed mode removes the OS boundary.

Discovery applies root and nested `.gitignore`, skips common sensitive paths, `.git`, symlinks and `node_modules`, and limits traversal. All possible credential filename conventions are not covered. Sandboxing does not make a hostile workspace safe or identify every possible secret. Project `.env`, hooks, legacy agent settings and `.mcp.json` are never executed or loaded as configuration. Root `AGENTS.md` is read only after activation and is treated as untrusted guidance.

## MCP

Pass stdio, Streamable HTTP or legacy SSE definitions in ACP `session/new.mcpServers`. This is different from the client's `agent_servers` registration. Streamable HTTP remains preferred for new servers. SSE supports older servers, including the inspected PyCharm IDE server.

For macOS PyCharm/IDEA native launchers with the sole argument `stdioMcpServer`, the agent recognizes the supplied IDE connection descriptor and asks to connect directly to its local SSE endpoint. The approval shows the destination and IDE project. It preserves the supplied MCP authentication and project headers without launching another IDE process. IDE tool execution is outside the agent's command sandbox; each tool still requires approval or an applicable grant. Other stdio definitions keep the sandboxed runner. See [the compatibility evidence](docs/design.md#ide-mcp-compatibility).

You can also explicitly create private application `mcp.json`, containing an array of definitions. HTTP/SSE entries have `type` (`http` or `sse`), `name`, `url` and `headersFrom`; stdio entries have `type`, `name`, `command`, `args` and `envFrom`. The `*From` maps contain environment variable **names**, never secret values. For example:

```json
[{"type":"http","name":"research","url":"https://example.org/mcp","headersFrom":{"Authorization":"RESEARCH_MCP_AUTH"}}]
```

Local MCP startup uses the selected sandbox and discloses any program-installation read scope before launch. Remote MCP work is outside the local sandbox. Supply the full header value through the named process variable. Never reuse the Open WebUI key implicitly. Each server activation and tool call needs a separate approval or a matching grant selected by the user. A connection grant does not authorize its tools. Names are scoped by server and tool index. Tool annotations do not grant permission. Discover actual search, retrieval and memory tool names from the configured server; this project invents no such endpoints. Closing a connection does not prove cancellation of work already started on a remote server.

## Optional Open WebUI-managed tools

Choose **Open WebUI tools → Available with scoped approvals**, or send
`/server-tools on`. `/server-tools refresh` discovers available features and
server tool IDs; `/server-tools off` disables delegation. `/status` shows the
catalog and recorded remote jobs. Discovery does not request model inference.
This integration currently requires the verified Open WebUI **0.13.3** contract.
Other versions are refused until their behavior is verified.

After enabling it, ask for web research, image generation, knowledge retrieval,
or a tool on an Open WebUI-managed MCP server. The model receives one
`openwebui_task` tool with the available feature flags and discovered tool IDs.
Open WebUI controls feature enablement, model capabilities, user permissions
and its MCP credentials. Version 0.13.3 can return public-only `/api/config`
settings to API-key callers. Explicitly model-advertised features remain
requestable, but their server enablement is labeled **unverified** when those
settings are absent. Explicit false flags disable the corresponding choice.
An advertised feature does not prove that it works.
Direct MCP and the local coding tools remain available independently.

Delegated tasks offer **Allow once**, **Allow for this session**, **Remember for
this workspace and backend**, and **Decline** before a server chat is created.
The approval shows the prompt, model, requested features and selected tool IDs.
Session and remembered grants cover **any prompt** with that exact model,
feature set and tool IDs, including mutations and new retained chats. They are
bound to the workspace, backend and authentication generation. Changes to the
selected model/features/tools or observed capability/catalog metadata require
new approval. Server behavior that is not exposed in metadata can still change.
`/permissions revoke-tools` revokes these grants with the other tool grants.
**Ask each time**, applicable administrator `alwaysAsk` rules and approval advice
continue to require a fresh decision. Development mode never creates a remote
grant automatically.
It authorizes a remote task, not separate ACP approval of every server tool call.
Open WebUI can also offer other built-ins permitted by your account/model,
including files, knowledge, notes, calendars, automations and sub-agents.
Those tools can read or mutate remote data. The local command sandbox does not
constrain them. Memory requires explicit selection in the approved task.
Code-interpreter is not offered, and no terminal is selected. Selected server
tools can still expose execution capabilities of their own.

The task creates and **retains an Open WebUI chat** containing its explicit
prompt and results. Local workspace history is not copied automatically.
The result includes the chat link, citation URLs and generated-image file links.
Supported images receive bounded ACP previews; client rendering varies. Large
or unsupported images remain accessible through authenticated browser links.
Image inputs and image editing/upload are not added by this feature.

Cancellation sends a best-effort stop request for that chat. It cannot undo
remote effects or guarantee a provider job stops. Interrupted runs are recorded
with an unknown outcome and never replayed. If Open WebUI pauses for its own
tool approval or user interaction, open the linked chat; this agent does not
bypass that approval. Delete retained chats yourself in Open WebUI when no
longer needed. Local session restoration retains job references but resets
server tools to Off, as does changing models.
Local round limits do not bound the individual calls inside Open WebUI's loop;
the server controls those limits. The agent bounds its waiting and result sizes.

If API-key endpoint restrictions are enabled, this mode also needs access to:

| Route | Purpose |
| --- | --- |
| `GET /api/version`, `GET /api/config` | Verify contract and discover enabled features |
| `GET /api/v1/tools/` | Discover workspace/OpenAPI/MCP tools |
| `POST /api/v1/chats/new` | Create the explicitly approved task chat |
| `POST /api/chat/completions` | Start the native server loop |
| `GET /api/tasks/chat/{chat_id}` | Poll the owned task |
| `GET /api/v1/chats/{chat_id}` | Read its result |
| `POST /api/tasks/chat/{chat_id}/stop` | Request cancellation |
| `GET /api/v1/files/{file_id}/content` | Fetch bounded generated-image previews |

The endpoint restriction field accepts path prefixes, not these HTTP methods or
`{...}` placeholders. Add `/api/version`, `/api/config`, `/api/v1/tools`,
`/api/v1/chats`, `/api/tasks/chat` and `/api/v1/files` alongside the existing
model/completion entries if your administrator authorizes that scope. These
prefixes must have no trailing slash and also cover other routes under those paths; retain normal account
permissions. No admin task API, server settings change or backend extension is
required.

## Persistence and privacy

Transcripts are local `session-UUID.json` files. They retain model selection, reasoning and message/tool history. Loading rechecks the workspace and destination and never executes saved tool calls. Interrupted outcomes are marked unknown. The ordinary coding loop creates no Open WebUI chat records. Approved Open WebUI-managed tasks create retained server chats as disclosed in their approval; the agent does not delete them.

A new prompt interrupts a running turn and waits for cleanup before starting.
If several prompts arrive while cleanup is pending, only the latest starts.
Partial streamed text and completed tool results remain in history. Stop also
cancels a waiting replacement. The client controls whether you can send while
the agent is busy; the tested PyCharm AI Assistant requires Stop first.

Limits include 32 sessions per process, 64 calls per turn, 1 MB response/context budget, 2 MB per transcript, 1000 transcripts and a 64 MB aggregate storage budget. Quota exhaustion stops work; automatic history truncation and deletion are not implemented. Stop the agent and delete selected `session-UUID.json` files to remove history. Preserve configuration and trust unless you also intend to remove them. Transcripts can contain project content; known configured credentials are redacted, but arbitrary secrets embedded in user text cannot be identified reliably.

No telemetry or analytics is added. Open WebUI and its model providers have independent logging and data-handling policies.

## Troubleshooting

401 indicates invalid or revoked credentials. 403 can indicate API-key permissions or an endpoint allowlist. 404 can indicate a wrong installation prefix or unavailable model. 429 requires waiting; the agent does not blindly retry inference or tools. Error messages include the server's error code or message and any `Retry-After`, never a raw response body. TLS/network failures and redirects are reported without response bodies. Use `/doctor` to distinguish discovery access from model execution.

For a cut-off or malformed coding reply, the agent keeps emitted partial text and asks once per model round for a corrected reply, before executing any tool from that reply. A second failure stops the turn with an explanation. Authentication, HTTP, network, content-filter and resource-limit failures are not automatically retried. At the round or 64-tool-call limit, the agent reports tool-result counts, changed files and unfinished plan steps; it does not claim the task succeeded. The agent warns once when context usage passes 90% of the advertised window.

Model function calling must be tested separately; unknown tool names or invalid arguments never execute. Parser repair only converts JSON-encoded containers or nullable `"null"` into explicitly declared schema types and removes forbidden extra fields from simple object schemas; validation and approvals still run afterwards. New sessions use a short read/edit/check workflow prompt. Existing sessions retain their original system instructions and `AGENTS.md` history.

Malformed or symlinked trust files fail closed. Inspect and repair them manually while clients are stopped; do not delete them simply to bypass a block. A stale `trust.lock` after a crash also requires inspection. See [design](docs/design.md), [migration](docs/migration.md), and [verification](docs/verification.md).

An earlier version could redact the workspace path in saved sessions supplied
with JetBrains MCP configuration. Reopening an affected chat now shows a recovery
notice. Its next coding prompt requires fresh approval to attach the history to
the current workspace, even if that workspace is already trusted. Approve only
if the history belongs to this project. Declining or cancelling leaves the saved
workspace unresolved; no coding request or MCP startup occurs. An intact saved
path that belongs to another project still requires reopening that project or
starting a new chat. Do not delete transcripts or edit trust records to recover.

## Administrator rules and approval advice

Use the IDE’s **Approval advice** selector to opt into a separately selected model, or `/reviewer <model-id>`. Advice never grants permission; the user still decides. `/reviewer off` disables it. Root-owned administrator rules can restrict destinations, sandbox modes and approvals. See [managed policy](docs/managed-policy.md) and the [headless Linux test procedure](docs/linux-testing.md).
