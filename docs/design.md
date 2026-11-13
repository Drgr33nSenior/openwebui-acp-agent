# Design and API evidence

## Boundaries

The ACP v1 stdio process owns sessions, history, approval, cancellation and local execution. It calls authenticated Open WebUI model discovery and chat completions. It connects separately to explicitly configured MCP servers. stdout is reserved for ACP; CLI login uses stderr and a separate terminal process. No companion plugin, other coding-agent runtime, legacy trust file, generated runtime bundle, project hook or remote ACP listener is involved.

Model IDs are opaque catalog values. Open WebUI supplies model metadata and controls; the agent does not select behavior by model family or keep a separate provider capability catalog. Only understood metadata with verified request semantics is exposed. Model-advertised features are distinct from implemented ACP capabilities and from permission to execute tools. See [project guidance](../AGENTS.md) for the maintenance rules.

The implementation uses strict TypeScript, Node LTS, the default stable entrypoint of `@agentclientprotocol/sdk` 2.6.0 and official `@modelcontextprotocol/sdk` 1.32.2. SDK major version 2 does **not** imply ACP v2: its default export is stable v1. The current SDK uses `AgentApp`/`ClientApp`; older `AgentSideConnection` examples do not match this pin. Experimental entrypoints are not used.

`@napi-rs/keyring` 2.1.2 provides OS credential storage (MIT). Zod validates local schemas and creates function definitions; Ajv validates discovered MCP JSON Schemas; ignore handles root Git ignore syntax. These dependencies avoid ad hoc schema validation and plaintext secret storage. npm's lockfile records transitive integrity. Native keyring availability is a deployment dependency; interactive keychain behavior remains untested.

## Execution ownership

The local coding completion body contains `model`, `messages`, `tools`, `stream`, and optionally reasoning `params.model_controls` or `reasoning_effort` selected from verified metadata. It omits chat/message/session IDs, `tool_ids`, `features`, terminal IDs and legacy function-calling mode. The agent executes returned tool calls after validation and approval and returns correlated tool messages. Explicitly approved delegated server tasks use the separate contract below.

[Open WebUI's tool-calling documentation](https://docs.openwebui.com/reference/server-side-tool-calling/) distinguishes caller execution from server execution. The [v0.12.5 middleware source](https://github.com/open-webui/open-webui/blob/v0.12.5/backend/open_webui/utils/middleware.py) retains `payload_tools` and gates normal tool resolution on its absence. This is source evidence, not a deployed contract test. Historical reports describe older caller-tools replacement bugs, so compatibility must not be inferred from an OpenAI-shaped response alone.

Mock contract tests assert that the coding loop sends caller definitions and omits autonomous-loop fields. They do not execute Open WebUI itself. No live Open WebUI version has passed the complete contract suite. The installation initially reported as 0.12.5 now returns 0.13.3 from its live `/api/version` endpoint (13 November 2026). Private deployment addresses are deliberately absent from this repository.

Server-side filters, model defaults and provider behavior remain server-controlled. Even a caller-owned tool loop does not claim to control every server plugin or remote job. Managed tools execute only through an explicitly approved delegated task; their individual remote invocations are not advertised as ACP-approved operations.

## Open WebUI-managed tasks

The optional `openwebui_task` tool preserves the local coding loop and sends only
its explicitly approved prompt to a separate server chat. Discovery reads
`/api/version`, `/api/config` and `/api/v1/tools/`. Feature flags come from the
global configuration and per-model capabilities/categories; access checks still
belong to Open WebUI. Catalog entries include workspace tools, OpenAPI servers
and MCP servers. IDs are used as returned, never guessed from model names or
workstation defaults. Entries marked unauthenticated cannot be selected.

Live discovery exposed an API-key distinction: the 0.13.3 `/api/config` handler
uses browser JWT decoding rather than API-key user resolution, returning only
public settings for the tested key. Its global feature flags were absent even
though authenticated model and tool discovery worked. Absence is treated as
unknown, not false. Explicit model-advertised capabilities remain requestable
with `unverifiedFeatures` displayed in status, tool metadata and approval;
explicit false flags still exclude them. No admin settings endpoint is queried
and no global toggle is inferred from an advertised model capability.

The [current API guide](https://docs.openwebui.com/reference/server-side-tool-calling/)
and pinned [v0.13.3 middleware](https://github.com/open-webui/open-webui/blob/v0.13.3/backend/open_webui/utils/middleware.py),
[main routes](https://github.com/open-webui/open-webui/blob/v0.13.3/backend/open_webui/main.py),
[tool catalog](https://github.com/open-webui/open-webui/blob/v0.13.3/backend/open_webui/routers/tools.py)
and [built-ins](https://github.com/open-webui/open-webui/blob/v0.13.3/backend/open_webui/tools/builtin.py)
establish the implemented contract. It is gated to exactly 0.13.3 pending review
of other releases. No new backend endpoint, dependency or legacy calling mode
is used.

After approval or a matching scoped grant, the agent creates a saved chat with user/assistant tree
entries, journals its IDs locally, and requests a native streaming completion
with `chat_id`, `id`, a nonempty `session_id`, explicit feature flags and selected
`tool_ids`. This request omits `tools`, which would bypass server resolution.
Title, tag and follow-up tasks are disabled. Reasoning overrides use the selected
model's existing verified mapping. The async acknowledgement is followed by
bounded task-status polling and reading the final saved message. Local coding
requests continue sending their own `tools` array.

Web search, image generation and memory flags are selectable only if discovered.
The code-interpreter flag stays false; no terminal ID is sent. Other built-ins
have no per-request disable flag in this contract and may be offered under the
account/model policy. The approval explicitly discloses that wider server scope,
possible mutations, external services, retained chat and lack of per-call ACP
approval. A selected MCP server can itself expose execution tools. This is not
a restricted web-search sandbox. Administrator `allowServerTools: false` blocks
delegation; an explicit `mcpHttpUrls` list must allow the Open WebUI installation.
Read-only mode excludes the delegated tool. Enablement resets on restore/model
change. Session and remembered grants use the existing `mcp-tool` permission
store and bind to workspace/backend/authentication/policy scope, exact model,
feature and tool-ID sets, contract version, selected catalog entries, and
observed model capabilities/built-in categories. Model metadata is refreshed
before checking a grant. Prompts are excluded from its identity, so approval
explicitly covers any prompt, including mutations and new retained chats.
Only grant hashes and agent-authored labels are persisted. Selection-order
changes do not invalidate a grant; scope/metadata changes do. Unreported server
behavior cannot be fingerprinted and remains controlled by Open WebUI.
Revocation invalidates active and remembered grants. Ask mode, applicable
administrator rules and approval advice suppress reuse. Automatic local
permission modes cannot create remote task grants.

Cancellation uses `POST /api/tasks/chat/{chat_id}/stop`, which checks user chat
access. The superficially similar `/api/tasks/stop/{task_id}` is administrator-only
in 0.13.3 and is not used. Closing HTTP alone does not cancel server work.
Stop requests have a separate five-second cleanup bound and cannot undo effects.
Unknown outcomes are recorded, never replayed. Server-side approval or `ask_user`
pauses are reported with a chat link; the agent does not disable server approvals.
No chat is automatically deleted, including after cancellation or failure.

Final `content` or structured `output_text`, citation URLs, observed tool-call
statuses and generated `files` are returned to the coding loop. Acknowledgement
alone is not reported as proof of execution. Generated images use validated file
UUIDs and the installation's `/api/v1/files/{id}/content` route, never arbitrary
returned URLs. Previews allow PNG/JPEG/WebP/GIF with MIME/signature validation,
two MB each and four images maximum. ACP receives image and resource-link blocks;
transcripts contain text/links, not base64 images. Authentication is sent only to
the configured installation, with redirects refused. Original image inputs and
editing/uploads remain unsupported. Server chats and provider logging have their
own retention policies.

The 0.13.3 API-key allowlist matches exact paths or `allowed + '/'`; path prefixes
must therefore omit a trailing slash. The documented extra routes are required
in addition to inference. These facts are source inspection and mock-test
evidence; actual server tool execution, rendered images and account permissions
still require live acceptance.

## Reasoning

The [API reference](https://docs.openwebui.com/reference/api-endpoints/) documents
model-keyed `params.model_controls` and explicit `reasoning_effort` overrides.
The 0.13.3 [public model metadata](https://github.com/open-webui/open-webui/blob/v0.13.3/backend/open_webui/utils/models.py)
and [payload implementation](https://github.com/open-webui/open-webui/blob/v0.13.3/backend/open_webui/utils/payload.py)
retain the previously checked 0.12.5 control contract: labeled option dictionaries
are expanded by the server into provider parameters. Saved controls whose ID or
label mentions reasoning/thinking take precedence in this agent.

On 13 November 2026, the deployed server reported 0.13.3 and additionally exposed
`provider_model_controls.reasoning_effort`, with labeled option dictionaries and
a default. Those fields are absent from the upstream 0.13.3 tag and main commit
`b0e6098e940942281d9c83f3529ea117287a3a22`; do not attribute this extension to all
0.13.3 installations. When saved reasoning controls are absent, the agent maps
these explicit provider choices to top-level `reasoning_effort`. It ignores
unrecognized provider controls and does not derive options from model names,
saved defaults or `supportedReasoningEfforts` alone. No deployment or API change
was made for this implementation.

Two bounded live requests with synthetic arithmetic, `tools: []`, no chat IDs
and a 512-token output limit verified a behavioral difference: the advertised
Off value returned no reasoning content, while Low returned 223 reasoning
characters and reported 107 reasoning tokens. No tools ran. This establishes
observed behavior for those two values on that deployment, not other values or
providers. Subsequent inspection located the declaration adapter in the user's
[Open WebUI fork](https://github.com/Drgr33nSenior/open-webui/blob/21bc3e3da87d25e988b412710bafcefd4b4261db/backend/open_webui/utils/models.py).
The exact deployed build identity has not been verified.

ACP config options use category `thought_level`; Model default omits override
fields. Selection is validated, persisted and reset on model changes. Both local
coding requests and delegated tasks preserve the selected mapping. Fixture tests
cover malformed metadata, unsupported choices, precedence, defaults, persistence
and model switching. Live IDE selector rendering remains an acceptance item.

## Context usage

The pinned SDK's stable v1 `UsageUpdate` and the
[ACP prompt-turn specification](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-usage-updates)
define `session/update` with `sessionUpdate: "usage_update"`, `used` and `size`.
No extra capability flag or JetBrains extension is required. The installed
PyCharm ACP module contains `SessionUsageUpdatedEvent`, `handleSessionUsage` and
`updateSessionUsage` handlers. This is client implementation evidence, not a
completed visual acceptance test.

Coding completions request `stream_options.include_usage: true`. The parser
collects the latest valid usage record from ordinary or usage-only SSE events,
including after the finish marker, or from a non-streaming response. It emits
one snapshot per model call, not a sum of repeated events or tool rounds.
The [Open WebUI API reference](https://docs.openwebui.com/reference/api-endpoints/)
distinguishes latest-call `prompt_tokens`/`completion_tokens` from potentially
aggregate `input_tokens`, `output_tokens`, `total_tokens` and cost. Only the
latest-call fields, or the documented Ollama `prompt_eval_count`/`eval_count`
equivalents, contribute to the wheel. Invalid, negative, fractional, overflowing
or missing input counts are ignored. Missing output counts add nothing.

The denominator prefers the model catalog's positive `context_window`, directly
or in its `openai` metadata. When absent, it falls back to `max_input_tokens`, the
usable input budget. It never adds `max_output_tokens`: scheduler headroom can
be reserved separately. The numerator is a
snapshot of reported prompt plus completion tokens; generated reasoning may be
included in provider completion accounting, and later unsent inputs/tool results
are not yet measured. It is not an exact tokenizer count of current local
history. Unknown budgets/counts produce no fabricated usage update. The last
valid snapshot remains available through `/status`; clients can retain their
last display when no new measurement is available. No cost estimate is sent.

Snapshots are session-local and persisted outside message history. Restoration
requires the same advertised budget; old sessions without snapshots still load.
Changing the model invalidates the previous measurement. Cancellation prevents
late usage delivery. A completed response with a length limit can still report
its measured count before the existing limit error; no pending tools execute.
Separate advisory reviews and delegated server chats do not add their counters
to the main session. This feature adds no compaction or new backend endpoint.

The user's gateway source calculates the input budget from the full serving
window minus output allowance and scheduler reserve. A bounded source change in
`ArchLinuxThreadripper/apps/base/shared-api/boundary.py` now publishes
`context_window` from the configured serving policy, preserving input/output
fields. The source change is published in
[gateway PR #179](https://github.com/Drgr33nSenior/ArchLinuxThreadripper/pull/179),
not deployed. The Open WebUI fork's existing
[catalog merge](https://github.com/Drgr33nSenior/open-webui/blob/21bc3e3da87d25e988b412710bafcefd4b4261db/backend/open_webui/routers/openai.py)
already preserves arbitrary provider fields at the top level and in `openai`.
No Open WebUI patch, endpoint, credential or live configuration change is needed
for this pass-through. Clients receive the new field after the gateway change is
deployed through its owner workflow and the model catalog cache refreshes.

## Authentication and version discrepancies

[ACP v1 authentication](https://agentclientprotocol.com/protocol/v1/authentication) specifies appended terminal-login arguments. [Registry authentication guidance](https://github.com/agentclientprotocol/registry/blob/main/AUTHENTICATION.md) still describes replacement arguments. The built-in `--setup` entrypoint takes precedence anywhere in argv and exits after setup. `login` and `--login` remain fallback aliases. No wrapper script or browser is needed.

Modern clients receive `type: terminal` only when `auth.terminal` is true, with
`args: ["--setup"]`. Clients explicitly advertising `_meta.terminal-auth: true`
receive the legacy descriptor with `args: [installedEntrypoint, "--setup"]`,
`env: {}` and `label: "Set up Open WebUI"`. The entrypoint is the absolute path
to the package's own `cli.js`, derived from its module URL. It omits a command
override. Unsupported clients get no authentication method and an explanation of
the fallback.

PyCharm 2026.3 build 263.7307.206 was rechecked after a login terminal closed
before input. Its terminal-auth log reported `env: node: No such file or directory`.
The normal ACP process could resolve Node; the separate login terminal could not.
Read-only inspection of `AcpTerminalAuthHandlerKt.buildTerminalAuthCommand`
confirmed that this client combines the launch command with the auth descriptor's
arguments, replacing normal launch arguments. Local development registration now
uses an absolute Node executable. The legacy descriptor must include the script
entrypoint so replacement does not produce an invalid `node --setup` invocation.
The CLI also accepts that entrypoint argument when a client appends it. Real PTY
tests use `/usr/bin:/bin` as PATH and cover replacement and appended forms without
wrapper scripts, shell initialization or credentials in launch configuration.

Read-only inspection of IDEA/PyCharm 2026.3's `intellij.air.backend.acp.jar` found `AcpInitializedClientFactoryKt.acpClientExtensionMeta` advertising the legacy boolean, `AcpTerminalAuthMetadata` decoding the object above, and `AcpTerminalAuthHandlerKt` routing it to terminal setup. The installed standalone Air 262.1037.14 has matching `LegacyTerminalAuthMetadata` and an `authenticate` verification step in `GenericAcpTerminalAuthApiCommandHandlerKt`. The agent handles that legacy verification by checking stored credentials without prompting on ACP stdio. Modern terminal methods are never treated as protocol-driven login. The bundled `com.intellij.air` plugin versions are `263.7307.200-mac-arm64` (IDEA) and `263.7307.206-mac-arm64` (PyCharm). Selected class files were inspected from temporary copies with only their class-version header adapted for the available javap tool; no installed files were changed or copied into this repository. This evidence concerns installed implementation, not an observed click-through test or a public extension point dependency.

The wizard collects only URL and masked key, validates model discovery, and saves to the existing OS credential store. Model choice is an ACP session control. The prior model default is preserved when available on the same installation; otherwise the first discovered model is the initial selection. Invalid credentials, validation cancellation and unavailable secure storage never trigger a plaintext fallback. HTTP 401 during session creation, loading or inference is surfaced as ACP `auth_required`, rather than an ordinary chat error. HTTP 403 remains a permission/endpoint-policy diagnostic.

An HTTP 403 from model discovery during `session/new` or `session/load` creates
a restricted session instead of failing before chat commands can run. It exposes
only login, logout and diagnostic commands, with no session configuration
options. It does not load user MCP definitions, activate the workspace, read
project context or run inference and tools. Attempts to select a configuration
option are rejected; other prompts explain the access failure. `/doctor` may
retry model discovery, but successful discovery does not promote the restricted
session. Reconnection revalidates authentication and normal session setup.
Restoring a restricted session preserves its saved reasoning selection and
history. Missing credentials and HTTP 401 still use the standard IDE setup flow.
Setup itself continues to reject HTTP 403; restrictions are never bypassed.

The pinned SDK 2.6.0 stable v1 schema includes `agentCapabilities.auth.logout`
and the `logout` request. Both the protocol request and `/logout` use the same
sign-out operation. The operation aborts the connection's authentication work
and active turns, closes session MCP clients, writes a new authentication epoch
with `loggedOut: true`, and removes the configured installation's OS-store key.
The marker blocks both keyring and environment credentials, including after a
reconnect. Successful setup replaces the marker with a new epoch. Existing
sessions cannot adopt the new epoch; clients must reconnect. Model discovery
captures the epoch before authentication and checks it again before completing
session creation or restoration. This prevents logout during discovery from
creating an authenticated session with an old key.

Active turns check the authentication epoch alongside administrator policy every
250 ms and before protected operations. Logout cannot retract a remote side
effect already started. Credential deletion failure produces a fixed diagnostic;
native keyring errors are never returned. Transcripts and workspace trust remain.
The changed epoch invalidates tool grants without deleting unrelated records.

`/login` returns the existing authentication-required error so the client can
offer terminal setup. It preserves the current credential until setup succeeds.
Both chat commands reject arguments and are handled before inference, workspace
activation and transcript insertion. They are advertised on new and restored
sessions. ACP has no agent-to-client request to open a login terminal directly;
the client owns that presentation. JetBrains' rendering of `/login` and its
optional logout action remain manual acceptance items. No private IDE settings
or credential APIs are used.

API keys require administrator enablement and user permission according to [Open WebUI API-key guidance](https://docs.openwebui.com/features/authentication-access/api-keys/). Config contains no key. URL credentials and redirects are rejected. Key material is not supplied to local commands or MCP implicitly. MCP header/environment credentials are separate and redacted from notifications and transcripts. Local command environment names are explicitly selected.

## Trust and persistence

[ACP v1 content](https://agentclientprotocol.com/protocol/v1/content) requires both text and resource links as baseline prompt types. Version 0.1.1 incorrectly rejected all non-text blocks. Version 0.1.2 accepts resource references and advertises `embeddedContext` for text resources, including valid UTF-8 blobs with supported text MIME types. Images, audio and non-text binary resources remain unsupported. Resource URIs are never fetched automatically or used to select the inference destination. Embedded file contents pass workspace path checks after activation; client-supplied unsaved text is not replaced with a disk read. Context is marked untrusted and included only in user messages, not system instructions. The prompt budget covers attachments and metadata. Slash-command parsing uses top-level text separately from context.

Workspace activation is an ordinary ACP permission-gated operation at first prompt, not an invented folder-trust RPC. Canonical roots are exact records. Local access checks component boundaries and rejects symlinks and common sensitive paths. Approval for a read does not authorize an edit, command or MCP invocation. Runtime checks reread revocations. Destination changes stop active work.

Trust updates validate the complete store, acquire an exclusive lock file, reread records, write a same-directory 0600 temporary file, flush and rename. A crash can leave a lock requiring manual inspection. Files and directory must already be private; permissive existing state is rejected. Windows storage is deliberately unavailable until equivalent ACL enforcement exists.

History is written before executing returned calls and after results. Restore inserts an unknown-outcome marker for incomplete calls and never replays them. Per-session overlap is rejected. Abort signals stop inference and prevent late permission replies from starting work. Local process groups are killed on POSIX. Commands now use the owned runner; client terminals do not bypass the boundary. Remote cancellation is cooperative.

## IDE MCP compatibility

Read-only inspection of PyCharm 2026.3 build 263.7307.206 found that
`AcpIdeMcpServerProviderImpl` always supplies its IDE server as stdio. Its
`McpStdioRunnerKt` connects to `http://localhost:${IJ_MCP_SERVER_PORT}/sse`.
It forwards all `IJ_MCP_*` environment entries except `IJ_MCP_DEBUG` as headers,
removing only the `IJ_MCP_HEADER_` prefix when present. In particular, the token,
project path and allowed-tools fields retain their `IJ_MCP_*` header names.
This is installed implementation evidence, not a public extension API or a
dependency on JetBrains classes.

Real macOS sandbox probes with synthetic credentials reproduced two failures:
the launcher could not locate its product descriptor with executable-only read
scope; granting the application Contents directory then reached Java but its
Ktor socket failed with `Operation not permitted`. No network approval callback
was reached. Expanding the read scope alone would not fix this integration.

`ide-mcp.ts` recognizes only absolute macOS app launcher paths ending in
`Contents/MacOS/pycharm` or `Contents/MacOS/idea`, the sole `stdioMcpServer`
argument and exclusively `IJ_MCP_*` explicit environment entries. It validates
the port, absolute project path and unambiguous headers, then uses the official
MCP SDK 1.32.2 SSE transport. Other definitions retain their existing transport;
no failed process is retried unsandboxed. Linux and Windows launcher adaptation
is not implemented or inferred from the macOS contract.

Before connection, ACP approval discloses the effective URL and project scope.
Both the original stdio definition and effective SSE destination must pass
administrator policy. Grant identities include both definitions, so previous
stdio startup grants do not silently authorize the new route. The IDE itself
executes approved tools outside the agent's command sandbox. No Open WebUI key
is forwarded. The configured MCP headers authenticate both SSE and POST requests.
Redirects, cross-origin message endpoints and credential-bearing URLs are
rejected. Connection startup is bounded, cancellation closes the connection,
and SSE errors close without automatic reconnection or tool replay.

Generic SSE is also accepted through ACP and explicit user configuration and
advertised in capabilities. Streamable HTTP remains the preferred transport.
Connection errors identify the server index and failing stage without exposing
arbitrary server error bodies or credentials. Mocked ACP/SSE tests verify the
header mapping, approvals, policy restrictions and failures. Live PyCharm tool
acceptance remains separate from these tests and installed-code inspection.

## Remaining engineering limits

This preview has the command sandbox described in [sandbox.md](sandbox.md), but lacks an atomic compare-and-swap editor API, general sensitive-file classifier, Windows ACL support, remote-job rollback, automatic context compaction or credential expiration push notification. File-path checks and re-reads reduce accidental escape/stale writes but cannot eliminate adversarial TOCTOU races. Local MCP framing is now bounded before SDK parsing. Remote MCP HTTP payloads/results still require further transport-level memory hardening. Session aggregate quota accounting is best-effort across processes. These are release review items, not guarantees covered by mocked tests.

Research date: 2026-11-13. [Node release policy](https://nodejs.org/en/about/previous-releases) lists Node 26 and 24 as LTS. [ACP SDK source](https://github.com/agentclientprotocol/typescript-sdk), [MCP SDK source](https://github.com/modelcontextprotocol/typescript-sdk), [JetBrains AI Assistant](https://www.jetbrains.com/help/ai-assistant/acp.html), and [Air agent management](https://www.jetbrains.com/help/air/air-in-ides-manage-agents.html) were consulted. Product compatibility is not inferred from these documents.

## Registry authentication compatibility

The earlier unmodified upstream auth probe failed because it advertised only the legacy metadata capability. The agent now explicitly negotiates that verified compatibility form. The upstream probe is rerun unchanged; its result is recorded in verification.md. A passing auth-discovery probe still does not validate actual IDE interaction, OS keychain prompts, public package availability or registry installation.

The development lint toolchain currently pulls a vulnerable minimatch range. The lockfile overrides minimatch to fixed 11.0.1; lint and type checking verify compatibility in this project. This override affects development tooling. The 0.1.5 installation audit was clean. Version 0.2.0 adds an upstream runtime/Zod advisory; see the release gate in [sandbox.md](sandbox.md).

## Scoped tool approvals (0.1.3)

[ACP v1 tool-call permissions](https://agentclientprotocol.com/protocol/v1/tool-calls) defines `kind` as a UI hint and leaves remembered scope/lifetime to the agent. The agent supplies separate `session` and `remember` option IDs, both `allow_always`, with explicit lifetime labels. This does not use an invented folder-trust RPC or client-side automatic approval. The installed PyCharm 263.7307.206 `AcpV1PermissionOptionMapperKt` preserves option IDs, names and kinds. Actual rendering of both choices in PyCharm and Air still needs interactive verification.

`permissions.ts` binds grants to canonical cwd, inference URL/header and authentication generation. Edit grants cover workspace text edits. Command grants bind exact executable, argv, terminal/fallback selection and the fallback environment. Only the documented development-command subset offers reuse; other commands remain once-only. Programs and project scripts are not immutable, and command grants are not an OS sandbox. MCP connection grants bind the full definition; tool grants also bind the original tool name, schema and metadata. Generated `mcp_i_j` names never identify an approval, so catalog reordering cannot transfer a grant to another server or tool. MCP tool grants cover all schema-valid arguments, including memory writes.

The private `permissions.json` stores SHA-256 identity fingerprints and redacted labels, not raw argv, headers, environment values or tool arguments. Session grants stay in memory. All reads validate the full store and reject unsafe modes, symlinks and excessive size. Writers acquire an exclusive same-directory lock, reread unrelated records, then use fsynced temporary files and atomic rename. Scope revocation rotates an epoch; all instances reread it before execution and before accepting a pending approval. Limits are 1000 scope records, 200 remembered grants per scope, and 3.5 MB encoded storage. A stale lock fails closed and requires inspection, never automatic lock deletion.

`/permissions revoke-tools` clears tool grants without removing workspace trust; `/permissions revoke` also blocks workspace access. Reconnection and history restoration discard session grants. A remembered edit still reports its actual diff and rechecks current content before writing. No grant bypasses workspace, sensitive-path, argument-schema, cancellation or backend checks. Revocation stops subsequent operations, not completed side effects or an already-running remote job.

## Codex comparison and command corrections (0.1.4)

The [versioned comparison](codex-comparison.md) records the installed Codex adapter,
its approval mapping, our corrected defects and remaining feature gaps. Our
ordinary command eligibility was too narrow for actual use. Inspection commands
and bounded literal shell forms now support exact session/persistent grants;
unsupported or high-risk forms explain why they remain once-only. This is still
not Codex's sandbox or a general shell analyzer. Original executable/argv values
are used both for the grant identity and execution; parsed commands are never
substituted or used as prefix rules.

A model tool operation now has one ACP ID through approval and execution.
Requests carry structured, redacted input. Approval changes the operation to
in-progress; only its execution outcome completes or fails it. Nonzero/unknown
command exits and local limit termination produce failed outcomes with output
retained. Tests cover these contracts with the same official ACP client and
without invoking a live model or actual destructive commands.

## Session permission selector (0.1.5)

[ACP session config options](https://agentclientprotocol.com/protocol/v1/session-config-options)
provide the standard selector mechanism. The agent adds `permissions` with
category `mode`, returns the complete option set on setup/change, and offers
`/permissions mode MODE_ID` as a fallback. It uses no JetBrains-private extension.
Choices are read-only inspection, per-operation approval, scoped grants, automatic
workspace edits, and automatic edits plus recognized development commands.
The default remains scoped grants. Workspace activation is independently required.

Automatic modes are explicit user choices held only in the live session. They
are bound to the permission-store epoch and reset when revoked, including from
another session/process. Persisted transcripts save the scoped default instead of
an automatic mode; read-only/ask modes are preserved. Invalid values and changes
during an active turn are rejected. Read-only mode hides mutation/command/MCP
schemas and also checks execution, so unexpected model calls cannot bypass it.
MCP processes are not started in read-only mode. Automatic development approval
does not authorize MCP connections or calls implicitly.

The [GitHub CLI API contract](https://cli.github.com/manual/gh_api) changes a
request to POST when field flags are supplied. The classifier therefore permits
only supported read subcommands and bounded relative-path GET forms without
payloads, header overrides or GraphQL. It never assumes that all `gh` invocations
are reads. Unit and ACP tests use synthetic command data and fake terminals;
no GitHub account or live service is accessed by these tests.

[Codex permissions](https://learn.chatgpt.com/docs/permissions) combine selectable
profiles with OS-enforced filesystem/network controls. Our selector changes
application approval policy only. File-tool path validation does not sandbox
commands, and an IDE terminal is not assumed to provide a sandbox. Broader
approval is not an equivalent replacement for Codex's execution isolation.

## OS execution boundary (0.2.0)

[Sandbox design and evidence](sandbox.md) describes the new default command and
local-MCP boundary. The agent uses the pinned standalone runtime 0.0.83 in a
separate broker per invocation. It does not share the runtime's global mutable
manager across sessions or use client terminals as an isolation guarantee.
ACP session options expose filesystem mode independently of approval policy.
Network grants include the exact host/port and sandbox mode. Scope expansion
and unsandboxed execution always require a fresh once-only approval.

`macos-sandbox.ts` hardens the pinned generated Seatbelt policy against Keychain
service IPC. Its wrapper-shape check fails closed. This coupling is deliberate
and tested; upgrading the runtime requires repeating the native Mach lookup and
filesystem/network enforcement tests. No existing keychain contents are read
by those tests. Linux uses the runtime's bubblewrap/seccomp path; native Windows
is refused. None of these mechanisms changes Open WebUI or introduces an ACP
backend extension.

The new dependency is justified by native OS enforcement and proxy filtering,
which standard Node APIs cannot supply alone. Apache-2.0 attribution is in NOTICE.
The locked upstream Zod advisory remains visible in npm audit and CI; it is not
resolved by application input bounds. This preview is not ready for general
publication or a complete Codex-equivalence claim.

## Administrator policy and advisory review (0.3.0)

[Managed policy](managed-policy.md) describes the fixed system policy location,
root ownership checks, exact destination rules, grant binding and active-turn
revocation. Enforcement precedes remembered permissions and model advice. The
backend checks destination policy before each authenticated HTTP request, including
setup and model discovery. No project or environment variable selects the policy.

The reviewer uses a separate, bounded conversation with an explicitly selected
model and `tools: []`. In Open WebUI v0.12.5, middleware snapshots `payload_tools`
and tests `is None`; an empty array explicitly skips normal tool injection.
This was checked in the tagged source and in request-contract tests. Verdicts
are advice in ACP permission content, never executable authority. Live model
judgment and deployment behavior remain unverified. The agent adds no telemetry.

Linux VM testing identified mount ordering, bundled seccomp-helper visibility and
private proxy-socket scope issues. [Sandbox evidence](sandbox.md) records the
corrections and the administrator-approved, guest-only AppArmor prerequisite.
