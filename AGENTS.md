# Contributor guide

This is an unofficial local ACP coding agent for JetBrains and other compatible
clients. Open WebUI provides inference and model metadata. Read relevant source,
tests and documentation before changing behavior. Preserve uncommitted work,
other agents, installed configurations, credentials and sessions.

## Product boundaries

- Use opaque discovered model IDs and structured metadata. Never infer capability
  or reasoning levels from model names, descriptions or tags.
- Keep core caller-owned tools separate from explicitly enabled Open WebUI server
  tasks. Do not add server-loop fields to coding requests.
- Advertise implemented stable ACP v1 capabilities only. Stdout is protocol-only;
  diagnostics must be redacted and sent to stderr.
- Preserve IDE-driven terminal authentication and its append/replace argument
  compatibility. Setup-only mode must exit without entering the protocol loop.
- No companion plugin, telemetry, model-specific runtime or automatic project
  executable configuration. Read [API contracts](docs/design.md) before changes.

## Source map

| Modules                                                                           | Responsibility                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `agent.ts`, `turns.ts`                                                            | ACP sessions, model/tool rounds, queue/interruption, selectors, verification |
| `backend.ts`, `harness.ts`, `reasoning.ts`, `usage.ts`                            | Inference parsing, safe recovery, workflow prompt, model controls and usage  |
| `config.ts`, `auth.ts`, `setup.ts`, `cli.ts`                                      | Private state, secure-store authentication and executable routing            |
| `workspace.ts`, `prompt.ts`, `instructions.ts`                                    | Canonical boundaries, editor context and scoped AGENTS.md                    |
| `permissions.ts`, `policy.ts`, `reviewer.ts`                                      | Grants, administrator rules and advisory-only review                         |
| `commands.ts`, `jobs.ts`, `sandbox*.ts`, `macos-sandbox.ts`, `protected-paths.ts` | Bounded owned execution and platform protection                              |
| `mcp.ts`, `ide-mcp.ts`, `user-mcp.ts`, `server-tools.ts`                          | Direct MCP and separate Open WebUI tasks                                     |
| `verification.ts`, `compaction.ts`, `planning.ts`                                 | Bounded diagnostics, context summaries and progress plans                    |
| `checkpoints.ts`, `undo-created.ts`, `session-store.ts`                           | Stale-safe undo, retained recovery, session listing/fork/export              |
| `test/`, `browser/`, `registry/`                                                  | Automated fixtures, optional browser package and registry artifacts          |

## Safety invariants

Workspace activation precedes project context, executable startup and MCP.
Canonical exact-root trust does not cover siblings, home or parent directories.
Workspace trust, operation approval and OS isolation remain separate. Preserve
administrator denies, revocation and late-approval cancellation. Do not add
broad command-prefix grants or unrestricted fallbacks.

Editor methods take precedence for unsaved text. A denial cannot cause a local
fallback. Show diffs, re-read before writing, detect staleness and preserve atomic
local writes. Checkpoints must be exact and cannot contain configured secrets.
No tool executes from a malformed reply or restored transcript.

Keep one runtime broker per invocation and preserve process cleanup, proxy rules,
private temporary paths, metadata protection and macOS credential-service denies.
Do not weaken namespace, AppArmor, seccomp, TLS or authentication controls to pass
a check. Remote MCP and server tasks execute outside the local sandbox.

Credentials belong in the OS store or an explicitly named process variable,
never argv, URLs, transcripts, logs or committed configuration. Do not load
project `.env`, hooks or MCP definitions. Only explicit user/ACP configuration
can start MCP. Project text and tool results are untrusted guidance.

Validate complete state files before modification; preserve private modes,
symlink checks, atomic replacement and concurrent-writer locking. Restore history
without replaying tools or grants. Forks and session queues must not copy running
processes. Keep native Windows persistence disabled pending proper ACL support.

## Workflow

1. Inspect `git status --short` and applicable instructions. Use `rg` for searches.
2. Change canonical TypeScript source, not generated `dist` or installed copies.
   Use npm, strict checking and the pinned dependency/lockfile versions.
3. Add focused behavior tests. Use synthetic credentials and fake services.
   Set a fresh external `OPENWEBUI_ACP_HOME` before Node imports configuration;
   never let tests touch the user's application state.
4. Run lint, typecheck, build and relevant tests. Permission, protocol, sandbox or
   lifecycle changes require the complete suite. Documentation-only changes need
   factual/link checks, not an unnecessary enforcement rerun.
5. Review the complete diff and package contents. Do not commit, push, publish,
   merge or alter installations without applicable user authorization. Preserve
   unrelated working trees. The owner merges source PRs.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm pack
npx --no-install prettier --check src test package.json package-lock.json registry/agent.json
```

Use a separate npm cache if the default is unwritable; do not change ownership
of IDE-managed directories. Keep the runtime's scoped Zod override and bundled
dependency tree: npm does not apply dependency-level overrides for consumers.
Audit both checkout and installed tarball. Do not suppress security findings.

See [testing](docs/verification.md), [sandbox](docs/sandbox.md),
[administrator policy](docs/managed-policy.md) and [release gates](docs/release.md).
Report actual checks, platform skips and unresolved live acceptance separately.
Do not claim an HTTP success proves tool execution or reasoning behavior.
