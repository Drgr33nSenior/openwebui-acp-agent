# Coding-agent feature audit

Research date: 13 November 2026. This review combines the local 0.3.0 source,
official documentation and original user reports. It identifies useful behavior,
not a promise of feature parity with Codex. See [verification](verification.md)
for observed test results and separate live-client acceptance.

## What the project already provides

| Area | Current source behavior | Practical limit |
| --- | --- | --- |
| Local coding loop | Stable ACP v1, Open WebUI model discovery, streamed/non-streamed completions, validated tool rounds | Model function calling still needs behavioral verification |
| IDE setup | Masked terminal authentication, OS credential storage, login/logout, redacted diagnostics | Client terminal-auth support and key permissions vary |
| Workspace access | Canonical exact-root consent, worktree separation, session/persisted grants, active revocation | Workspace trust is separate from command approval |
| Editing | Approved diffs, client filesystem integration, stale-content checks, atomic local writes | No atomic editor compare-and-swap contract or general undo |
| Commands | Owned sandbox processes, explicit network/path scope, output/time limits and cancellation | Foreground execution; no persistent terminal or background process session |
| Permissions | Session selectors, exact scoped grants, administrator restrictions, optional advisory review | Model advice never authorizes execution |
| MCP | Explicit stdio, Streamable HTTP and SSE servers; separate credentials, schema validation and approvals | IDE/remote execution occurs outside the local command sandbox |
| Server tools | Opt-in delegated Open WebUI tasks, discovered tools, retained chats, image/citation output | Approval covers a delegated task, not each server-side call |
| Conversation | Bounded persistence, `session/load`, no tool replay, root revalidation, context-usage reporting | No general session browser, fork or delete API |
| Controls | Model/reasoning selectors, status/doctor, permissions, server tools and slash commands | Unsupported provider controls are not invented |

Evidence is in `src/agent.ts`, `backend.ts`, `permissions.ts`, `workspace.ts`,
`sandbox.ts`, `mcp.ts`, `server-tools.ts`, `usage.ts` and their focused tests.
Root `AGENTS.md` is loaded after workspace activation. Nested instruction lookup,
skills, hooks and project executable configuration are not automatically loaded.

## What the research supports

Three Exa searches returned 30 result slots and 30 distinct URLs. Six original
GitHub issue pages were fetched. Search results are selected evidence, not a
survey of all users. Reaction totals were not verified, so this review does not
rank features by popularity. Closed reports establish historical needs; they do
not prove a current defect in Codex or Claude Code.

| Recurring need | Primary evidence | Design consequence |
| --- | --- | --- |
| Keep the latest request intact through compaction | [Claude Code #22376](https://github.com/anthropics/claude-code/issues/22376), 1 February 2026; closed as duplicate | Retain the latest user request verbatim and preserve instruction state |
| Continue the same task after context reduction | [Codex #18720](https://github.com/openai/codex/issues/18720), 20 April 2026; closed | Preserve constraints, completed work and next actions; reject unusable summaries |
| Make session approval predictable | [Claude Code #21835](https://github.com/anthropics/claude-code/issues/21835), 30 January 2026; closed as duplicate | Explain grant scope and test reuse, isolation and revocation |
| Inspect a plan before implementation | [Codex #4897](https://github.com/openai/codex/issues/4897), 7 October 2025; closed | Provide a planning mode that enforces restricted tools; a plan does not grant execution rights |
| Recover from unwanted changes | [Claude Code #6001](https://github.com/anthropics/claude-code/issues/6001), 18 August 2025; closed | Design reviewed, stale-safe restoration for agent edits, with explicit limits |
| Resume work and observe longer tasks | [Codex #19655](https://github.com/openai/codex/issues/19655), 26 April 2026; closed | Keep progress and session controls discoverable; consider owned background process sessions |

The official [Codex command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
and [CLI overview](https://learn.chatgpt.com/docs/codex/cli) provide the comparison
baseline for compaction, planning and session workflows. Their presence in Codex
does not establish support in a particular ACP client. The
[ACP v1 plan contract](https://agentclientprotocol.com/protocol/v1/agent-plan)
provides structured plan updates; it does not approve tool operations or require
a particular client display.

## Essential additions selected for this pass

The following additions passed local automated verification (190 tests on macOS).
They have not yet passed interactive PyCharm/Air or live-model acceptance.
See the verification record for commands, results and remaining limits.

| Addition | Intended behavior | Required verification |
| --- | --- | --- |
| `/compact` and automatic compaction | Reduce older completed context while retaining the latest user request, original transcript and tool-call/result ordering | Empty/failed/cancelled summary leaves history intact; no tool replay; no repeated compaction loop; restored state remains usable |
| Structured task progress | `update_plan` sends stable ACP plan updates and preserves the task list in session state | Validate entries and statuses; isolate sessions; restore without executing steps |
| Plan/Code selector and `/plan on\|off` | Plan mode permits list/read/search and plan updates only | Enforce the restriction before tool execution, including model-generated attempts; prohibit commands, edits, MCP and server tasks |
| `/help` and command feedback | Explain available commands and reject unknown slash commands clearly | New and restored sessions advertise the same supported controls; diagnostic commands do not infer or activate workspace access |
| Configured MCP status | Distinguish configured servers from connections open during a turn | An idle connection count must not imply that no servers are configured |

Compaction uses ordinary summarization through the configured Open WebUI model.
It is not OpenAI's native encrypted compaction and needs no Open WebUI extension.
Summary quality depends on the model. A shorter payload is not proof that the
summary preserved every fact. Keep the original history and expose failures;
never treat summary text as a new permission or system policy.

Planning must not change the selected command sandbox, network policy or saved
grants. Returning to Code mode restores tool availability subject to those
controls; it does not approve the plan's operations wholesale.

## Suggested next work

These priorities are engineering judgments based on user impact, current gaps
and implementation risk. They are not a vote ranking.

| Priority | Item | Why it is useful | Acceptance boundary |
| --- | --- | --- | --- |
| Next | Incremental command output and bounded background jobs | Builds, tests and development servers can outlive a foreground turn | Owned process IDs, bounded logs, polling, targeted cancellation, logout/revocation cleanup and no silent orphan processes |
| Next | Session listing, titles and explicit export | Users can find and continue work without locating state files manually | Stable ACP capability checks, pagination, private metadata, destination/root checks; export only on explicit request |
| Next | Agent-edit checkpoints and reviewed undo | Recover from a wrong edit while preserving user changes | Track only agent edits, show a restore diff, re-read before write; no automatic Git reset/stash/commit and no promise to undo command or remote effects |
| Next | Nested `AGENTS.md` handling | Large repositories need directory-specific instructions | Load only after consent, enforce root boundaries and byte limits, define precedence and preserve untrusted-input treatment |
| Before broad release | Remote MCP payload bounds and full client acceptance | Reliability and enforcement matter more than a larger feature list | Test malformed/oversized remote responses, registry setup, AI Assistant and Air separately; preserve release gates |
| Later | Selected reusable skills | Share repeatable workflows without repeating long prompts | Explicit user-level installation and selection; distinguish text guidance from executable configuration and approval |
| Later | Image input for coding tasks | Useful for screenshots and visual bugs | Verify model input contract, supported ACP content, payload limits, credential redaction and local-file consent |
| Later | Review command and configurable verification workflow | Make a final diff review and appropriate checks easier to request | Review output needs evidence; no automatic commit, publication or destructive cleanup |
| Later | MCP progress, resource selection and elicitation | Rich servers can expose clearer progress and structured questions | Capability negotiation, cancellation and independently verified server/client behavior |
| Separate sprint | Native Windows | Enables use without a Linux environment | Credential/state ACLs, process trees, command sandbox and installed-package tests on Windows; compilation is insufficient |

Multi-agent orchestration, automatic model approval, enterprise identity and
remote execution are not prerequisites for this local agent. Each would require
separate product scope and enforcement tests. Registry installation and reliable
first-use authentication remain release acceptance requirements, not optional
features displaced by this backlog.
