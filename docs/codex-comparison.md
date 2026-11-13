# Codex ACP comparison

Reviewed 13 November 2026 against the installed PyCharm adapter
`@agentclientprotocol/codex-acp` **2.6.0**, its bundled `@openai/codex` **0.166.0**,
and Open WebUI ACP Agent **0.1.3**, with the corrections below in **0.1.4**.
This is a source and automated-contract comparison, not full interactive parity
or an instruction to copy Codex's provider-specific features.

## Findings and corrections

1. **Command choices were suppressed by our eligibility policy.**
   `src/permissions.ts` allowed repeat approval for a small development-command
   set, but excluded ordinary inspection commands and every shell wrapper.
   A bounded inspection of the three most recent local transcripts counted only
   executable categories: `ls`, `find`, `bash` and one other executable. No prompt
   text, command arguments, backend address or credentials were emitted. Those
   categories explain why the user saw only once-only approvals in actual work.
   The client was receiving only the options our agent supplied. Re-evaluating
   the seven recorded invocations without executing them gave zero eligible
   repeat approvals under 0.1.3 and seven under the revised policy.

   Codex's [command decision contract](https://github.com/agentclientprotocol/codex-acp/blob/v2.6.0/src/permissions/command-decision-contract.ts)
   normally includes `acceptForSession`; its
   [option mapping](https://github.com/agentclientprotocol/codex-acp/blob/v2.6.0/src/permissions/options.ts)
   renders that decision as ACP `allow_always`. Persistent command policy is a
   separate decision, offered when the backend supplies an amendment. There is
   no special universal ACP flag that makes command approvals rememberable.

   **Corrected in 0.1.4:** common inspection commands now offer once, session and
   remembered choices. Bounded literal `sh`/`bash`/`zsh -c` or `-lc` forms can
   offer these choices when every command is eligible. The parser recognizes
   literal quoting, pipes, `&&` and `||`; expansion, redirection, substitutions,
   scripts and unsupported syntax remain once-only. Grants retain the original
   executable and complete argv, including the full shell script. We do not
   import Codex's prefix grants, because this project's requirements exclude
   broad prefix approval. Once-only requests now explain the restriction.

2. **Approval and execution were reported as separate tool calls.**
   `src/agent.ts` created a model tool-call ID, then another random approval ID.
   The approval card was marked completed before the command or edit started.
   Codex's [approval handler](https://github.com/agentclientprotocol/codex-acp/blob/v2.6.0/src/permissions/CodexApprovalHandler.ts)
   uses the same item identity for the approval and lifecycle.
   **Corrected in 0.1.4:** one ID progresses from pending through approval and
   execution to the final outcome. Permission requests include structured input
   and command cwd, with configured secrets redacted. Completed edit cards retain
   the proposed diff. Workspace activation and
   MCP connection consent remain separate, explicitly described operations.

3. **Nonzero command exits appeared completed successfully.**
   `src/agent.ts` previously treated any returned output as success. Codex's
   [app-server event contract](https://learn.chatgpt.com/docs/app-server#approvals)
   distinguishes failed and completed command items.
   **Corrected in 0.1.4:** a nonzero or unknown exit status, or a local
   timeout/output-limit termination, produces a failed tool outcome while
   retaining command output for the user and model.

## Feature comparison

| Area | Codex adapter 2.6.0 | Our agent after these corrections | Disposition |
| --- | --- | --- | --- |
| ACP transport | Stdio; negotiates protocol and optional extensions | Stable ACP v1 stdio; clean stdout | Supported; keep v2/experimental features separate |
| Setup | ChatGPT, API key and negotiated gateway flows | IDE terminal setup with masked Open WebUI key and OS storage | Appropriate intentional difference; no browser login required |
| Model and reasoning | Selectors backed by Codex model/config data | Model metadata, model-default reasoning, per-session selection and persistence | Implemented; actual provider reasoning effect remains unverified |
| Command approvals | Backend-provided once/session choices; optional policy amendment | Once/session/exact remembered grants for recognized commands; visible once-only restriction otherwise | Corrected for observed command categories; narrower than Codex |
| Execution isolation | Codex sandbox and configured permission profiles | Path checks for file tools; no command sandbox | Material architectural difference; never advertise equivalent full-access or sandbox modes |
| File editing | File changes, diffs and approvals | Client filesystem preferred, diffs, stale-content checks and atomic local fallback | Implemented; editor compare-and-swap and hostile filesystem races remain limits |
| Tool lifecycle | Stable item ID, pending/in-progress/final events | Same ID for execution and approval, structured input, final exit status | Corrected in 0.1.4 |
| Command output | Output events and negotiated terminal channels | Bounded result after exit; client terminal API preferred | Gap: no streamed local output or attached terminal content in the tool card |
| Background tasks | Negotiated AIR async tasks and targeted stop | Foreground commands with 30-second bounds | Not implemented; separate scope from this fix |
| Cancellation | Turn interruption and pending interaction cleanup | HTTP abort, pending approval cancellation, process-group kill and terminal cleanup | Implemented tests; hanging client calls and remote cleanup need further hardening |
| MCP | Client servers plus richer auth, progress and elicitation | Direct stdio/Streamable HTTP/SSE, schemas, separate credentials, connection/tool grants | Core support and SSE failure coverage implemented; progress/elicitation and broader transport memory hardening remain gaps |
| Session history | Load, resume, list, fork and richer session index | Local bounded transcripts and `session/load`, with no tool replay | Required load implemented; browsing/fork/delete APIs are not advertised |
| Slash commands | Status, MCP reconnect, compact, skills/review and others | Status, doctor, permissions, model and reasoning | Gap: command discovery is sent on new sessions but not load; unknown slash commands return status |
| Diagnostics | Typed errors/warnings and capability-gated client presentation | Redacted errors and model API checks | Gap: most tool failures collapse to one message; `/status` reports current MCP connections after they were closed at turn end |
| Context management | Usage events and compaction | Finite byte/round/tool/transcript limits; no silent truncation of history | Gap: no token-usage display or deliberate compaction operation |
| Input context | Text, embedded context, links and images | Text, embedded UTF-8 text and inert links | Implemented subset; images/audio explicitly unsupported |
| Plans and questions | Plan events, elicitations and steering | Ordinary model text; overlapping prompts rejected | Not implemented; no corresponding capabilities advertised |
| Instructions and extensions | Skills, hooks, subagents and provider-specific tools | Approved root AGENTS.md only; no project scripts/hooks/config auto-loading | Intentional scope boundary from the original requirements |
| Registry and platforms | Published adapter and platform artifacts | Local npm package and registry proposal | Public artifact, isolated registry acceptance and Windows ACL/process support remain release gates |

The adapter's [versioned README](https://github.com/agentclientprotocol/codex-acp/blob/v2.6.0/README.md)
and [AIR extension contract](https://github.com/agentclientprotocol/codex-acp/blob/v2.6.0/docs/air-extensions.md)
are the feature baseline. Its optional AIR extensions are explicitly negotiated;
we have not copied experimental metadata or advertised unimplemented features.
Our references are `src/agent.ts`, `permissions.ts`, `commands.ts`, `mcp.ts`,
`backend.ts`, `prompt.ts` and the corresponding focused tests.

## Remaining priorities

- Keep the existing release blockers visible: Windows storage/cleanup, malicious
  MCP transport bounds, filesystem races and full live/registry acceptance.
- Improve tool error categories, MCP status reporting and restored slash-command
  discovery before adding new product surfaces. These affect existing workflows.
- Add bounded command-output streaming and terminal association, then session
  browsing and explicit context management if required by the target clients.
- Treat sandboxing, background tasks, multimodal input, steering and richer MCP
  interactions as separate, testable changes. Codex's availability of a feature
  is not proof that this implementation or Open WebUI can support it safely.

A remembered command grant authorizes future execution of that exact invocation;
it does not freeze program files, shell startup files, scripts, Git configuration
or the client terminal environment. The eligibility checks are not an OS sandbox.
High-risk Git mutations, cleanup, deployment and arbitrary scripts still require
approval each time. Different command arguments always require another decision.

## Follow-up: permission modes (0.1.5)

The agent now exposes an ACP `mode`-category Permissions selector. It controls
read-only inspection, per-operation approval, scoped grants, automatic workspace
edits and automatic eligible development commands. The automatic choices apply
only to the live session and reset on reconnect or revocation. Supported `gh`
read operations and bounded GET API calls are now eligible. This closes the
missing-selector gap but does not implement Codex's OS sandbox or auto-review
model. Unrecognized scripts, publishing, destructive commands and GitHub mutations
still require approval; this is not full command-policy parity.

## Follow-up: execution isolation (0.2.0)

The execution-isolation row above describes the earlier preview. Version 0.2.0
adds OS sandbox profiles, owned command/local-MCP runners, exact network
approvals, once-only filesystem exceptions and unsandboxed requests, and
revocation/restoration behavior. It stops using client terminals for execution.
See the current [sandbox parity matrix](sandbox.md#codex-comparison).

macOS has real enforcement tests, including denied credential-service Mach IPC,
filesystem/symlink boundaries and filtered network access. Linux integration has
not been executed here; native Windows remains unsupported. Codex's automatic
review model, enterprise-managed profiles and cloud execution are not implemented.
The original no-prefix/no-auto-push requirements still apply. An upstream runtime
advisory is a release blocker. This closes part of the architectural gap, not all
Codex features or all platform/security acceptance requirements.

## Follow-up: administrator rules and advisory review (0.3.0)

Version 0.3.0 adds root-owned local administrator rules, exact destination
restrictions, mandatory human approval categories and active-turn revocation.
A separately selected model can supply advice through ACP, but cannot grant
permission. Real macOS and Ubuntu 24.04.5 VM sandbox tests now pass. See
[managed policy](managed-policy.md) and [verification](verification.md).
Automatic model approval, central enterprise identity/management, native Windows
and cloud execution remain outside this release. The runtime/Zod advisory has a
tested dependency and packaging fix; see
[sandbox.md](sandbox.md#dependency-advisory-and-release-gate). These controls do
not establish full Codex parity.
