# Codex ACP comparison

The historical approval review below was performed on 13 November 2026 against the installed PyCharm adapter
`@agentclientprotocol/codex-acp` **2.6.0**, its bundled `@openai/codex` **0.166.0**,
and Open WebUI ACP Agent **0.1.3**, with the corrections below in **0.1.4**.
This is a source and automated-contract comparison, not full interactive parity
or an instruction to copy Codex's provider-specific features.
The feature table has since been refreshed against the local **0.3.0** source.
See [the current feature audit](feature-audit.md) for research and priorities.

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

## Current feature comparison

| Area | Codex comparison baseline | Current local agent | Remaining limit |
| --- | --- | --- | --- |
| ACP transport | Stdio with negotiated capabilities | Stable ACP v1 stdio and clean stdout | No experimental extensions advertised |
| Setup | Codex authentication flows | IDE terminal setup, masked Open WebUI key, OS storage, login/logout | No browser login; client terminal support varies |
| Model and reasoning | Selectors backed by Codex configuration | Metadata-derived choices, Model default and session persistence | Effect verified only for recorded backend cases; see design.md |
| Approvals | Session choices and backend policy decisions | Exact grants, permission modes, revocation and administrator rules | No broad prefix grants or automatic model approval |
| Execution isolation | Codex sandbox profiles | Owned command/local-MCP sandbox, network approvals and explicit scope expansion | macOS/Linux evidence is in verification.md; native Windows unsupported |
| Editing and lifecycle | Diffs, approvals and stable tool identities | Client filesystem, stale checks, atomic local fallback and accurate failure states | No atomic editor compare-and-swap or general undo |
| Command output | Streaming and negotiated terminal presentation | Bounded output after command exit; owned runner | No incremental output, persistent terminal or background jobs |
| Cancellation | Turn and task interruption | HTTP abort, late-reply rejection and owned process cleanup | Remote side effects cannot be rolled back by local cancellation |
| MCP | Client servers and richer interactions | Explicit stdio/HTTP/SSE, independent credentials and scoped approvals | Progress, elicitation and remote payload hardening remain gaps |
| Server-hosted tools | Provider-specific capabilities | Opt-in Open WebUI delegated tasks, retained chats and image/citation output | Per-task approval, not per-call server execution approval |
| Session history | Resume and richer session management | Bounded local history and `session/load` without replay | List, fork, export and delete controls remain future work |
| Slash commands | Context, planning, review and other controls | Discovery already works on new/load; help and unknown-command feedback implemented; local tests passed | No skills or dedicated review command |
| Diagnostics | Typed status and client presentation | Redacted API errors, doctor, sandbox hints; configured MCP status implemented; local tests passed | Idle connections must be distinguished from configured servers |
| Context | Usage reporting and compaction | Context wheel already implemented; manual/automatic compaction implemented; local tests passed | Generic model summaries, not native encrypted OpenAI compaction |
| Plans | Plan progress and planning workflows | ACP plan updates, `update_plan` and restricted Plan/Code mode implemented; local tests passed | No mid-turn steering or general structured elicitation |
| Input context | Rich prompt content | Text, embedded UTF-8 context and inert links | Image/audio input unsupported; image output is separate |
| Instructions | Skills, hooks and broader instruction discovery | Approved root AGENTS.md | Nested instructions/skills deferred; no automatic project execution |
| Distribution | Published adapter and platform artifacts | Packed npm installation and registry artifacts | Full registry/AI Assistant/Air acceptance remains a release gate |

The historical adapter's [versioned README](https://github.com/agentclientprotocol/codex-acp/blob/v2.6.0/README.md)
and [AIR extension contract](https://github.com/agentclientprotocol/codex-acp/blob/v2.6.0/docs/air-extensions.md)
are the adapter feature baseline. Current workflow references are the official
[Codex commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
and [CLI overview](https://learn.chatgpt.com/docs/codex/cli). Optional AIR extensions are explicitly negotiated;
we have not copied experimental metadata or advertised unimplemented features.
Our references are `src/agent.ts`, `permissions.ts`, `commands.ts`, `mcp.ts`,
`backend.ts`, `prompt.ts` and the corresponding focused tests.

## Remaining priorities

- Keep the existing release blockers visible: Windows storage/cleanup, malicious
  MCP transport bounds, filesystem races and full live/registry acceptance.
- Complete interactive client and live-model acceptance for the compaction,
  planning, help and MCP status additions; local automated checks passed.
- Prioritize bounded command-output streaming, owned background jobs, session
  browsing, reviewed undo and nested project instructions. See the
  [prioritized backlog](feature-audit.md#suggested-next-work).
- Treat multimodal input, steering, skills and richer MCP interactions as
  separate, testable changes. Codex's availability of a feature
  is not proof that this implementation or Open WebUI can support it safely.

A remembered command grant authorizes future execution of that exact invocation;
it does not freeze program files, shell startup files, scripts, Git configuration
or the process environment. Eligibility checks and OS isolation are separate controls.
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

The original 0.1.4 comparison had no command sandbox. Version 0.2.0
added OS sandbox profiles, owned command/local-MCP runners, exact network
approvals, once-only filesystem exceptions and unsandboxed requests, and
revocation/restoration behavior. It stops using client terminals for execution.
See the current [sandbox parity matrix](sandbox.md#codex-comparison).

At that review, macOS had real enforcement tests, including denied credential-service Mach IPC,
filesystem/symlink boundaries and filtered network access. Linux integration had
not yet been executed here; native Windows remained unsupported. Codex's automatic
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
