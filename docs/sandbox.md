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
also need approval, except for the loopback shortcuts below. Grants can cover
one decision, this session or the remembered workspace/backend scope. Ask each
time ignores saved grants; revocation clears them. Approving a host does not
distinguish reads from remote mutations.

### Local development servers

Sandboxed commands cannot bind host ports, so a development or game server
runs as an approved unsandboxed background job (`require_escalated` or the
Unsandboxed sandbox mode). Two shortcuts stop repeated prompts when sandboxed
clients such as curl, Playwright or a test runner connect to it:

- **Own listeners.** A connection to a loopback destination needs no prompt
  when every listener that could answer it belongs to this session: a running
  unsandboxed background job, its descendants or process-group members, or the
  session's static preview. The tool call is still recorded as approved.
- **Session choice.** For other loopback destinations, the network prompt adds
  **Allow localhost (any port) for this session**. It is never remembered and
  revocation clears it.

Only literal loopback addresses (`127.0.0.0/8`, `::1`) and the exact name
`localhost` qualify, and `localhost` only when every locally resolved address
is loopback. Other names, including `*.localhost` and shorthand such as `127.1`,
keep the per-host prompt; the runtime also refuses non-loopback answers for
`localhost`. Remote and LAN destinations are unchanged.

Neither shortcut covers reserved local service ports: the JetBrains built-in
server (63342–63361) and MCP server (64342), the Docker API (2375–2376), browser
and Node.js debuggers (9222, 9229), common databases (1433, 1521, 3306, 5432,
6379, 9200, 11211, 27017) and local model servers (11434, 1234). The configured
Open WebUI port and the ports of configured MCP and IDE MCP URLs are also
excluded when they are local. These keep a per-port prompt, as before. The
reviewed list is `SENSITIVE_PORTS` in `src/loopback.ts`.

Ownership is checked when the connection is requested, within two seconds,
and a positive answer is cached for 1.5 seconds. On Linux the agent reads
`/proc/net/tcp`, `/proc/net/tcp6`, `/proc/<pid>/stat` and the owned processes'
socket descriptors. On macOS it runs `/usr/sbin/lsof -iTCP:<port> -sTCP:LISTEN`
and `/bin/ps`. A timeout, an error or an unsupported platform falls back to the
prompt. Native Windows has no command sandbox, so nothing changes there.

Threat model: a prompt-injected sandboxed command can now reach, without a
prompt, servers this session started, and with the session choice any loopback
port outside the reserved list. A local service without authentication on
such a port (an admin console, a dev database on an unusual port, a job's own
debug endpoint) can therefore be read or changed by sandboxed code, and an
unsandboxed job's server can act with that job's full access. The reserved list
covers well-known services that hold credentials, data or code execution; it
cannot cover every local service. On macOS, `lsof` cannot see other OS
accounts' processes, so a foreign listener on another loopback address of the
same port is not detected. Ask each time, approval advice, administrator
`alwaysAsk: ["network"]` and `allowLoopbackShortcuts: false` disable both
shortcuts; see [administrator rules](managed-policy.md).

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
