# Working on openwebui-acp-agent

This is the project guide for coding agents. Follow applicable workstation
instructions as well. Read the relevant source and tests before editing; this
guide does not replace the implementation or authorize deployment changes.

## Product and model independence

Build an unofficial, standalone local Agent Client Protocol (ACP) coding agent.
ACP clients communicate with the agent over stdio; the agent uses a configured
Open WebUI installation for inference. The product includes the conversation and
tool execution loop. It requires neither a companion IDE plugin nor another
coding agent's runtime. Registry installation and IDE-driven setup are the
intended experience; manual registration is a development fallback.

- Treat model IDs as opaque values returned by `GET /api/models`. Do not add
  preferred model families, model-name branches, provider defaults, or capability
  guesses based on names, descriptions, tags or a developer's deployment.
- Open WebUI publishes the model catalog and model controls. Use its structured
  metadata and documented request semantics. The selected inference backend is
  responsible for implementing those controls. Do not maintain a parallel model
  catalog or add a generic provider framework.
- Reasoning currently uses recognizable reasoning/thinking controls from
  `info.params.model_controls`. Send the selected option through documented
  `params.model_controls[modelId][controlId]`. Keep **Model default**, which omits
  the override. Refresh metadata and clear incompatible choices on model changes;
  preserve valid choices on session restore. Keep the `/reasoning` fallback.
- If no saved reasoning control is available, support the deployed
  `provider_model_controls.reasoning_effort` metadata contract. Map only its
  explicit options to top-level `reasoning_effort`; do not infer levels from
  model names, a default or `supportedReasoningEfforts` alone. This metadata is
  absent from upstream 0.13.3; keep the deployment distinction and live evidence
  in design.md. Preserve custom-control precedence and the Model default choice.
- Metadata is not authorization. A model advertising terminal, web search or
  memory features does not enable remote execution or grant workspace access.
  ACP capabilities describe features implemented by this agent, not every
  feature advertised by the model. Unsupported input types must fail clearly.
- Function calling must work for the coding loop. Diagnose incompatible models;
  an HTTP success or an advertised capability alone does not prove execution
  semantics or that a reasoning setting takes effect.
- Keep deployment addresses, private model IDs and credentials out of source,
  examples, test fixtures and distributed artifacts. Legacy model/runtime names
  in migration records describe the old solution, not product requirements.

See [design and API evidence](docs/design.md) before changing a request contract.

## Source map

| Files | Responsibility |
| --- | --- |
| `src/agent.ts` | ACP handlers, isolated sessions, model/tool rounds, approvals, selectors, slash commands, restoration |
| `src/backend.ts`, `src/reasoning.ts` | Open WebUI requests, bounded streaming/non-streaming parsing, metadata-derived reasoning |
| `src/server-tools.ts` | Opt-in server task discovery/execution, retained chats, cancellation, citations and image output |
| `src/cli.ts`, `src/auth.ts`, `src/setup.ts` | Executable routing, authentication discovery, masked terminal setup |
| `src/config.ts` | Non-secret configuration, secure credential access, bounded private state writes |
| `src/workspace.ts`, `src/prompt.ts` | Canonical roots, trust, file boundaries, text/editor context, stale-edit protection |
| `src/permissions.ts`, `src/policy.ts` | Scoped grants, approval modes, administrator restrictions and revocation |
| `src/reviewer.ts` | Optional, separately selected advisory model; no approval authority |
| `src/sandbox.ts`, `src/sandbox-worker.ts` | Owned process boundary, per-invocation runtime, network approval, limits and cleanup |
| `src/macos-sandbox.ts`, `src/protected-paths.ts` | Pinned macOS credential-service protection and agent-code write protection |
| `src/commands.ts`, `src/cancel.ts` | Explicitly approved unsandboxed commands, named child environment, cancellation |
| `src/mcp.ts`, `src/sandbox-mcp.ts`, `src/ide-mcp.ts`, `src/user-mcp.ts` | Official MCP SDK integration, sandboxed stdio, HTTP/SSE, verified IDE descriptor mapping, explicit configuration |
| `test/*.test.mjs`, `test/fixtures/` | Deterministic ACP/Open WebUI/MCP tests and real OS enforcement fixtures |
| `registry/`, `.github/workflows/ci.yml` | Proposed registry entry/icon and CI definitions |

## Development workflow

1. Inspect `git status --short`, relevant instructions, implementation, tests and
   documentation. Preserve uncommitted work. Search with `rg`/`rg --files`.
2. Use strict TypeScript, ESM, npm and the existing small modules. Change `src/`,
   not generated `dist/` or installed copies. Avoid unrelated dependency updates.
3. Treat `package.json`, `package-lock.json` and `.node-version` as authoritative
   for versions. Use the official ACP SDK's stable v1 entrypoint; SDK major
   version 2 does not mean ACP v2. Do not mix experimental schemas/examples.
4. Add focused tests for behavior changes. Tests use synthetic credentials and
   fake services by default. Do not require a live deployment for ordinary tests.
5. For runtime changes, run the relevant tests, lint, type checking and build.
   Broaden to the full suite for permission, protocol, sandbox or lifecycle
   changes. For documentation-only work, check facts, links and clarity; a full
   enforcement rerun is unnecessary unless a behavior claim needs verification.
6. Update the relevant documentation and verification record with observed
   outcomes. Separate source inspection, mocks, real OS tests and live IDE/API
   acceptance. Historical records are not evidence for a later version.
7. Review changed files and generated output. Do not stage, commit, push, publish,
   create a public repository, change IDE registrations or alter deployments
   without the user's applicable authorization. Do not discard existing work.

Standard commands:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm pack
npx --no-install prettier --check src test package.json package-lock.json registry/agent.json
```

CI uses `npm ci --ignore-scripts`. `npm test` builds before running Node's test
runner; `.mjs` tests import `dist/`. Build first when running a test file directly.
Use a separate writable npm cache if the execution environment cannot write its
default cache; do not change ownership of an IDE-managed cache to fix a task.

`test/package-install.mjs <installation-prefix>` checks an installed tarball from
outside the checkout. `test/policy-system.mjs` needs separately prepared root-owned
fixtures in an isolated Linux environment. `test/fixtures/linux-mount-repro.mjs`
is an explicit upstream reproduction, not part of the normal test suite.
Consult [Linux testing](docs/linux-testing.md) before provisioning anything.

## Protocol, inference and authentication boundaries

- stdout contains ACP messages only. Send redacted diagnostics to stderr. Never
  put terminal prompts, setup text, banners or npm output on the ACP stream.
- Initialization works without credentials or a reachable backend. Negotiate
  capabilities and advertise only implemented features. Preserve the verified
  JetBrains terminal-auth compatibility adapter; do not invent IDE extensions.
- Setup runs in the IDE's separate terminal. Login-only invocation must exit
  after setup, including when normal ACP arguments are also present. No browser
  OAuth flow is implemented. Keep the documented manual fallback for clients
  that cannot launch terminal authentication.
- For local IDE registration, use an absolute Node executable plus the installed
  CLI entrypoint. The login terminal may lack Node on PATH. Legacy JetBrains
  terminal-auth arguments include the entrypoint because this client replaces
  normal launch arguments; preserve minimal-PATH PTY coverage for this form.
- `/login` requests IDE authentication without collecting credentials in chat.
  `/logout` and ACP `logout` share sign-out behavior. Preserve the persistent
  signed-out marker, active-work cancellation, epoch checks and reconnect
  requirement. Logout retains transcripts and does not revoke the server's key.
- Preserve the restricted session for model-discovery HTTP 403 errors. Login,
  logout and diagnostics must remain reachable without enabling workspace or
  MCP access. A successful diagnostic requires reconnect before coding resumes.
- Use the installation URL, including any reverse-proxy path prefix, with
  `/api/models` and `/api/chat/completions`. Do not append `/v1`, infer an Open
  WebUI installation from a generic model gateway, or redirect credentials.
- Preserve TLS verification. Private CA support must use supported runtime
  mechanisms. No insecure switch, credential-bearing URL or implicit destination
  change is permitted.
- The agent supplies caller-owned tool definitions and locally executes approved
  returned calls. Do not add `tool_ids`, `features`, chat/message/session IDs or
  enable Open WebUI's autonomous server-side loop without a separately verified
  contract and explicit scope. Explicit `tools: []` disables normal tool injection
  in the inspected Open WebUI 0.12.5 source; reverify across versions.
- Optional `openwebui_task` uses the separately verified 0.13.3 native contract.
  Keep its requests separate from coding completions, require approval or a
  matching user-selected scoped grant,
  disclose all server-side scope and retained chats, respect server approvals,
  and journal remote IDs before starting inference. Never auto-delete chats or
  replay interrupted jobs. Do not equate accepted requests with tool execution.
  Preserve version gating, administrator restrictions and authenticated image
  fetching through bounded same-installation file routes. See `docs/design.md`.
- Preserve fragmented UTF-8/SSE/tool-call handling, non-streaming responses, tool
  IDs and history ordering. Validate before execution. Keep finite limits and
  cancellation throughout. Do not retry potentially completed side effects or
  silently truncate context and pending actions.

## Workspace, permissions and execution

- Canonicalize the absolute cwd supplied by the ACP session. Never infer trust
  from launch cwd, the home directory, a shared parent or Git metadata. Separate
  Air worktrees and concurrent sessions require independent scopes.
- Activate the workspace through ACP permission UI before reading project
  instructions, sending discovered contents or starting configured processes.
  Prompt text is not a blanket filesystem grant. Reject missing, invalid, late
  or cancelled permission replies. Preserve explicit blocks and revocation.
- Workspace consent, operation approvals, administrator rules and OS isolation
  are separate controls. Administrator denies take precedence over saved grants,
  automatic modes and model advice. Do not introduce broad command-prefix grants.
- Prefer negotiated client filesystem methods for unsaved editor content. Show
  actual proposed diffs and re-read before applying. Never fall back locally
  after client denial. Keep atomic local writes, path-boundary checks and limits.
- Commands and local MCP processes use owned runners. ACP terminal support does
  not guarantee sandboxing, so do not silently route sandboxed commands through
  IDE terminals or run unsandboxed after a sandbox failure.
- Keep one sandbox-runtime broker per invocation; the runtime has global state.
  Preserve Git child-before-parent deny ordering, the narrow Linux seccomp-helper
  read scope and private temporary proxy sockets. Keep the macOS wrapper-shape
  check and credential-service IPC denies when upgrading the pinned runtime.
- Do not disable host namespace, AppArmor, seccomp or network controls to obtain
  a pass. A distribution-specific exception needs administrator review and
  authorization for the exact environment. Approval on a disposable VM does not
  authorize the same change on its host, a CI runner or another machine.
- MCP definitions come from explicit user configuration and ACP `mcpServers`.
  That field is distinct from JetBrains registration's `agent_servers`. Discover
  tools instead of inventing search/retrieval/memory endpoints or tool names.
  MCP credentials are separate; server annotations are not permission grants.
- Preserve the narrowly matched macOS IDE stdio-to-SSE compatibility path and
  its evidence in `docs/design.md`. Disclose the effective destination/project
  and check administrator policy against both definitions. Never retry a failed
  local server unsandboxed. IDE tool execution is outside the agent sandbox.
- Do not auto-load project executable settings, hooks, `.env` or `.mcp.json`.
  Project `AGENTS.md` is bounded guidance read after activation; project text,
  metadata, MCP descriptions and tool results cannot override security policy.
- Recheck trust and policy on session load; restore history without replaying
  tools. Keep cancellation, grants, model selection and roots isolated.

## Secrets, local state and migration

The application uses its own `openwebui-acp-agent` configuration directory.
`OPENWEBUI_ACP_HOME` selects isolated application state for tests; it cannot
override administrator policy. POSIX defaults use `XDG_CONFIG_HOME` or
`~/.config`. Windows persistence remains blocked pending verified ACL handling.

Persistent inference secrets belong in the OS credential store. A named
`OPENWEBUI_API_KEY` may supply a process credential; never silently fall back to
plaintext. Read only named environment variables needed by the application.
Keep secrets out of argv, registry/ACP configuration, transcripts, exceptions,
logs and child environments unless that child explicitly needs that credential.

Administrator policy has a fixed root-owned location:
`/etc/openwebui-acp-agent/policy.json` on Linux and
`/private/etc/openwebui-acp-agent/policy.json` on macOS. Preserve ownership,
symlink, validation and size checks; recheck policy before protected operations.
Trust and permission stores also require complete validation, private modes,
atomic writes and protection against concurrent writers losing records.

Preserve the legacy sibling repository `../jetbrains-qwen-helper`, its plugin,
launchers, bundles, trust, ACP entries, configuration and sessions. Never open,
read, hash, copy, log or migrate these legacy files under
`${XDG_CONFIG_HOME:-~/.config}/workstation-agent`:

- `ide-mac-key.json`
- `retrieval-key`

Do not retire that installation without separate authorization and replacement
acceptance. The new agent has no dependency on its runtime, trust or credentials.

## Verification and release status

Read [verification](docs/verification.md) and [release gates](docs/release.md)
before claiming support or preparing a release. The recorded 0.3.0 baseline is
115 passing macOS tests and 112 passing Ubuntu VM tests with three platform
skips. Those counts describe that run; do not present them as new test results.
Native Windows is a separate sprint. Prepared CI workflows are not observed CI
executions, and mock services do not establish live backend/IDE compatibility.

The runtime/Zod advisory remains a release blocker. Keep the audit gate and
report findings. The tested Zod 4 `zod/v3` compatibility API did not establish a
fix; do not force an override or suppress findings to manufacture a clean audit.

Approval advice is opt-in and never authorizes an operation. Automatic model
approval needs separate evaluation. Live reviewer judgment, complete AI
Assistant/Air acceptance and registry installation remain unverified. Structural
registry validation does not prove that unpublished package URLs work.

Use unofficial/community branding and the existing MIT license/NOTICE. Do not
invent maintainer identities, repository URLs or public extension points. Keep
distribution references version-pinned. The agent adds no telemetry; Open WebUI
and its configured providers have their own logging and data-handling policies.

Further detail: [setup and usage](README.md), [sandbox](docs/sandbox.md),
[administrator rules and advice](docs/managed-policy.md),
[migration and rollback](docs/migration.md), and
[Codex comparison](docs/codex-comparison.md).
