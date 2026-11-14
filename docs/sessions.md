# Session controls

The IDE displays ACP session selectors when supported. Slash commands provide
fallbacks. Diagnostic commands do not make model inference requests.

| Command                                                  | Purpose                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `/help`                                                  | List commands                                                  |
| `/status`, `/doctor`                                     | Inspect connection, model, tools, permissions and dependencies |
| `/login`, `/logout`                                      | Request IDE setup or sign out                                  |
| `/model MODEL_ID`, `/reasoning CHOICE`                   | Select discovered model and supported reasoning choice         |
| `/permissions`                                           | Inspect permission mode, scopes and grants                     |
| `/permissions mode MODE_ID`                              | Choose an approval mode                                        |
| `/permissions sandbox workspace\|read_only\|full_access` | Choose OS isolation                                            |
| `/permissions revoke-tools`, `/permissions revoke`       | Revoke tool grants, or also block workspace access             |
| `/reviewer MODEL_ID`, `/reviewer off`                    | Enable or disable approval advice                              |
| `/plan on`, `/plan off`                                  | Switch between planning and coding                             |
| `/compact`, `/autocompact on\|off`                       | Compact context or change automatic compaction                 |
| `/queue on\|off`                                         | Queue incoming prompts or interrupt the active turn            |
| `/jobs`, `/jobs poll ID [OFFSET]`, `/jobs stop ID`       | Inspect, read or stop a background job                         |
| `/checkpoints`, `/checkpoints clear`, `/undo [ID]`       | Inspect edit history, clear it, or propose reversal            |
| `/sessions [CURSOR]`                                     | Browse saved sessions for this workspace/backend               |
| `/title [TEXT]`                                          | Set or clear the current session title                         |
| `/fork [TITLE]`                                          | Create a separate saved conversation                           |
| `/export PATH.md`, `/export PATH.json`                   | Propose an export into the workspace                           |
| `/server-tools on\|off\|refresh`                         | Control optional Open WebUI-managed tools                      |

## YOLO permissions

Choose **YOLO — full access (session)** or `/permissions mode yolo`. The next
workspace prompt asks for one explicit confirmation after workspace activation.
A denied, invalid or cancelled reply returns to the administrator-compatible
default approval mode. No model inference or configured process starts while
that confirmation is pending. `/status` shows `yolo.confirmed`.

Confirmation skips routine approvals and selects unsandboxed commands/local
MCP for this session. Administrator rules and resource limits still apply.
Restore, fork, logout and revocation do not preserve confirmation. Use
`/permissions mode scoped` to exit; changing Sandbox or enabling Approval advice
also exits. Plan mode still blocks execution. See [the access scope](../README.md#permissions).

## Models and context

Reasoning choices come from structured Open WebUI metadata. **Model default**
omits the override. Changing models refreshes choices and clears incompatible
settings; restoration retains a still-supported choice. Metadata and HTTP
acceptance alone do not establish that a provider applies the selected control.

The context indicator uses latest-call prompt and completion tokens with the
advertised full context window, falling back to the input budget. It does not
sum billing totals or estimate missing counts. Client rendering can retain an
old value until the next usage update.

Compaction summarizes older completed history while keeping the original
transcript, leading instructions, recent request and complete tool groups.
Automatic compaction runs before inference at 80% of reported context capacity
or 700000 serialized characters when a safe older prefix exists. Summarization
uses the selected model with tools disabled. Failure or cancellation preserves
context; automatic failure warns once per turn. Summaries are untrusted text,
not permission grants. Compaction cannot reduce an indivisible oversized message
or remove the local session-storage limit.

Plan mode allows inspection and structured progress updates. It blocks edits,
commands, MCP startup and server tasks. Plans persist through restore and
compaction without authorizing any operation.

## Incoming prompts

The default **Interrupt current turn** mode cancels active work, waits for cleanup,
and starts the latest waiting prompt. Partial assistant text and paired tool
results remain in history. Earlier waiting replacements return cancelled.

**Queue after current turn** processes delivered prompts in order, with at most
ten waiting messages. Each sees completed prior results and uses the normal
permissions. Stop cancels the active turn and all queued prompts. Logout and
disconnect discard waiting work; restore never restarts it. Individual request
cancellation removes that request. No Send now action is provided.

The client must allow sending overlapping prompts for queuing to be useful.
The selector cannot add a send button to an IDE that only offers Stop while busy.
The selected queue mode persists, but pending messages do not.

## Commands and background jobs

Command output appears as bounded, redacted tool-log updates before completion.
Background launches require explicit approval, even in development mode;
confirmed YOLO supplies session-wide approval instead.
There can be four running jobs and sixteen retained job results per session.
Each job has a maximum ten-minute lifetime and 100 KB output limit; polling
returns bounded pages. New network requests made while no turn is active are
refused rather than creating unattended approval requests. Unsandboxed YOLO
jobs do not use the network approval proxy.

Jobs can continue after a successful turn. Stop, logout, disconnect, revocation
and relevant permission/model changes stop owned jobs. Interrupted turns also
stop their jobs. Jobs are not restored or copied to forks. Process cleanup cannot
undo completed writes, external requests or detached work on a remote server.

## Checkpoints and instructions

Successful agent text edits record exact before/after content. `/undo` proposes
a diff and requests approval outside confirmed YOLO. It re-reads before applying
and refuses when later changes make the checkpoint stale. Undo covers agent file writes,
not shell commands, MCP actions, Git operations or remote tasks.

Keep at most twenty checkpoints with a combined 500 KB content budget.
`/checkpoints clear` discards only undo history, not files or transcripts.
Checkpoints containing configured credentials are refused. Creation undo needs
a safe delete operation: ACP editor filesystem methods do not provide one.
With those methods enabled, delete the file in the IDE after checking unsaved
content. Local creation undo is supported only on Linux and retains a recovery
copy; macOS requires manual deletion. Normal text replacement undo works through
the available client filesystem interface.

After activation, the agent reads bounded `AGENTS.md` guidance from the workspace
root through the target directory, up to sixteen levels and 64 KB in total.
Nested instructions apply to their subtree. Refreshed instructions are sent to
the model before a new edit proposal if they changed. Siblings and ancestors
outside the approved root are not loaded. Guidance cannot override permissions,
load hooks, or activate project executable configuration.

## History, forks and deletion

Session listing uses backend/header and exact workspace scope. Titles are
explicit, not automatically extracted from potentially sensitive prompts.
Forks copy conversation, valid model settings, queue preference and plan state;
they reset broad execution modes and omit jobs, tool grants, checkpoints and
remote-task runtime state. Open a fork from the client's session history.
Export writes a proposed Markdown or JSON transcript after approval; confirmed
YOLO supplies that approval automatically.
Review exported content before sharing it.

Local `session-UUID.json` files retain transcripts, reasoning and bounded state.
Loading rechecks roots, consent and policy; executed tools never replay. Limits
include 32 live sessions, 1000 stored sessions, 2 MB per serialized session and
64 MB aggregate storage. Quota exhaustion stops work rather than deleting or
silently truncating history. Stop the agent before deleting selected transcript
files. Keep configuration/trust files unless you intend to remove those too.
Known configured secrets are redacted, but arbitrary secrets in user text or
source files cannot be recognized reliably.
