# Design and API contracts

## Data flow and ownership

```text
JetBrains or another ACP client
    -> stdio ACP v1 -> local agent
                         -> HTTPS -> configured Open WebUI installation
                         -> approved editor/file operations
                         -> owned sandboxed commands and stdio MCP
                         -> separately approved HTTP/SSE MCP servers
```

The local agent owns conversation history, tool validation/execution, permissions,
limits and cancellation. Open WebUI supplies inference and model metadata.
Normal coding requests contain caller-owned tool definitions. Optional delegated
server tasks use a separate, explicitly enabled execution path.

The product has no companion IDE plugin, model-specific runtime, telemetry or
provider catalog. Model IDs are opaque. Inference, MCP and browser configuration
cannot silently change one another's destinations or share credentials.

## Dependencies and protocol

`package.json`, `package-lock.json` and `.node-version` are authoritative. The
agent uses strict TypeScript, Node LTS and the official SDKs:

| Contract                | Pin                                      |
| ----------------------- | ---------------------------------------- |
| ACP TypeScript SDK      | 2.6.0, stable default entrypoint, ACP v1 |
| MCP TypeScript SDK      | 1.32.2                                   |
| Command sandbox runtime | 0.0.83                                   |

SDK major version 2 does not select experimental ACP v2. Capabilities advertise
only implemented behavior. Stdout contains protocol messages only. Diagnostics
go to stderr with configured secrets redacted. Initialization does not require
credentials or a reachable backend.

Terminal authentication supports the stable `auth.terminal` capability and the
JetBrains legacy `_meta.terminal-auth` descriptor. The standard form appends
setup arguments; the legacy client replaces launch arguments, so its descriptor
includes the installed entrypoint. CLI setup routing takes precedence even when
`acp` is also present, and exits after login. Credentials never enter the ACP
stream. Manual CLI login is a fallback, not OAuth.

Sessions use the canonical cwd supplied by ACP. New/load/resume/close, streaming
prompt updates, cancellation, model/config selectors, slash commands, session
listing and client-gated notices use stable v1 APIs. Load replays stored messages
and recorded tool outcomes as updates. It never executes or approves them again.
Steering and rewind have no stable v1 method; v2 drafts exist only as
proposals. They use a session option and the `/rewind` command, respectively.
Session config options use the categories `model`,
`thought_level` and `mode`. The same Ask/Plan/Code/YOLO modes are also returned as
v1 `modes`, with `session/set_mode` and `current_mode_update`, for clients
without config-option support. See [session modes](sessions.md#session-modes).
Client filesystem capabilities take precedence for unsaved editor content;
denial cannot trigger a local fallback. Commands use the owned
runner because an ACP terminal capability does not guarantee OS isolation.

Incoming requests pass through a per-session turn scheduler. Interrupt mode
aborts and awaits cleanup, keeping the latest replacement; queue mode preserves
arrival order. Steer mode lets the oldest waiting ordinary prompt join the
active model turn. It joins after a complete tool group, before the next model
request. Embedded file paths are checked first, and the joined request returns
with the turn's stop reason. Prompts that are not absorbed run as queued turns.
Joined prompts carry `STEERING_PREFIX`. Compaction pins the latest unmarked
user request and quotes up to ten later marked prompts verbatim, so steering
never replaces the turn's pinned request.
Every prompt returns its own stop reason. Cancellation closes
pending permission waits and owned processes. Late replies cannot approve work.
Completed tool groups and partial text remain paired in history.

`edit_file` derives a full replacement from a unique literal match in current
text. It then shares `write_file`'s application helper: path and sandbox checks,
scoped instruction review, checkpoint/storage preflight, full-diff approval,
stale-content recheck, client filesystem or atomic local write, and persistence.
Both tools recheck scoped instructions after approval. New or changed instructions
return to the model before a model-proposed write. The existing explicitly
approved manual-export path retains its instruction-gate exception.
Only an actual successful file change adds a verification target and advances
the file mutation revision. No-op and rejected changes do neither.

## Open WebUI requests

Core inference uses `GET /api/models` and `POST /api/chat/completions` beneath
the configured installation prefix, with Bearer API-key authentication by default.
A custom header is explicit deployment configuration. HTTPS verification is
required; redirects and credential-bearing URLs are refused.

The caller-tools contract is based on Open WebUI 0.12.5 source and the core API
used with 0.13.3. A supplied `tools` array bypasses normal server tool resolution;
an explicit empty array also prevents ordinary tool injection. Coding requests
do not add `tool_ids`, `features`, chat IDs or session IDs. Deployment filters
and providers can affect behavior, so fake-server contract tests do not prove
a live provider's semantics.

SSE parsing preserves fragmented UTF-8, text and tool arguments. Non-streaming
replies are also supported. Argument normalization accepts only harmless forms
permitted by the declared schema; validation precedes execution. Multiple tool
calls keep their IDs and paired results across rounds. A malformed/truncated
reply gets one corrective re-ask before tools execute; HTTP failures and possibly
completed effects are not automatically retried.

Schema failures return bounded, redacted field-and-fix messages rather than raw
validation arrays. Permission denial keeps its separate wording and never asks
the model to retry. Only failures at the argument parser state that nothing
executed; response/state validation failures warn that effects may have occurred.
A truncated tool reply is discarded before execution; the
single re-ask requests smaller `edit_file` calls only when that tool is offered.
Runtime guidance uses a positive integer `max_output_tokens` from model metadata
(top level, then `openai`), or the private `outputTokenBudget` fallback of 12,288.
This is a planning allowance, not a measured output count or a request override.
No `max_tokens` or equivalent parameter is added to coding requests, with two
exceptions. Compaction summary requests send a fixed low reasoning setting and
`max_tokens` (see [sessions](sessions.md#compaction-summary-requests)). Coding
requests at the declared `xhigh` reasoning effort send an explicit `max_tokens`
within the advertised `context_window` (see
[sessions](sessions.md#models-and-context)).

The default remains 40 model rounds, maximum 100, with 64 attempted tool calls
per turn. Schema failures still consume a round and tool-call allowance. No free
retry allowance was added: one reply can mix failed validation and completed
side effects, and the live comparison does not justify changing these limits.
The existing one-re-ask rule for malformed/truncated replies remains bounded
within its model round. See the [targeted-edit measurements](edit-verification.md).

The optional Open WebUI task path uses native retained chats and task IDs.
It requires Open WebUI 0.9.0 or newer, with no upper version limit.
Discovery records the reported version for diagnostics and approval scopes;
response validation and task evidence determine success. An accepted version
does not establish compatibility.
Remote IDs are journaled before inference, server approvals remain authoritative,
and cancellation is best effort. This path does not promise per-tool ACP control.
See [server tasks](tools.md#open-webui-managed-tasks).

### Server-task minimum version

Open WebUI **0.9.0** is the source-verified minimum for this task workflow.
The preceding **0.8.12** release returns a singular `task_id` acknowledgement
and has no chat-scoped stop route. In 0.9.0, completion returns `status`,
`task_ids` and `chat_id`, and the chat-scoped stop route is present.
Sources: [0.8.12 main.py](https://github.com/open-webui/open-webui/blob/v0.8.12/backend/open_webui/main.py)
and [0.9.0 main.py](https://github.com/open-webui/open-webui/blob/v0.9.0/backend/open_webui/main.py).

| Required routes | Source at 0.9.0 |
| --- | --- |
| `GET /api/version`, `GET /api/config`, `GET /api/models`, `POST /api/chat/completions` | [main.py](https://github.com/open-webui/open-webui/blob/v0.9.0/backend/open_webui/main.py) |
| `GET /api/tasks/chat/{chat_id}`, `POST /api/tasks/chat/{chat_id}/stop` | [main.py](https://github.com/open-webui/open-webui/blob/v0.9.0/backend/open_webui/main.py) |
| `GET /api/v1/tools/` | [tools router](https://github.com/open-webui/open-webui/blob/v0.9.0/backend/open_webui/routers/tools.py) |
| `POST /api/v1/chats/new`, `GET /api/v1/chats/{id}` | [chats router](https://github.com/open-webui/open-webui/blob/v0.9.0/backend/open_webui/routers/chats.py) |
| `GET /api/v1/files/{id}/content` for generated images | [files router](https://github.com/open-webui/open-webui/blob/v0.9.0/backend/open_webui/routers/files.py) |

The [0.9.0 middleware](https://github.com/open-webui/open-webui/blob/v0.9.0/backend/open_webui/utils/middleware.py)
also resolves native tools and saves structured output and completion state to
the chat. Source inspection establishes the API baseline, not live acceptance
of every feature or deployment. Endpoint restrictions and account permissions
still apply. Future releases must pass response validation; incompatible
responses do not trigger an automatic retry or a switch to another API mode.
This minimum applies to optional server tasks, not core coding or direct MCP.

## Reasoning

Saved reasoning/thinking controls in `info.params.model_controls` supply explicit
options and map to `params.model_controls[modelId][controlId]`.
When the only reasoning control declares a `default` naming one of its options,
that option is the initial selection and is sent explicitly. A server can
resolve an omitted override differently from its declared default. Otherwise
**Model default** is offered and omits the override. Options keep the server's
declaration order; the agent adds, removes or sorts no levels. If saved controls
are absent, the agent can also consume explicit
`provider_model_controls.reasoning_effort` options and
map them to top-level `reasoning_effort`. That optional deployment metadata is
not present in the upstream Open WebUI 0.13.3 tag and is not a core requirement.
No values are inferred from a name, description or default effort alone.

Model changes refresh metadata and select the new model's default choice.
Restore keeps valid choices and otherwise uses the default choice. The selector uses ACP category `thought_level`; `/reasoning` is
the fallback. Acceptance of a parameter is not evidence of a behavioral effect:
that requires validation against the actual provider.

## ACP v2 readiness

The agent speaks ACP v1 and answers `protocolVersion: 1` to any request,
including v2 (the migration guide permits a v1-only agent to do so). The audit
below covers the v1 surfaces that ACP v2 removes or reshapes. The SDK's v2 and
unstable v1 entrypoints are drafts, and this project advertises stable v1 only.
Shapes that exist only there are deferred.

| API                                     | Current use                                                                    | v2 status                                     | Change                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `fs/read_text_file`                     | Reads unsaved editor text when the client advertises it; otherwise local reads | Removed                                       | None needed: local workspace reads are the fallback. Tested with a v2-shaped client                |
| `fs/write_text_file`                    | Writes through the editor when advertised; otherwise atomic local writes       | Removed                                       | None needed. Client denial never falls back. Created-file undo then uses the Linux-only local path |
| `terminal/*`                            | Not used; commands always use the owned sandboxed runner                       | Removed; agent-owned `terminal_update` added  | None. Display through `terminal_update` deferred to a v2 implementation                            |
| `session/set_mode`, `modes`             | Added: Ask/Plan/Code mirrored from the `mode` config option                    | Removed; `mode` config option replaces it     | Config option is canonical; v1 mode fields kept for v1 clients                                     |
| `current_mode_update`                   | Sent when the derived mode changes                                             | Replaced by `config_option_update`            | `config_option_update` is also sent                                                                |
| `session/set_config_option`             | String `value` select options                                                  | Requires `type: "id"` or `"boolean"`          | Deferred; v1 handler unchanged                                                                     |
| `plan` update                           | Full plan entries after `update_plan` and on restore                           | `plan_update` with `planId`; `cancelled`      | Deferred: stable v1 has no plan ID                                                                 |
| `session/request_permission`            | Prompt text in `toolCall.title`; diff/command details in tool content          | Required `title`; `subject` tool call/command | Deferred: stable v1 has no `title`/`subject`                                                       |
| `tool_call`                             | Creates tool calls before updates                                              | Removed; first `tool_call_update` creates     | Deferred                                                                                           |
| `diff` content (`oldText`/`newText`)    | Full before/after text for approvals and results                               | Replaced by `changes`/`patch`                 | Deferred                                                                                           |
| `session/load`, `loadSession`           | Restores history without replaying tools                                       | Replaced by `session/resume`                  | Deferred                                                                                           |
| `authenticate`, `logout`, `auth.logout` | Terminal setup check and sign-out                                              | `auth/login`, `auth/logout`                   | Deferred; terminal-auth compatibility unchanged                                                    |
| `mcpCapabilities.sse`                   | SSE MCP accepted                                                               | SSE transport removed                         | Kept for v1 clients                                                                                |
| `session/prompt` response               | Returns the turn's stop reason                                                 | Acknowledges insertion; `state_update` ends   | Deferred                                                                                           |

## Context and verification

Stable v1 `usage_update` reports validated latest-call counts (prompt plus
visible completion; reasoning excluded) against advertised
`context_window`, falling back to `max_input_tokens`. Missing data produces no
invented percentage. `PromptResponse.usage` is not sent: it is unstable in ACP v1
and its per-turn or cumulative meaning is unsettled upstream
(agentclientprotocol/agent-client-protocol issue 1860).

Older tool results are first cleared from the model's view in batches, with the
boundary saved in the session so the prompt prefix is stable between batches;
see [sessions](sessions.md#clearing-older-tool-results). The plan is never
placed ahead of the conversation.
Compaction is separate: it retains the full local transcript and a validated
summary checkpoint over complete older tool groups. Before each model request
the loop estimates the request against the usable input and compacts first when
it would not fit, at most three times per turn; see [sessions](sessions.md).
A failed compaction reports its reason; a summary that runs out of output room
is retried once over fewer older messages.
Summaries, project instructions, retrieved data and tool output are untrusted
model input. They cannot restore grants or alter destinations.

The initial request and its one allowed corrected reply share the same request
preparation step. Each rechecks input pressure, the compaction budget and workspace
permission before rebuilding context. Partial assistant text and the recovery note
remain in the retained transcript; discarded tool calls never enter executable
history. Context notices wait until the backend has flushed its buffered text,
so they cannot interrupt a sentence. Notice deduplication does not suppress ACP
usage updates or change their measurement basis.

Automatic verification collects bounded IDE file problems after agent edits and
runs explicitly configured project checks in the selected sandbox, or with
explicitly confirmed session-only YOLO access. Errors return to the model within
a finite repair budget. Incomplete/denied checks never count
as passing. See [the diagnostic contract](ide-diagnostics.md).

## Permissions, files and state

Workspace activation precedes project reads, instruction loading and MCP startup.
Trust covers an exact canonical root and disclosed destination. Session grants,
persisted operation grants, administrator restrictions and OS isolation are
independent. Root/home activation is rejected. Revocation prevents subsequent
protected operations, including already-waiting approvals.

YOLO confirmation is in-memory and bound to the permission epoch. Selection
alone grants nothing: a cancellable ACP decision follows workspace activation
and precedes context loading, inference and MCP startup. Confirmation selects
full-access execution and skips routine approvals; administrator rules take
precedence. Restore/fork cannot restore it, and revocation invalidates it.

Diff approvals show actual paths/content. Re-reads detect stale proposals;
local writes are atomic. Exact checkpoints support bounded safe undo. Nested
AGENTS.md lookup stays within the root and is refreshed before edits. No project
file loads executable configuration, credentials or trust policy.

Secrets use the OS store or explicitly supplied process environment credentials.
Private state uses bounded, validated 0600 files in 0700 directories. Trust/grant
writes re-read under a lock and atomically replace files without losing unrelated
records. Malformed/symlinked stores fail closed. Native Windows persistence is
disabled until appropriate ACL handling exists.

Sessions restore conversation without replaying tools. Saving fits each record
to 8 MB by trimming the oldest tool output in the stored copy only. Checkpoints,
the compaction summary and pinned requests are never trimmed, and the latest
three turns only when they alone exceed the limit. Forks exclude live grants,
processes and checkpoints; exports require an approved workspace write.
Background jobs belong to one live session and stop with cancellation/revocation.
Job progress updates are coalesced to about one per second and carry a bounded
output tail. Finished jobs are reported to the model once, as assistant-role
runtime notes, so compaction keeps the real user request pinned.

Rewind maps each checkpoint to the user turn that created it. The mapping lives
in a top-level session field, so the strict checkpoint schema is unchanged.
Rewind restores a file only from the agent's own checkpoint chain. The current
text must equal the last agent edit, and consecutive agent edits must be
contiguous. Otherwise nothing is restored. Restoration reuses the undo path:
scoped instructions, protected-path target checks, one diff approval, a
re-read before each write, client file methods or atomic local writes, and
Linux-only safe removal of created files. History truncation happens only
after every file succeeds.
See [session behavior](sessions.md), [sandbox](sandbox.md) and
[administrator policy](managed-policy.md).

## Primary contracts

- [ACP v1 specification](https://agentclientprotocol.com/protocol/v1/overview)
  and [TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk).
- [Registry authentication guidance](https://github.com/agentclientprotocol/registry/blob/main/AUTHENTICATION.md).
- [Open WebUI API](https://docs.openwebui.com/reference/api-endpoints/)
  and [caller/server tool distinction](https://docs.openwebui.com/reference/server-side-tool-calling/).
- [Open WebUI 0.12.5 middleware](https://github.com/open-webui/open-webui/blob/v0.12.5/backend/open_webui/utils/middleware.py)
  and [0.13.3 source](https://github.com/open-webui/open-webui/tree/v0.13.3).
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
- [JetBrains AI Assistant ACP](https://www.jetbrains.com/help/ai-assistant/acp.html)
  and [Air agent management](https://www.jetbrains.com/help/air/air-in-ides-manage-agents.html).

Use the pinned source and package schemas when changing a contract. Moving
website examples can describe different protocol or server versions.
