# Verification record

Date: 2026-11-13. This is a tested preview, not completed replacement acceptance. Raw sanitized automated output is in [test-output.txt](test-output.txt).

## Provider reasoning selector and source-preview preparation

The live deployment reports Open WebUI 0.13.3 and publishes provider reasoning
controls in addition to the upstream model-control shape. The agent now exposes
those options through ACP's Reasoning dropdown; no slash command is required in
clients that display config options. Model default omits the override, saved
model controls take precedence, model switching resets the selection and
restoration preserves a still-supported selection. Both coding completions and
delegated server tasks carry the corresponding request mapping.

Two synthetic live requests verified Off versus Low behavior: Off had no
reasoning content; Low returned 223 reasoning characters and reported 107
reasoning tokens. Both completed with no tool calls. Requests used `tools: []`,
no chat IDs, a 512-token limit and a 55-second timeout. No project content or
private configuration was recorded. Other levels, provider payload tracing and
the deployment extension's source provenance remain unverified. The upstream
0.13.3 tag does not include the extra metadata fields; see [design](design.md#reasoning).

On macOS 27.0 arm64, Node 26.11.1, package 0.3.0: **141 tests passed**, zero
failures or skips. [Sanitized output](test-output-reasoning.txt) includes tests
for provider metadata, malformed/unsupported options, custom-control precedence,
request mapping, defaults, model switching, restore without replay and delegated
task mapping. Lint, type checking, build and formatting passed. A fresh offline
`npm ci --ignore-scripts` completed from the lockfile. Its offline audit summary
does not replace the online audit, which still reports the upstream runtime/Zod
advisory. No dependency version or permission policy was changed.

The registry schema, upstream manifest/version checks and monochrome icon check
passed. The upstream public distribution check failed as expected because the
npm package is unpublished. No full registry or public installation pass is
claimed. npm authentication is unavailable. Linux, Windows, Air and interactive
PyCharm selector rendering were not re-tested for this change.

The npm tarball installed offline with lifecycle scripts disabled. Its clean
ACP v1 handshake, terminal-auth/logout discovery and real sandbox smoke test
passed outside the source checkout. The built agent read the live catalog and
returned Model default plus Off, Low, Medium and Max.

The existing Open WebUI Preview registration now launches
`~/.local/share/openwebui-acp-agent/0.3.0-reasoning-20261113/node_modules/openwebui-acp-agent/dist/cli.js`
through its absolute Node path. Only that entry changed; other agents, credentials,
sessions and grants were preserved. The private single-entry rollback file is
`~/.jetbrains/acp.openwebui-preview.before-reasoning-20261113T151708943923Z.json`.
Reconnect the IDE agent to load this build; selector rendering still needs user
acceptance.

## Scoped approval for Open WebUI-managed tasks

The user confirmed that the tools became usable after `/server-tools on`, then
requested session and persistent approval choices. The original delegated-task
implementation deliberately forced once-only approval. That special case is
replaced with the existing scoped permission mechanism.

The approval now offers once, session, remembered and decline choices. Reuse
covers any prompt with the same model, feature set and selected server tools,
inside the existing exact workspace/backend/authentication/policy scope. Fresh
model/catalog metadata and the contract version form part of the grant identity.
Scope changes and revocation require new approval. Unreported server behavior
remains outside the agent's control. Ask mode, administrator `alwaysAsk` and
approval advice retain once-only behavior; no automatic local mode creates a
remote grant. Server tools still require explicit enablement after restore.

Focused ACP tests passed for once/session/remembered behavior across prompts
and new sessions, feature-scope changes, revocation, ask mode and administrator
restrictions. Grant-identity tests verify model, catalog, capability and version
changes without storing prompts or secrets in the permission file. Existing
denial and late-cancellation coverage remains in place. Live IDE rendering of
the new choices remains a user acceptance item; no live server task was run by
the automated tests.

Observed on macOS 27.0 arm64 with Node 26.11.1 and package 0.3.0:
`npm test` passed **139 tests**, with zero failures or skips. Sanitized output
is in [test-output-server-grants.txt](test-output-server-grants.txt). Lint,
typecheck, build, formatting and documentation audits also passed. No dependency
or permission-store schema change was needed. Linux/Windows were not rerun.

Packing, offline installation with lifecycle scripts disabled and the installed
ACP/module/macOS-sandbox smoke test passed. **Open WebUI (Preview)** now uses
`~/.local/share/openwebui-acp-agent/0.3.0-server-grants-20261113/node_modules/openwebui-acp-agent/dist/cli.js`
through the existing absolute Node runtime. Its environment is empty; other
registrations and all credentials, sessions and trust/grant records were
preserved. The private single-entry rollback record is
`~/.jetbrains/acp.openwebui-preview.before-server-grants-20261113T145000690630Z.json`.
Reconnect and enable `/server-tools on` before checking the new choices.

## Optional Open WebUI-managed tasks

Implemented an opt-in delegated task alongside the existing local coding and
direct MCP loops. It discovers Open WebUI features and workspace/OpenAPI/MCP
tool IDs, supports search, generated images, knowledge/retrieval and explicitly
requested memory, and provides retained-chat links and execution evidence.
It does not enable remote terminals or the code-interpreter feature. Server
tools can expose other capabilities under the user's account/model permissions;
approval discloses that scope before creating a chat.

The live unauthenticated version endpoint returned **0.13.3** on 13 November.
Authenticated discovery initially returned **403** for `GET /api/v1/tools/`.
After the user saved additional endpoint prefixes, discovery succeeded and
returned **one managed MCP server**, with no additional login indicated.
No key, private tool metadata or deployment address was recorded. No live
inference, image generation, memory mutation or server chat creation was
attempted. Backend settings were changed by the user, not the agent.

The live API-key `/api/config` response omitted global search/image/memory
flags, while the model explicitly advertised those capabilities. Source
inspection confirmed that this handler resolves browser JWTs, not API keys.
Discovery now labels those model-advertised features as unverified rather than
disabled or known enabled; a regression fixture covers the public-only shape.

Contract verification used the pinned upstream 0.13.3 routes, middleware and
built-in image implementation, plus official API documentation; links and
material distinctions are in [design.md](design.md#open-webui-managed-tasks).
In particular, user-owned chat cancellation differs from the admin-only task-ID
stop API, and allowlist prefixes must omit trailing slashes. This implementation
rejects other backend versions until their contracts are reviewed.

Automated coverage uses deterministic fake Open WebUI HTTP services and the ACP
client. It covers discovery and invalid selections; separation of caller-owned
and server-native request bodies; prompt/task approvals; denial and late
cancellation before chat creation; read-only and administrator restrictions;
retained chats; cancellation without retries; malformed responses; server-side
interaction pauses; citations; authenticated image links/previews with size,
MIME/signature and redirect checks; model switching; and restoration without
replaying unknown remote jobs. Accepted API requests are not treated as evidence
of successful tool execution. Live execution and IDE image rendering remain
manual acceptance items.

Observed on macOS 27.0 arm64, Node 26.11.1 and package 0.3.0:

- `npm test`: **137 passed**, zero failures or skips. Output is in
  [test-output-server-tools.txt](test-output-server-tools.txt).
- Lint, strict type checking, build, formatting and documentation audits passed.
- No dependencies were added or updated. Linux and Windows were not rerun for
  this feature; prior platform results are historical evidence only.
- A final focused seven-test run also verified that `/status` lists the
  delegated tool without inference. Packing, offline installation with scripts
  disabled, and the installed-package ACP/sandbox/module smoke test passed.

The authorized **Open WebUI (Preview)** entry now points to the absolute Node
runtime and
`~/.local/share/openwebui-acp-agent/0.3.0-server-tools-20261113-r2/node_modules/openwebui-acp-agent/dist/cli.js`.
Its environment remains empty. Other registrations, credentials, trust and
sessions were preserved. The single-entry private rollback record is
`~/.jetbrains/acp.openwebui-preview.before-server-tools-20261113T143406339535Z.json`.
Reconnect before enabling **Open WebUI tools** or `/server-tools on`.
Final live discovery returned one managed MCP server and model-advertised
search, image and memory flags labeled unverified for server enablement.
Actual server execution and IDE rendering still require user acceptance.

## PyCharm IDE MCP connection fix

The user reached MCP startup after correcting a malformed API-key endpoint
allowlist. The failing server was PyCharm's native `stdioMcpServer` launcher,
not the separately configured workstation MCP service. The supplied descriptor
contained the IDE port, project path and MCP authentication token names; no
credential values were requested or copied.

Inspection of PyCharm 2026.3 build 263.7307.206 and real sandbox probes confirmed
the launcher read-scope and direct Java socket failures described in
[design.md](design.md#ide-mcp-compatibility). The fix maps this specific macOS
descriptor to the verified local SSE transport after approval. Other local
processes keep the sandbox. Generic SSE support is now advertised.

Observed on macOS 27.0 arm64 with Node 26.11.1, package 0.3.0, ACP SDK 2.6.0
(protocol v1) and MCP SDK 1.32.2:

- `npm test`: **130 passed**, zero failures or skips; sanitized output is in
  [test-output-mcp-sse.txt](test-output-mcp-sse.txt).
- `npm run lint`, `npm run typecheck` and build passed.
- Six new tests cover exact header/project mapping, narrow recognition,
  invalid descriptors, connection denial, late cancellation, HTTP 401,
  redirects, cross-origin message endpoints, malformed events, stalled startup,
  disconnects without replay, and the full ACP approval/tool loop. The ACP test
  also confirms that either stdio or destination administrator restrictions
  prevent connection, and that inference receives no MCP credentials.
- The restricted test runner initially blocked loopback listeners with EPERM.
  The successful suite used the approved runner needed for local fake servers
  and real OS sandbox tests. No application sandbox controls were disabled.
- Prettier and documentation audits passed. `npm pack`, offline installation
  with lifecycle scripts disabled, clean installed ACP initialization (including
  SSE capability discovery) and the installed macOS sandbox smoke test passed.
  The tarball contains the adapter and no private deployment address or
  application credential configuration.

The authorized **Open WebUI (Preview)** entry now uses the absolute Node
runtime and the entrypoint under
`~/.local/share/openwebui-acp-agent/0.3.0-mcp-sse-20261113/node_modules/openwebui-acp-agent/dist/cli.js`.
Its environment is empty. Other ACP entries, installed builds, credentials,
trust records and sessions were preserved. The private single-entry rollback
record is
`~/.jetbrains/acp.openwebui-preview.before-mcp-sse-20261113T135822351720Z.json`.
Reconnect or restart PyCharm to load the change. The connection approval should
show `direct IDE connection instead of stdioMcpServer` and the actual local URL
and project. Tool calls still require their applicable approvals.

Interactive PyCharm MCP tool use, standalone Air and Linux/Windows IDE launcher
behavior remain unverified for this change. No live MCP token or inference
credential was used in these tests. The existing upstream dependency advisory
and release limitations still apply.

## Setup terminal PATH failure and installed fix

Follow-up live observation: the user confirmed that the setup terminal now
accepts input. Two subsequent attempts on 13 November returned HTTP 403 from
model discovery. Bounded classification of the terminal output found `Checking
access`, the agent's access-denied diagnostic and setup-failed message, with no
connected message. The AI Assistant terminal handler nevertheless logged its
flow as completed successfully before the retried ACP request reported missing
authentication. This is not successful backend authentication; setup correctly
does not save a key when model discovery fails. The active server API-key
permissions and endpoint restrictions remain unresolved. No server settings or
credentials were changed during this investigation.

The user reported that logout worked but login briefly opened a terminal and
closed before input. Bounded classification of the PyCharm 2026.3 logs identified
`env: node: No such file or directory` in the terminal-auth process. No raw logs
or credential values were copied into this repository. The main ACP process had
found Node, but the login terminal used a different PATH.

Read-only inspection of the installed terminal-auth handler confirmed that the
legacy client replaces the normal launch arguments. The legacy descriptor now
includes the absolute installed `cli.js` entrypoint before `--setup`. Standard
terminal authentication continues to append `--setup`. Local registration uses
an absolute Node executable; no wrapper script, shell configuration or environment
override was added.

Observed 13 November 2026 on macOS 27.0 arm64, Node 26.11.1:

- `npm test`: **124 passed**, zero failures or skips. Output is in
  [test-output-terminal-path.txt](test-output-terminal-path.txt).
- The real PTY success test now uses PATH `/usr/bin:/bin`, the advertised legacy
  replacement arguments, legacy appended arguments and standard appended
  arguments. All three complete setup against fake services with masked keys.
- Lint, typecheck, build, Prettier and documentation audits passed.
- Packing, offline installation with scripts disabled, clean ACP initialization
  and the installed sandbox smoke test passed.
- The exact installed Node/entrypoint launch was tested with the restricted PATH
  and empty application state. Its advertised legacy terminal command stayed
  open at the URL prompt. Cancellation exited without writing configuration.

**Open WebUI (Preview)** now launches the existing absolute Node runtime with
the entrypoint under
`~/.local/share/openwebui-acp-agent/0.3.0-terminal-auth-20261113/node_modules/openwebui-acp-agent/dist/cli.js`
and the `acp` argument. Its environment remains empty. The previous build remains
installed, and unrelated ACP entries, credentials, sessions and grants were
preserved. The private single-entry rollback record is
`~/.jetbrains/acp.openwebui-preview.before-terminal-path-20261113T132636249536Z.json`.

Reconnect the agent or restart PyCharm before retrying login. Interactive IDE
acceptance and live API authorization remain separate from the reproduced
terminal-launch test. No backend settings were changed.

## HTTP 403 authentication recovery and PyCharm update

The user reported that `/login` and `/logout` both failed before session creation
because model discovery returned HTTP 403. The earlier tests covered successful
discovery and expired credentials but missed this authorization failure before
chat-command dispatch.

The fix creates a restricted session for model-discovery HTTP 403 during both
new-session creation and restoration. Login, logout, status and diagnostics stay
available; workspace activation, configuration selectors, MCP startup and coding
tools remain disabled. `/doctor` can recheck discovery, but reconnect is required
after access is restored. No server restriction is bypassed or changed.

Observed 13 November 2026 on macOS 27.0 arm64, Node 26.11.1:

- `npm test`: **124 passed**, zero failures or skips. Output is in
  [test-output-auth-recovery.txt](test-output-auth-recovery.txt).
- Lint, typecheck, build, Prettier and documentation audits passed.
- The new regression covers new/load, modern and legacy terminal authentication,
  unsupported-client fallback, unavailable tools, ignored editor context and MCP
  definitions, logout without another backend request, and setup/reconnect.
- Fresh packing and offline installation with lifecycle scripts disabled passed.
  The installed-package test verified clean ACP output, authentication/logout
  discovery and real macOS sandbox execution outside the checkout.
- The exact installed executable was also tested over stdio against a fake
  backend returning 403. Session creation succeeded with no config options;
  `/login` returned the setup action with the 403 explanation. No protected
  operation was requested. Tests used isolated state and synthetic credentials.

The existing **Open WebUI (Preview)** entry now points to
`~/.local/share/openwebui-acp-agent/0.3.0-auth-recovery-20261113/node_modules/.bin/openwebui-acp-agent`.
The prior build remains installed. Only that executable path changed; other ACP
entries, the empty preview environment, mode 0600, credentials, grants and
sessions were preserved. The single-entry rollback record is
`~/.jetbrains/acp.openwebui-preview.before-auth-recovery-20261113T130900721342Z.json`.

Reconnect the agent or restart PyCharm before retesting. Interactive IDE rendering
and live backend access remain unverified for this fix. Linux and Windows were
not rerun; previous release gates remain applicable.

## PyCharm authentication-controls installation

On 13 November 2026, the user authorized installing the tested authentication
controls. PyCharm was rechecked at 2026.3, build 263.7307.206. A fresh local
0.3.0 package was installed offline with lifecycle scripts disabled into
`~/.local/share/openwebui-acp-agent/0.3.0-auth-controls-20261113`. The separate
directory distinguishes this build from the previous 0.3.0 installation.

Installed authentication modules matched the fresh build. The package test
passed clean ACP v1 initialization, terminal authentication and logout discovery,
and a real macOS sandbox command outside the checkout. The exact executable
also passed the legacy JetBrains terminal-auth handshake with empty stderr.
All checks used isolated application state and no live credentials.

Only the executable path for **Open WebUI (Preview)** in `~/.jetbrains/acp.json`
changed. Arguments remain `["acp"]`, the environment remains empty, and the file
retains mode 0600. Unrelated configuration was compared and preserved. The
single-entry rollback record is
`~/.jetbrains/acp.openwebui-preview.before-auth-controls-20261113T130130207547Z.json`.
The prior installation, credentials, sessions, grants and plugins remain intact.

Reconnect the agent or restart PyCharm to load this build. Existing processes
were not terminated. Interactive login/logout presentation and live backend
access remain manual tests; installation checks do not establish those results.

## Chat authentication controls (unreleased source update)

On 13 November 2026, the 0.3.0 source gained `/login`, `/logout` and stable ACP
`logout` capability support. The PyCharm package was unchanged during that
implementation; the subsequent installation is recorded above. Tests used
isolated state, a fake credential store and loopback
services; no live credential was read or removed.

Observed on macOS 27.0 arm64 with Node 26.11.1 and ACP SDK 2.6.0 (protocol v1):

- `npm run lint`, `npm run typecheck`, `npm run build`: passed.
- `npm test`: **123 passed**, zero failures or skips. Sanitized output is in
  [test-output-auth-controls.txt](test-output-auth-controls.txt).
- Prettier checks passed. README and design documentation audits reported no
  findings.
- `npm pack` and offline installation into a temporary prefix passed with
  lifecycle scripts disabled during installation. `test/package-install.mjs`
  verified clean ACP stdout, terminal authentication and logout capability
  discovery, and a real sandbox command outside the source checkout.
- Tests cover modern and legacy terminal authentication, the unsupported-client
  fallback, chat-command discovery on new and restored sessions, attached editor
  context, rejected command arguments, logout before setup and repeated logout.
- Both logout entrypoints remove the stored key and invalidate all sessions on
  the connection. Tests verify environment-key blocking, late permission replies,
  inference and command cancellation, MCP client cleanup, and safe credential-store
  failure messages.
- A separate CLI process can sign out an active agent. Logout during model
  discovery cannot create or restore a session using an old credential. Setup
  followed by reconnect restores a transcript without replaying actions.

Interactive PyCharm/Air rendering of `/login`, an IDE-native logout action and
the new sign-out/reconnect flow remain unverified. Linux and Windows were not
rerun for this change. No live backend, server configuration or IDE profile was
changed. Existing dependency-advisory and release gates still apply.

## PyCharm preview upgrade to 0.3.0

On 13 November 2026, the user authorized installation for interactive testing.
PyCharm was rechecked at 2026.3, build 263.7307.206, with bundled
`com.intellij.air` 263.7307.206-mac-arm64.

The fresh package includes `AGENTS.md`. Offline installation with lifecycle
scripts disabled succeeded in `~/.local/share/openwebui-acp-agent/0.3.0`.
The installed-package test passed: ACP v1 initialization, version 0.3.0,
terminal authentication discovery, clean stdout/empty stderr and a real
sandboxed command from outside the checkout, using isolated test state.

Only the executable path of **Open WebUI (Preview)** in `~/.jetbrains/acp.json`
was changed. Its arguments remain `["acp"]` and its environment remains `{}`.
Other entries and top-level settings were compared and preserved. The update
was atomic and retained the registration file's 0600 mode. The exact registered
executable also passed initialization with JetBrains' legacy terminal-auth
capability. This shared registration can be seen by other JetBrains clients;
it is not exclusive to PyCharm.

The previous non-secret entry is saved in
`~/.jetbrains/acp.openwebui-preview.before-0.3.0-20261113T123840252646Z.json`.
This is a single-entry rollback record, not a replacement for the whole ACP file.
The 0.1.5 executable remains installed. Application configuration, credentials,
grants, sessions, the legacy helper and installed plugins were not changed.

Reconnect the agent in PyCharm before testing the new Sandbox and Approval
advice selectors. Existing running agent processes were not terminated. No live
inference, setup interaction or GUI acceptance is claimed by these launch tests.
The known dependency advisory and public-release gates remain unresolved.

## Administrator rules, advisory review and Linux verification (0.3.0)

Observed 13 November 2026:

- macOS 27.0 arm64: **115 tests passed**, no failures or skips.
- Ubuntu 24.04.5 LTS x86_64 in a disposable QEMU/KVM VM: **112 passed**,
  no failures, three skips (two macOS PTY setup tests and the macOS Keychain
  service test). [Linux output](test-output-linux.txt) records the complete run.
- Both platforms: lint, strict type checking and build passed. Node 26.11.1,
  npm 11.20.0, ACP SDK 2.6.0/v1 and runtime 0.0.83 were used.
- Linux: kernel 6.8.0-147-generic, bubblewrap 0.9.0-1ubuntu0.3,
  socat 1.8.0.0-4ubuntu0.1, ripgrep 14.1.0-1,
  AppArmor 4.0.1really4.0.1-0ubuntu0.24.04.9.
- Root-owned policy integration fixtures: valid policy accepted; absent file
  accepted as unmanaged; 11 unsafe/corrupt cases refused. Cases include wrong
  owner, writable files/parents, symlinks, malformed/unknown JSON, a FIFO and
  excessive size. These tests ran as the unprivileged guest user.
- `npm ci --ignore-scripts` passed from the project lockfile on both
  platforms. No dependency version changed in 0.3.0.
- `npm audit --omit=dev`: still **two high findings** for the runtime/Zod
  advisory. Runtime 0.0.83 remains the latest observed published version.
  No advisory suppression or unsupported override was added.
- `npm pack` and clean temporary installations on macOS and Linux passed. The installed
  0.3.0 executable returned only ACP v1 JSON, advertised terminal setup, and
  ran a real sandboxed command from outside the checkout. The package excludes
  tests, local state and private deployment configuration. Linux needed registry
  metadata after an offline-cache miss; online installation then passed.
- Registry structural validation against the unchanged upstream schema passed.
  The registry reference is pinned to 0.3.0; public package availability and
  registry/IDE installation acceptance remain unverified.

The VM initially denied namespace capabilities through AppArmor. The user
explicitly approved a per-executable bubblewrap profile inside that VM. Its
syntax was checked before loading. The global
`kernel.apparmor_restrict_unprivileged_userns=1` setting remained enabled. The
workstation host's security settings, Kubernetes workloads and existing libvirt
configuration were not changed. No GUI was needed.

The real Linux tests found and verified fixes for Git child/parent deny ordering,
visibility of the single bundled seccomp helper in a user installation, and
private proxy bridge socket placement. See [sandbox.md](sandbox.md). The minimal
upstream reproduction fails without ordered denies and passes with
`--ordered-denies`. No protection or test assertion was removed. A test wait was
also bounded by command completion so failed proxy startup cannot hang that case.

New deterministic tests cover administrator precedence over saved and automatic
grants, denied modes/escalation/MCP/network, policy changes during approval and
active execution, exact destination checks before HTTP, reviewer model/request
mapping, malformed/oversized responses, credential redaction, timeout and
cancellation. An advisory `approve` still requires human permission; restored
sessions turn advice off. The Open WebUI 0.12.5 empty-tools behavior was verified
in tagged source, not through live inference in this turn.

No live review-model judgment evaluation, new PyCharm/Air selector acceptance,
native Windows execution, or full registry installation is claimed. Automatic
model approval is not enabled. The installed IDE preview, old helper, credentials
and user sessions were not replaced. The dependency advisory remains a general
release gate. Earlier version records below are historical.

## Sandbox implementation verification (0.2.0)

Observed 13 November 2026 after a clean locked dependency install:

- `npm ci --ignore-scripts --cache /private/tmp/openwebui-acp-npm-cache`: passed,
  193 packages installed. Audit reports **two high findings**, covering the
  runtime and its Zod dependency. See [dependency-audit.json](dependency-audit.json).
- `npm run lint`, `npm run typecheck` and `npm run build`: passed.
- `npm test`: **100 passed**, zero failures/skips. This includes real macOS OS
  enforcement, local fake HTTPS/MCP/inference servers and ACP clients.
- Prettier check over source, tests and package/registry JSON: passed.
- `npm pack`: passed; `openwebui-acp-agent-0.2.0.tgz` contains the compiled
  broker, policy modules and NOTICE. No source/test fixtures, private state or
  deployment addresses are included.
- Offline installation of that tarball into an isolated temporary prefix:
  passed, 105 packages. Launch from a different temporary cwd returned only
  valid ACP v1 JSON, version 0.2.0 and terminal authentication metadata, with
  empty stderr and no credentials. A real sandboxed command from the installed
  package also passed.
- Registry manifest: passed the unchanged upstream v1 schema with Ajv and URI
  formats. This is local structural validation; package URLs remain unpublished.
- Documentation clarity audit: no findings for the sandbox guide.

The new tests exercise real workspace writes and denied sibling/symlink reads
and writes; protected Git metadata and agent executables; read-only mode;
explicit path exceptions; literal argv and path metacharacters; exact host/port
network approval; denied direct sockets; verified HTTPS with a synthetic CA;
credential environment separation; proxy-token redaction across fragments;
ordinary descendant cleanup; process/output limits; late cancellation replies;
isolated concurrent runners; sandbox selector persistence/revocation; changed
mode/grant scope; local MCP filesystem isolation and bounded malformed frames.
A compiled macOS fixture checks only Mach service lookup: the credential service
exists outside the sandbox and lookup is denied inside it. No existing keychain
contents or real credentials are opened or read.

The source retains Linux integration and adds CI prerequisites for bubblewrap,
socat and ripgrep. Local Docker was unavailable and the existing Podman VM was
stopped. Neither was started or reconfigured. No Linux/WSL enforcement or native
Windows execution is claimed. Native Windows remains disabled pending storage
ACL and sandbox lifecycle implementation/testing. CI definitions are prepared,
not observed executions; the dependency-audit job currently remains a failing
release gate.

No new live Open WebUI, AI Assistant or Air acceptance was performed for 0.2.0.
The existing installed 0.1.5 preview and ACP registration remain unchanged.
See [sandbox.md](sandbox.md) for current controls, compatibility limits and the
explicit differences from Codex. A complete Codex-equivalence claim is not made.

## Observed versions and coverage

| Component | Version / observation |
| --- | --- |
| Agent package | 0.3.0, unpublished; installed preview upgraded to 0.3.0 with 0.1.5 retained for rollback |
| Local platform | macOS 27.0, build 26A428, arm64 |
| Node / npm | 26.11.1 / 11.20.0 |
| TypeScript | 5.9.3, strict |
| ACP SDK / protocol | 2.6.0 default stable export / v1 |
| MCP SDK | 1.32.2 |
| Credential library | @napi-rs/keyring 2.1.2; user reports successful IDE setup; full store lifecycle acceptance pending |
| Open WebUI | Public version endpoint independently returned 0.12.5; user reports successful login and messaging; full deployed contract suite pending |
| IntelliJ IDEA installed | 2026.3, 263.7307.200; interactive ACP acceptance unverified |
| PyCharm installed | 2026.3, 263.7307.206; user reports login and messaging working; full acceptance pending |
| Standalone Air installed | 262.1037.14; interactive ACP acceptance unverified |
| Linux / Windows | CI definitions prepared; no observed CI executions. Windows runtime storage is unsupported in this preview. |

Installed product versions came from product-info.json. The bundled shared ACP plugin `com.intellij.air` was also inspected: `263.7307.200-mac-arm64` in IDEA and `263.7307.206-mac-arm64` in PyCharm. Bytecode inspection establishes legacy terminal-auth support in those builds; it does not establish observed UI behavior or compatibility across all JetBrains IDEs. Version inspection made no profile or plugin changes; later preview registration updates are recorded below.

## Previous 0.1.5 commands and results

- `npm ci --ignore-scripts --cache /private/tmp/openwebui-acp-npm-cache`: passed from the lockfile; 188 packages installed; audit reported zero vulnerabilities.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, **81 tests**, zero failures/skips, with deterministic loopback Open WebUI and MCP servers plus official ACP client and raw stdio probes.
- `npm run build`: passed, including the build run by tests and prepack.
- `npm pack --cache /private/tmp/openwebui-acp-npm-cache --json`: passed. A temporary cache avoids the protected workstation npm cache; no ownership changes were made to that cache.
- Packed installation into an isolated `/private/tmp` prefix with scripts disabled: passed. Its executable launched with cwd outside the checkout, returned protocol v1 and advertised terminal authentication to a capable client.
- Upstream `agent.schema.json` validation using Ajv plus URI formats: passed for registry/agent.json. Original icon dimensions and currentColor were inspected.
- Unchanged upstream registry auth client against the local executable: **passed**, one terminal method discovered. The earlier failure was resolved by implementing the legacy capability explicitly verified in installed JetBrains client code. The validator itself was not changed.
- `git diff --check`: passed. All implementation files are new/uncommitted; existing IDE metadata is preserved and ignored. No commit/push/publication was performed.

Initial sandbox attempts could not resolve npm hosts or bind loopback sockets. Authorized dependency access and local-test execution resolved those restrictions. An offline clean install could not complete because some tarballs were absent from the selected cache; the network-enabled clean install passed. Initial dependency advisories were resolved with fixed production pins and a documented development minimatch override. Initial compile/test failures were corrected; test-output.txt contains the final passing run, not the failed intermediate runs.

## Automated evidence

Tests cover URL prefixes and unsafe URL rejection; text/UTF-8/tool-argument fragmentation; non-streaming replies; HTTP 401/403/404/429/500; redirect rejection; malformed JSON and response limits; credential redaction across event boundaries; multiple tools and model rounds; result IDs; local approved edits; client unsaved content and stale approval; permission decline/invalid replies; cancellation with a late reply; canonical paths, traversal, symlink escape, root/home rejection and sensitive/ignored files; concurrent trust writers, corrupt/symlinked trust files and POSIX modes; destination changes; active-session revocation; two actual Git worktrees with independent consent and isolated model selection; transcript restore without tool replay; reasoning defaults, invalid values, request mapping, model switching and restoration; authentication generation invalidation; local command cancellation and credential environment separation; client terminal approval and release; MCP startup denial, stdio/HTTP discovery, name collisions, schemas, authentication separation and redirect rejection; clean stdio and login argv variants.

Mock request assertions prohibit chat IDs and server-tool selectors. They demonstrate this agent's request contract; they do not execute Open WebUI's deployed middleware. Only the unauthenticated version probe contacted the identified installation.

## Milestones and remaining acceptance

| Milestone | State |
| --- | --- |
| A: handshake, setup, activation, completion, approved edit | Mock completion/edit slice and built-in setup flow pass. Interactive real OS-store setup and live completion remain unverified. |
| B: coding loop and session controls | Implemented and covered by focused tests, including reasoning. Release hardening and remaining cases below are incomplete. |
| C: direct MCP | Both required transports pass fixture tests. Actual workstation search/retrieval/memory and IDE MCP are unverified. |
| D: package, registry, IDE acceptance | Local packed install/launch passes; schema passes. Upstream auth-discovery check passes. Registry installation and interactive IDE acceptance are pending. |

The complete requested test matrix is not yet satisfied. Remaining engineering/automated work includes Windows ACL storage and process-tree behavior, all filesystem alias/case/race cases, hanging client operations and MCP disconnect/malformed-result coverage, TLS certificate fixtures, real OS credential-store acceptance, and stronger transport-level resource bounds. These are not all blocked by backend availability and must be addressed before a complete release claim.

Live acceptance needs a locally supplied API key and confirmation that endpoint restrictions permit `/api/models` and `/api/chat/completions`. Never send a key in chat. Verify model IDs, tool calling, non-streaming overrides and reasoning effectiveness against the actual inference backend. No provider reasoning behavior has been observed.

Interactive acceptance must record actual AI Assistant and Air client/plugin versions, isolated-profile setup, workspace choices, diff editing, commands, cancellation, MCP, worktrees, restoration and registry installation. The external registry override was not verified in either inspected client. The bounded JAR search found no matching key; it is not proof that the feature is absent. No normal-profile override was read or changed. See release.md for the restoration procedure.

Registry distribution remains a proposal: the package URL does not yet exist, author/repository metadata needs an authorized destination, and public-artifact checks cannot pass yet. No public repository, npm publication or registry submission was attempted. The existing solution must remain installed until successful replacement acceptance and separate retirement authorization.


## IDE-driven authentication update (0.1.1)

The primary setup path is the IDE's **Set up Open WebUI** action. `src/auth.ts` negotiates modern ACP terminal auth or the verified JetBrains legacy extension. `src/setup.ts` implements URL/key entry, validation, masked input, cancellation and credential-store persistence. No browser, shell wrapper or project script is part of the product flow. Model selection stays in the ACP session controls.

Ten added auth tests cover capability negotiation, first-use auth-required errors, successful setup/reconnect, legacy post-terminal verification, invalid/revoked credentials, cancellation, logout, secure-store failure and clean stdout. macOS pseudo-terminal tests exercise the actual built CLI with replacement/appended `--setup` arguments, masked key entry, successful exit and Ctrl+C cancellation. A shell pipeline is used only by the test harness to give macOS `script` a real pipe instead of Node's socket-backed stdin; it is not shipped or needed by users.

Credential-store success tests use a test-process-only Node module hook with an in-memory keyring and synthetic keys. No real workstation credential was read or written. This demonstrates the application flow, not successful interaction with macOS Keychain access dialogs. Real IDE click-through, actual keychain prompts and authenticated backend inference still require acceptance. The earlier PTY harness socket incompatibility and missing EOF on cancellation were fixed; the final run contains no skips on macOS.

## PyCharm preview installation (13 November 2026)

At the user's request, version 0.1.1 was installed from the local tarball into
`~/.local/share/openwebui-acp-agent/0.1.1` using npm with lifecycle scripts
disabled and the existing offline cache. Installation passed (100 packages).
The installed executable returned ACP v1, agent version 0.1.1 and the expected
legacy terminal-auth descriptor when launched outside the source checkout.
With a separate empty application directory, `session/new` returned the
expected authentication-required error (-32000); stdout contained only ACP
responses and stderr was empty.

PyCharm was rechecked: 2026.3, build 263.7307.206, with bundled
`com.intellij.air` version 263.7307.206-mac-arm64. An **Open WebUI (Preview)**
entry was added to `~/.jetbrains/acp.json`, using the installed executable,
`["acp"]` arguments and an empty `env` object. The original file was backed up
as `acp.json.before-openwebui-20261113T083037916766Z`. A comparison verified
that all previous entries and settings were preserved. This configuration is
shared by JetBrains clients; the entry is not exclusive to PyCharm.

The local test project `~/IdeaProjects/openwebui-acp-smoke-test` contains only
test instructions and `note.txt`. The macOS command to open it in PyCharm
completed successfully. This does not establish that the agent was selected
or authenticated in the IDE. User observation of setup, real inference,
workspace consent, edits and commands is pending. The companion plugin remains
untouched, so this is not the isolated-profile acceptance test without it.
No registry override, deployment settings or credentials were changed by the
installation. Public registry installation remains unverified.

For rollback, close preview sessions and remove only **Open WebUI (Preview)**
from `agent_servers`, preserving any later configuration changes. The original
Qwen entry remains available. Do not restore the entire backup over newer
settings or delete preview transcripts without checking whether they are needed.

### First live setup attempt

The user reached the URL and API-key prompts through PyCharm's setup action.
A bounded scan of the IDE log, emitting only recognized diagnostic messages,
found `Checking access` followed by `Access denied; check API-key permissions`
on both recorded attempts. That message is the agent's HTTP 403 response from
model discovery (`GET /api/models`). Neither `config.json` nor `auth-state.json`
existed afterward. Successful credential storage and inference remain unverified.

The subsequent ACP authentication-required message is a consequence of incomplete
setup; it does not establish that an API key expired. The previously reported
endpoint restrictions are a likely cause, but the active allowlist and account
permissions have not been inspected. An administrator must verify that API keys
are enabled, the account has API-key permission, and the existing allowlist
includes `/api/models` and `/api/chat/completions`. Preserve other allowed routes.
No server setting was changed, key inspected or credential rotated during diagnosis.

A subsequent check found the same 403 setup failure at 08:38 on 13 November.
PyCharm then logged successful completion of its terminal authentication flow,
followed by ACP authentication-required. The agent's `Connected to Open WebUI`
message was absent and both configuration files were still absent. The client's
success indication therefore does not establish successful agent setup.

An unauthenticated transport probe of the configured installation returned HTTP
200 for `GET /api/chat/completions` and HTTP 401 for `POST /api/chat/completions`
with an empty JSON object. No credentials, model or prompt were sent. This shows
an authentication boundary on the POST route, not successful inference. Opening
the URL in a browser does not test the documented POST completion operation.

### Independent API-key comparison

The user reported that PyCharm HTTP Client returned HTTP 401 and a
`Not authenticated` JSON detail for both requests without credentials.
An independent authenticated `GET /api/models` was then made with a key entered
by the user in a one-time masked macOS dialog. The diagnostic kept the key in
process memory, refused redirects, used normal TLS verification and printed only
HTTP status, a recognized error category and an input-whitespace flag. It returned
HTTP 403 with category `permission_denied`; the key had no surrounding whitespace.
No key or raw response body was saved or printed.

This reproduces the access denial outside ACP and outside the agent's terminal
input handler. It does not identify which server permission check rejected the
request. Active API-key enablement, account/group permission and endpoint allowlist
still require administrator verification. No deployment setting was changed.

## IDE prompt-context correction (0.1.2)

The user added the missing API routes to the server's allowlist and subsequently
reported that PyCharm authentication worked. A chat then returned `Only text
prompts are supported`. The source rejected every non-text content block, including
resource links that ACP v1 requires all agents to accept. The available log did not
expose the exact failing prompt's content types, so no user prompt contents were
copied into fixtures.

The correction supports text, inert resource references, embedded text and bounded
UTF-8 text blobs. Images, audio and other binary attachments remain unsupported.
Nine added tests cover mixed content, metadata/UTF-8 bounds, malformed/binary
inputs, no eager URI retrieval, unsaved editor content, credential redaction,
restoration without inference, decline/invalid permission/cancellation, embedded
file scope and symlinks, and diagnostic commands with attachments. Initial fixture
failures involved macOS's temporary-directory alias and attempting to reload an
already-loaded session; the fixtures now use canonical paths and a new agent for
restoration. The complete final run passed all 48 tests. Lint, strict type checking
and build passed. Live messaging with the corrected package still needs user
acceptance in PyCharm; successful mock requests do not establish live inference.

The user also reported that both HTTP Client requests now work, and clarified
that this did not refer to agent chat. Exact successful HTTP statuses and bodies
were not supplied, so this is recorded as a user report rather than observed
completion inference.

The 0.1.2 tarball was installed offline into
`~/.local/share/openwebui-acp-agent/0.1.2` with lifecycle scripts disabled. Its
executable passed an outside-checkout handshake with clean stdout/stderr, reported
version 0.1.2, advertised embedded context and retained terminal authentication.
Only the existing preview entry's executable path was switched from 0.1.1 to
0.1.2. A comparison verified that all other ACP configuration was preserved; a
dated backup was created. The previous installation and application credentials,
trust and transcripts were left in place. Existing running chats must reconnect
to launch the new version.

## Scoped approvals update (0.1.3)

The user reported working PyCharm messaging and requested session/persistent choices for file edits, commands and MCP tools. These were missing from tool operations: only workspace activation previously offered remembered trust.

Version 0.1.3 implements separate allow-once, session and remembered tool grants. Focused tests cover all three lifetimes, transcript restore without session grants, continued workspace activation, exact command arguments, once-only high-risk commands, MCP server/tool identity across catalog index changes, stale edits, path escapes, deny/invalid/cancelled responses, revocation while a reply is pending, backend/auth scope separation, private store modes, corruption, symlinks, atomic replacement and concurrent writers of both shared and unrelated scopes. Store fixtures use no real credentials.

`npm test` passed 61 tests with zero failures/skips on macOS and Node 26.11.1. The first sandbox run could not bind loopback ports; the authorized local fixture run passed. One new test initially expected a detailed stale-edit notification; the existing agent emits a generic failed tool outcome. The test now verifies both failed outcomes and unchanged file contents, without changing runtime error redaction. Sanitized final output is in `test-output.txt`.

PyCharm bytecode inspection confirmed that its ACP v1 option mapper retains IDs, labels and kinds. After installation of 0.1.3, the user initially reported “All working,” then clarified that this did not apply to `run_command`. The subsequent comparison below identifies the command eligibility policy as the cause. The report did not itemize reconnect persistence, revocation or each other tool type, so it does not establish full manual acceptance. Air and registry installation remain unverified. No claim is made that this feature matches every Codex or Claude permission mode.

The 0.1.3 package passed lint, typecheck, build, registry structural validation,
package-content inspection and offline installation with lifecycle scripts disabled.
Its installed executable completed a clean ACP v1 handshake outside the source
checkout, without credentials, and advertised terminal setup. The existing
**Open WebUI (Preview)** registration now points to the versioned 0.1.3 install.
All other agent entries were compared and preserved. The private rollback backup
is `~/.jetbrains/acp.json.before-openwebui-0.1.3-20261113T093648181992Z`;
version 0.1.2 remains installed. No credential or trust record was changed by the
installation. Reconnect the agent to load the new executable.

The technical-writing audit reported no findings for README.md, design.md and
verification.md. These are advisory clarity checks, not formal certification.

## Codex comparison and command approval correction (0.1.4)

The user clarified that `run_command` still offered only once-only approval.
Read-only comparison used installed `@agentclientprotocol/codex-acp` 2.6.0,
`@openai/codex` 0.166.0, the adapter's matching versioned public source and official
OpenAI app-server documentation. The full findings and feature matrix are in
[codex-comparison.md](codex-comparison.md).

A bounded, redacted check of the latest three local session files found seven
command invocations. All seven lacked remembered choices under the 0.1.3
eligibility policy; all seven qualify under the corrected policy. Only aggregate
counts and known executable categories were emitted. No commands were replayed.
This establishes the missing-options cause, not interactive acceptance of 0.1.4.

The 0.1.4 changes add ordinary inspection/literal-shell eligibility, disclose
once-only restrictions, keep a single tool-call ID through approval and execution,
include structured command input, and report failed command exits without losing
output. The 71-test suite passes with deterministic fixtures. New checks exercise
literal quoting/pipelines, rejected shell expansion/substitution/redirection,
side-effecting find predicates, exact full-script grants, forged repeat replies,
one-ID lifecycle order and nonzero exit output. Initial test failures exposed a
macOS path alias in the fixture and an old expectation that a literal `sh -c npm
test` could never receive a grant; canonical fixture roots and explicit positive
and negative shell cases now verify the intended behavior.

Lint, strict type checking and the technical-writing audit passed. The new
command choices still need confirmation in a reconnected PyCharm session. Air,
isolated registry installation and the remaining release gates are unchanged.

The final 0.1.4 tarball passed registry structural validation and inspection for
private deployment addresses/state files. Offline installation with lifecycle
scripts disabled passed. The installed binary returned one valid ACP v1 initialize
response, version 0.1.4 and terminal authentication, with empty stderr, from outside
the source checkout and an isolated empty application directory.

Only the existing **Open WebUI (Preview)** executable path was changed from 0.1.3
to 0.1.4. A comparison verified that all remaining ACP configuration was preserved.
The private rollback backup is
`~/.jetbrains/acp.json.before-openwebui-0.1.4-20261113T101234672661Z`.
Previous installations, credentials, grants, transcripts and the old helper remain
in place. Reconnect the agent in PyCharm to test the new choices; an existing agent
process continues to use its loaded version.

## Permission selector and GitHub commands (0.1.5)

The user confirmed progress with 0.1.4 but reported once-only approval for `gh`
and requested an IDE dropdown, explicitly including a broader session policy.
The agent now returns a standard ACP Permissions selector with five modes and a
slash-command fallback. Supported GitHub reads and basic API GET requests qualify
for exact grants and the opt-in development policy. Mutations and unknown forms
remain approval-gated. No OS sandbox has been implemented or advertised.

The 81-test fixture suite passes, including selector values and invalid values,
no inference during settings changes, ignoring stored grants in ask mode,
automatic edits/eligible commands without implicit workspace activation,
continued mutation approval, read-only enforcement despite existing grants,
blocked MCP startup, session isolation, safe restoration, cross-session revocation
and rejection of mode changes during a pending tool approval. An initial test
exposed that a generic busy error was hidden by the SDK as Internal error; the
handler now returns an actionable ACP invalid-params error without changing the
pending approval. Test cleanup also releases pending requests on assertion failure.

GitHub tests cover safe reads and GET forms, implicit POST field flags, mutation
methods, GraphQL, payload input, header/host overrides and credential operations.
They run no actual `gh` commands. Client presentation of the dropdown and the new
policy in PyCharm/Air still need interactive confirmation. Existing registry,
Windows and broader release acceptance limits remain unchanged.

For 0.1.5, lint, strict type checking, build, formatting and documentation audits
passed. Registry structural validation and package inspection passed. Offline
installation with lifecycle scripts disabled succeeded; the installed executable
returned a clean ACP v1 initialize response with version 0.1.5 and terminal auth
from outside the checkout with isolated empty application state.

The existing **Open WebUI (Preview)** entry now points to the versioned 0.1.5
installation. All remaining ACP configuration was compared and preserved. The
private rollback backup is
`~/.jetbrains/acp.json.before-openwebui-0.1.5-20261113T103528963669Z`.
Previous versions, the old helper, credentials, grants and transcripts remain in
place. The default permission mode remains scoped approvals; no broader policy
was enabled in a live user session by installation. Reconnect before checking the
Permissions selector in PyCharm. OS sandboxing remains unimplemented.
