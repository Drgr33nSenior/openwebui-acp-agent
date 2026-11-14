# Windows implementation plan

Native Windows is planned for a later version. The current release refuses
persistent state and sandboxed execution on Windows. This document does not
enable support or authorize machine-wide installation changes.

## First preview

Target Windows 11 x64 with a supported Node LTS release and an ACP-capable
JetBrains IDE. Start with local NTFS workspaces. Add ARM64, network shares and
other environments only after separate verification. WSL2 is a separate Linux
deployment and does not establish native Windows compatibility.

The first preview should provide IDE-driven setup, model selection, file tools,
session persistence and configured HTTP/SSE MCP. Commands and stdio MCP may use
an explicitly selected unsandboxed runner once its lifecycle tests pass. Show
that scope before activation. Do not advertise an unavailable sandbox or use
unsandboxed execution as a fallback after failure. Keep ordinary approval modes;
YOLO remains a separate session-only opt-in.

## Required work

| Area | Acceptance requirement |
| --- | --- |
| Private state | Create and verify Windows access-control lists for configuration, transcripts, trust, grants, locks and temporary replacements. Validate ownership, inherited access and reparse points. POSIX mode bits are insufficient. |
| Credentials and login | Verify the pinned keyring dependency on Windows, masked input, cancellation, logout and reconnect. Exercise terminal authentication with append/replace launch arguments, spaces in paths and minimal PATH. Never fall back to plaintext. |
| Workspace boundaries | Test drive roots, case aliases, junctions, symbolic links, reparse points, device/UNC paths, alternate data streams and missing targets. Unsupported forms must fail clearly before access. Preserve independent worktree trust. |
| File updates | Verify stale-content checks, editor integration, atomic replacement, concurrent state writers and recovery when antivirus or another process holds a file open. |
| Processes | Use a verified process-tree lifecycle, such as Windows Job Objects, so Stop, timeout, output limits, logout, revocation and agent exit terminate owned descendants. Test foreground commands, background jobs and stdio MCP. |
| Executable routing | Preserve literal argv. Handle native executables, PowerShell and `.cmd` launchers deliberately; disclose any shell invocation and test metacharacters. Forward only named environment variables. |
| Administrator policy | Define and verify a fixed protected Windows policy location and Windows ownership/ACL checks. Do not reuse POSIX uid checks or silently ignore policy. |
| Diagnostics | Report available execution modes and actionable Windows failures. Keep initialization and account recovery available when execution is unavailable. |

Node documents that Windows file modes do not model POSIX owner/group/other
permissions. Use real ACL checks instead of removing the existing platform
guard. See [Node filesystem guidance](https://nodejs.org/api/fs.html#fschmodpath-mode-callback).
Microsoft documents group cleanup through
[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
including kill-on-close; verify descendant attachment and breakaway behavior
before relying on it.

## Native sandbox follow-up

The pinned `@anthropic-ai/sandbox-runtime` 0.0.83 package includes alpha Windows
support. Its documentation describes a dedicated account, Windows Filtering
Platform rules, restricted tokens, filesystem ACL changes and an elevated
installation step. It also documents persistent grants and isolation limitations.
Dependency support does not establish this agent's Windows support.

Before integration, review the exact pinned source and installation/rollback
effects. Test on a disposable Windows VM with explicit authorization for that
VM's account, firewall and ACL changes. Do not run machine-wide setup silently
from npm installation or IDE login. Preserve existing ACLs and verify cleanup,
upgrades, network enforcement, credential protection and known escape cases.
Keep this integration separate from the first unsandboxed preview.

## Tests and release gates

1. Expand Windows CI beyond the current rejection/handshake checks. Run portable
   protocol, inference, permission and persistence suites with synthetic services
   and isolated state, plus real ACL, path and process-tree tests.
2. Install the packed artifact outside the source checkout on a clean Windows
   runner. Verify Node, native credential dependencies, paths and launch routing.
3. Test setup, edits, commands, MCP, cancellation and restore in a real Windows
   JetBrains client. Record exact OS, architecture, IDE, ACP client and package
   versions. Test AI Assistant and Air in IDEs separately.
4. Publish an opt-in preview only after the required checks pass. State which
   tests passed and which IDE combinations remain unverified. Unsupported
   security behavior must stay disabled rather than becoming a silent fallback.
5. Provide a feedback template for reproduction steps, redacted errors, versions,
   execution mode and filesystem type. Never request keys, environment dumps or
   complete private transcripts. Keep a documented path back to the prior release.

Update the support matrix and registry platform claims only when evidence
supports them. Current macOS/Linux behavior and defaults must remain unchanged.
