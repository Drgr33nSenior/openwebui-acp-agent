# Command isolation

The **Permissions** selector controls approval; **Sandbox** controls OS isolation.
Neither grants workspace activation or overrides administrator restrictions.

| Sandbox mode          | Scope                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------- |
| Workspace write       | Writes in the exact project and a private temporary directory; approved network destinations |
| Read-only filesystem  | No workspace writes; private scratch files and required runtime device access                |
| Unsandboxed (session) | Ordinary user-account filesystem/network access; approval for each launch unless YOLO is confirmed           |

Unsandboxed mode resets on restore or revocation. Permissions **Read only** is
stricter than a read-only sandbox: it disables commands and MCP entirely.
Commands always use agent-owned runners; an IDE terminal capability does not
establish isolation. A sandbox failure never causes an unrestricted retry.

Confirmed **YOLO** selects unsandboxed execution for this session. Commands and
local MCP then have ordinary user-account filesystem/network access, without
the proxy or sandbox credential/metadata protections below. Routine operation
approvals are skipped, including background launches. Administrator rules still
apply; policies that forbid full access also forbid YOLO. Changing the Sandbox
selector exits YOLO. See [permissions](../README.md#permissions).

## Files and temporary directories

Sandboxed commands receive a private `TMPDIR`. Use the language's temporary-file
API for scratch files. A hard-coded shared `/tmp` path is outside the write
scope and can fail with `Operation not permitted`, even after command approval.
Scratch files are deleted when the invocation ends. Use workspace-relative files
for data needed by later commands.

The policy denies home/common temporary paths and known credential stores, then
allows the workspace, invocation temporary directory and approved read scopes.
Other system paths remain readable for toolchain compatibility: this is not a
container or universal read allowlist. Discovery also respects ignore rules and
skips symlinks, dependencies, agent state and sensitive paths.

Credential filenames and executable metadata have separate protections in
`src/protected-paths.ts`. Known secrets cannot be read through ordinary file
tools. Git metadata, IDE/agent configuration, hooks, startup files and agent
installation code cannot be modified through file tools or sandboxed commands.
A worktree's external Git metadata is not an implicit filesystem grant.
Credential-name lists cannot identify every sensitive file.

A command can request additional existing absolute read/write paths with a
reason. Scope expansion requires a fresh decision outside confirmed YOLO.
Home, filesystem roots,
agent state and known credential stores are not valid exceptions. Explicit
`sandbox_permissions: require_escalated` requests an unsandboxed invocation;
there is no automatic escalation after a failure. An earlier command may already
have caused changes.

Children receive a small named environment plus temporary/proxy settings. Local
MCP children also receive explicitly configured values. Loader/startup overrides
are refused, and the Open WebUI credential is never forwarded implicitly.
GitHub credentials, SSH agents and home caches are not automatically available.
Network approval does not provide credentials.

## Network and MCP

Each invocation has a separate runtime broker and proxy. HTTP/HTTPS and SOCKS
connections request exact hostname/port approval. Loopback and LAN destinations
also need approval. Grants can cover one decision, this session or the remembered
workspace/backend scope. Ask each time ignores saved grants; revocation clears
them. Approving a host does not distinguish reads from remote mutations.

Programs must honor the supplied proxy settings; direct-only clients fail
closed. No TLS interception, insecure TLS switch or wildcard destination grant
is added. Inference and remote HTTP/SSE MCP use separate connections in the
parent agent. Work performed by those servers is outside the command sandbox.

Local stdio MCP uses the same owned-process boundary, bounded frames and explicit
installation read scope. IDE bridge tools and the optional browser container
execute outside it and retain their own approvals outside confirmed YOLO.
Closing an HTTP request does not prove a remote operation stopped.

## Platforms and cleanup

The pinned Apache-2.0 `@anthropic-ai/sandbox-runtime` provides macOS Seatbelt and
Linux bubblewrap, namespaces, seccomp and proxies. macOS requires its system
`/usr/bin/sandbox-exec`. The agent adds credential-service IPC denies because
filesystem denial alone does not protect Keychain. The adapter checks the pinned
runtime's wrapper shape and refuses execution if it changes.

Linux requires bubblewrap, socat, ripgrep and permission to create the necessary
namespaces. `/doctor` runs a bounded namespace probe. See [Linux setup](linux-testing.md)
for distribution policy constraints. Native Windows is unavailable: persistent
state ACLs and a tested execution lifecycle are required. WSL2 uses Linux
mechanisms but needs separate acceptance testing.

Commands have bounded duration/output and POSIX process-group cleanup. Stop,
revocation and disconnect cancel owned processes and pending network decisions.
Late decisions cannot restore execution or save grants. Background jobs are
session-owned and never restored. This boundary is not a VM or a complete
hostile-code audit. Unusual IPC, detached processes and platform-specific alias
behavior require care. Allowed workspace writes can still damage a project;
keep backups and review changes.

## Dependencies

The runtime is pinned to 0.0.83 with a version-scoped Zod 4.6.7 override. It uses
Zod's v3 compatibility API. The runtime dependency tree is bundled because npm
does not apply dependency-level overrides when installing a published package.
Keep the compatibility tests, input bounds and original licenses. Audit both
the source checkout and an independently installed tarball; a clean checkout
alone does not establish the installed dependency tree's safety.
