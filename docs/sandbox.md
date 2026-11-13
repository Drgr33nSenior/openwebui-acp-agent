# Command isolation and policy in 0.3.0

This is an experimental sandbox implementation. macOS enforcement has real local
tests. Linux enforcement has passed in an Ubuntu 24.04.5 development VM.
Native Windows execution remains unavailable. This version is not full Codex
parity or a completed security review. Review the dependency assessment below
and the remaining release gates before distributing it to testers.

## IDE controls

The **Permissions** selector controls approval. The separate **Sandbox** selector
controls OS isolation. Both use ACP session configuration options. Clients that
hide the selector can use `/permissions sandbox workspace`,
`/permissions sandbox read_only`, or `/permissions sandbox full_access`.

| Sandbox choice | Behavior |
| --- | --- |
| Workspace write, default | Writes in the exact session workspace and a private temporary directory. Network destinations require approval. |
| Read-only filesystem | Workspace reads and approved commands, with writes limited to private temporary files and runtime device paths. File-edit tools are also blocked. |
| Unsandboxed, session | Commands and local MCP servers have ordinary user-account access. Each launch requires explicit approval, even in Development mode. Restoring or revoking permissions resets this choice to Workspace write. |

The existing Permissions **Read only** choice is stricter: it disables command
and MCP tools entirely. A sandbox choice never activates a workspace or grants
permission to publish, push, deploy, or perform destructive cleanup.

All commands run in agent-owned processes. The agent does not use ACP client
terminals because that capability does not guarantee isolation. ACP still shows
approval requests, arguments, working directory, output and completion status.
Editor reads/writes continue to use the client filesystem API when available.

The model can propose extra existing absolute read/write paths with a reason.
These appear in a separate, once-only command approval. Home, filesystem roots,
application state and known credential directories cannot be added this way.
Changing the sandbox or scope invalidates the applicable command grant.
`sandbox_permissions: require_escalated` requests an explicitly unsandboxed
invocation with a justification. There is no automatic retry outside the sandbox.
An earlier failed command may already have changed files.

## Filesystem and credentials

The policy denies reads of home and common temporary directories, then permits
the canonical workspace, invocation-specific temporary directory and explicitly
approved program/read scopes. Other system paths remain readable for toolchain
compatibility; this is not a container or a universal read allowlist. Known
credential directories and common secret filenames are denied. File discovery
still applies its own narrower sensitive-file and ignore rules.

Workspace `.git`, `.agents`, `.codex`, `.aws`, `.idea` and `.vscode` paths are
protected against command writes. Agent distribution files and dependencies are
also protected when they fall inside the workspace. A worktree's Git metadata
outside its root is not implicitly granted; commands may need an explicit read
exception for that metadata. Sibling worktrees remain separate scopes.

Children receive only the existing named environment allowlist and temporary
directory/proxy settings. Local MCP children additionally receive their own
explicitly configured environment values. Loader/startup variables such as
`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `BASH_ENV`, `ENV` and launcher `PATH`/`HOME`
overrides are refused. The agent never forwards its Open WebUI key to a child.

On macOS, filesystem denial alone does not protect Keychain. The pinned runtime
allows some credential-service IPC for compatibility. `macos-sandbox.ts` appends
explicit denies for securityd/SecurityServer to the generated Seatbelt policy.
The adapter accepts only the exact wrapper structure emitted by the pinned
runtime and refuses execution if that structure changes. Tests check an actual
Mach service lookup without opening a keychain or reading credentials. Runtime
upgrades must repeat this test; do not remove the check for compatibility.

Existing GitHub credentials, SSH agents, user caches and other home files are
not automatically exposed. A program such as `gh` may therefore need separate
credential provisioning or an explicitly approved unsandboxed invocation. Network
approval alone does not supply credentials. No credential is collected in chat.

## Network and MCP

Each invocation has its own proxy and OS network boundary. Direct sockets cannot
bypass the proxy in the tested macOS cases. HTTP/HTTPS and SOCKS destinations
request ACP approval for an exact hostname and port. Options cover a single
connection, this session, or a remembered workspace/backend grant. Different
ports, roots, backends and sandbox modes require their own decisions. The
existing Ask each time policy ignores saved grants. Revocation clears them.

The agent clears proxy bypass defaults, including loopback/private-network
bypasses, inside the sandbox. LAN services can be used after approval. Programs must support the supplied proxy settings; direct-only clients fail
closed. No TLS interception, installed CA, insecure TLS flag, wildcard host approval or automatic
network exception is added. An allowed destination can receive command data;
hostname approval does not distinguish reads from remote mutations.

Open WebUI inference and remote MCP transport run in the parent agent with their
separately configured credentials. The command sandbox does not constrain work
performed on a remote MCP server or inside Open WebUI. Remote MCP calls retain
their own approvals. Closing HTTP does not undo remote side effects.

Local MCP processes launched by the agent use the same process boundary and official MCP SDK protocol
and framing. Startup approval discloses read access to explicitly named program
files. For a named JavaScript entrypoint, the nearest package directory is shown
as its dependency read scope. Only package-file metadata is inspected to find
that scope; no project executable configuration is loaded. The grant identity
includes this scope. New/changed scopes require renewed approval. Dynamic
loaders and unusual installation layouts may still need an explicit setup change.

The recognized macOS IDE `stdioMcpServer` descriptor uses an approved direct
SSE connection instead of launching a process. Its destination and project scope
are shown before connection. The existing IDE executes those tools outside the
agent's sandbox, with separate tool approvals. This does not grant the IDE
process an agent sandbox or expand the command runner's permissions. See the
[verified compatibility contract](design.md#ide-mcp-compatibility).

Each command/MCP process gets its own broker because the runtime's manager has
global mutable state. Sessions never share that manager. Configuration and MCP
environment values travel over private IPC, not temporary config files or argv.
Network decisions are serialized and bounded. Cancellation or process exit
cancels pending decisions; late responses cannot restart work or save a grant.
MCP frames are bounded before SDK parsing. A failed/timed-out tool call closes its
connection without retry. Remote cancellation remains cooperative.

## Runtime and platform evidence

The dependency is pinned to `@anthropic-ai/sandbox-runtime` **0.0.83**
(Apache-2.0, Node >=22.12). It provides Seatbelt on macOS and bubblewrap/network
namespaces/seccomp on Linux, plus filtered proxies. It avoids a Codex dependency,
a required container engine, and a new custom isolation implementation.
The [official source](https://github.com/anthropics/sandbox-runtime) and the
actual published package were inspected. Main-branch documentation is not a
substitute for the pinned package's API.

macOS needs its system `/usr/bin/sandbox-exec`. Linux needs `/usr/bin/bwrap`,
`/usr/bin/socat` and `/usr/bin/rg`, plus host permission to create the required
namespaces. `/doctor` checks dependencies and runs a bounded namespace probe on Linux without executing project code;
each broker checks initialization and refuses to run if enforcement fails.
We do not enable weaker nested/network isolation to work around a host denial.
No user-written launcher script is needed.

The runtime's Windows support needs privileged machine setup and has documented
limitations. This agent also lacks verified Windows state-file ACL handling.
Neither setup nor ACL changes are performed automatically. Native Windows fails
closed. WSL2 would use the Linux implementation, but has not been tested here.

Processes have bounded command duration/output, a private temporary directory
and POSIX process-group cleanup. Tests cover ordinary child descendants. A
complete hostile-process escape audit, unusual IPC channels, every filesystem
alias/race, detached descendants and cross-platform enforcement remain review
items. This boundary is not a VM, and allowed workspace writes can still damage
the workspace. Preserve backups and review changes.

## Dependency advisory and release gate

The original dependency tree reported two high findings for the runtime and its
transitive Zod 3.25.76 package, both from
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
The affected `$ZodArray` implementation is in that package's bundled v4 core.
Runtime 0.0.83 imports `zod/v3` in both schema modules; its source explicitly
supports that subpath under Zod 3.25+ and Zod 4. See
[upstream issue #778](https://github.com/anthropics/sandbox-runtime/issues/778).

A version-scoped override now resolves the runtime to the existing pinned Zod
4.6.7. This retains the v3 API and removes the affected v4 code. Tests verify
runtime schema validation, defaults and error compatibility, and early rejection
of an oversized constrained array by the patched v4 implementation. They also
run against the separately installed package. Existing IPC/configuration bounds
remain necessary; this is not a claim that every validation path has constant
resource use.

The runtime and its resolved dependency tree are bundled because npm does not
apply a dependency's overrides when another project installs it. The initial
unbundled tarball reproduced the vulnerable dependency; the bundled installation
audited clean. Original dependency licences remain included. CI retains the
normal high-severity audit for both the checkout and the installed tarball.
The package remains an unpublished preview with separate acceptance gates.

## Codex comparison

Baseline: installed Codex ACP 2.6.0 / Codex 0.166.0 and
[official sandbox documentation](https://learn.chatgpt.com/docs/agent-approvals-security).

| Capability | This implementation |
| --- | --- |
| Filesystem and network enforcement | Implemented; real macOS and Ubuntu 24.04.5 VM tests |
| Read-only/workspace/full-access choices | Implemented with independent approvals; unsandboxed launches always ask |
| Per-command escalation and filesystem exceptions | Explicit once-only ACP approval; no retry after failure |
| Domain permissions | Exact host and port through proxy with once/session/remembered choices |
| Session isolation, persistence and revocation | Implemented; elevated sandbox mode resets on restore/revocation |
| Protected metadata and credential handling | Protected paths, named environment, macOS credential-service denies |
| Command and local MCP cleanup | Owned processes, bounded output/time, cancellation and pending-approval cleanup |
| Native Windows / MXC / WSL acceptance | Blocked by platform setup, ACL work and unavailable target testing |
| Codex automatic approval reviewer and safety monitoring | Advisory-only review implemented; automatic model approval and safety monitoring deferred |
| Enterprise-managed policy profiles | Local root-owned administrator rules implemented; no central enterprise identity or management |
| Broad prefix rules or never-approve unsandboxed mode | Intentionally omitted under the original no-auto-mutation/no-prefix requirements |
| Codex cloud containers, arbitrary profile composition and TLS interception | Not implemented; separate infrastructure/product scope |

The complete Codex feature set is not delivered by this first implementation.
These differences must remain visible in tester instructions and release notes.

## Linux verification and compatibility corrections (0.3.0)

The real suite passed on Ubuntu 24.04.5, kernel 6.8.0-147-generic, bubblewrap
0.9.0-1ubuntu0.3. The disposable VM initially denied namespaces through
AppArmor. With explicit user approval, a per-executable `userns` rule was loaded
for root-owned `/usr/bin/bwrap`. The global restriction remained enabled.
The optional [profile](bwrap-apparmor.profile) is not installed by agent setup;
see [Linux testing](linux-testing.md). No workstation host policy changed.

Testing identified three compatibility corrections:

- Emit the runtime’s existing `.git/hooks` and `.git/config` denies before the
  full `.git` deny. This avoids creating a missing mountpoint beneath a read-only
  mount. The complete Git deny remains. The standalone reproduction is
  `test/fixtures/linux-mount-repro.mjs`; `--ordered-denies` demonstrates the fix.
- Allow read access to the single bundled Linux `apply-seccomp` executable, which
  a per-user npm installation otherwise places beneath the denied home directory.
  Agent code remains protected against writes. A missing helper refuses execution.
- Set the broker’s temporary directory before loading the runtime. Proxy bridge
  sockets then live inside the invocation’s private allowed scope, instead of
  disappearing beneath the shared `/tmp` denial. Direct sockets remain denied.

Both the full tests and the standalone reproduction were run. No runtime source
patch, weaker isolation flag or removed assertion was needed. Administrator
rules and optional model advice are described in [managed policy](managed-policy.md).

Correction to the earlier advisory assessment: the v3 compatibility API generated
33 issues for 32 invalid elements with a maximum length of one. That probe did
not exercise the v4 `$ZodArray` implementation named in the advisory and did not
establish that Zod 4.6.7 retained the reported defect. The corrected assessment
and distribution checks are above. Runtime 0.0.83 still declares `zod: ^3.25.0`;
the tested override and bundled tree are required until upstream changes it.
