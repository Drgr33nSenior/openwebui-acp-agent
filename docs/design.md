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

Sessions use the canonical cwd supplied by ACP. New/load, streaming prompt
updates, cancellation, model/config selectors, slash commands and session listing
use stable v1 APIs. Client filesystem capabilities take precedence for unsaved
editor content; denial cannot trigger a local fallback. Commands use the owned
runner because an ACP terminal capability does not guarantee OS isolation.

Incoming requests pass through a per-session turn scheduler. Interrupt mode
aborts and awaits cleanup, keeping the latest replacement; queue mode preserves
arrival order. Every prompt returns its own stop reason. Cancellation closes
pending permission waits and owned processes. Late replies cannot approve work.
Completed tool groups and partial text remain paired in history.

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

The optional Open WebUI 0.13.3 task path uses native retained chats and task IDs.
Remote IDs are journaled before inference, server approvals remain authoritative,
and cancellation is best effort. This path does not promise per-tool ACP control.
See [server tasks](tools.md#open-webui-managed-tasks).

## Reasoning

Saved reasoning/thinking controls in `info.params.model_controls` supply explicit
options and map to `params.model_controls[modelId][controlId]`.
**Model default** omits the override. If saved controls are absent, the agent can
also consume explicit `provider_model_controls.reasoning_effort` options and
map them to top-level `reasoning_effort`. That optional deployment metadata is
not present in the upstream Open WebUI 0.13.3 tag and is not a core requirement.
No values are inferred from a name, description or default effort alone.

Model changes refresh metadata and reset incompatible choices. Restore keeps
valid choices. The selector uses ACP category `thought_level`; `/reasoning` is
the fallback. Acceptance of a parameter is not evidence of a behavioral effect:
that requires validation against the actual provider.

## Context and verification

Stable v1 `usage_update` reports validated latest-call counts against advertised
`context_window`, falling back to `max_input_tokens`. Missing data produces no
invented percentage. Compaction is separate: it retains the full local transcript
and a validated summary checkpoint over complete older tool groups. Summaries,
project instructions, retrieved data and tool output are untrusted model input.
They cannot restore grants or alter destinations.

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

Sessions restore conversation without replaying tools. Forks exclude live grants,
processes and checkpoints; exports require an approved workspace write.
Background jobs belong to one live session and stop with cancellation/revocation.
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
