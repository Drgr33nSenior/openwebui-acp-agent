# Session controls

The IDE displays ACP session selectors when supported. Slash commands provide
fallbacks. Diagnostic commands do not make model inference requests.

| Command                                                  | Purpose                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `/help`                                                  | List commands                                                  |
| `/status`, `/doctor`                                     | Inspect connection, model, tools, permissions and dependencies |
| `/login`, `/logout`                                      | Request IDE setup or sign out                                  |
| `/model MODEL_ID`, `/reasoning CHOICE`                   | Select discovered model and supported reasoning choice         |
| `/mode ask\|plan\|code`                                  | Choose the session mode                                        |
| `/permissions`                                           | Inspect permission mode, scopes and grants                     |
| `/permissions mode MODE_ID`                              | Choose an approval mode                                        |
| `/permissions sandbox workspace\|read_only\|full_access` | Choose OS isolation                                            |
| `/permissions revoke-tools`, `/permissions revoke`       | Revoke tool grants, or also block workspace access             |
| `/reviewer MODEL_ID`, `/reviewer off`                    | Enable or disable approval advice                              |
| `/plan on`, `/plan off`                                  | Switch between planning and coding                             |
| `/compact`, `/autocompact on\|off`                       | Compact context or change automatic compaction                 |
| `/queue on\|off\|steer`                                  | Queue, interrupt or steer with prompts sent while busy         |
| `/jobs`, `/jobs poll ID [OFFSET]`, `/jobs stop ID`       | Inspect, read or stop a background job                         |
| `/checkpoints`, `/checkpoints clear`, `/undo [ID]`       | Inspect edit history, clear it, or propose reversal            |
| `/rewind`, `/rewind TURN [--keep-files]`                 | List turns, or return to before a turn                         |
| `/sessions [CURSOR]`                                     | Browse saved sessions for this workspace/backend               |
| `/title [TEXT]`                                          | Set or clear the current session title                         |
| `/fork [TITLE]`                                          | Create a separate saved conversation                           |
| `/export PATH.md`, `/export PATH.json`                   | Propose an export into the workspace                           |
| `/server-tools on\|off\|refresh`                         | Control optional Open WebUI-managed tools                      |

## Session modes

The **Mode** selector (ACP category `mode`) is a view over existing controls.
It adds no separate permission system:

| Mode | Maps to                                              | Effect                                                                                 |
| ---- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Ask  | **Read only** permission mode, Code workflow         | File inspection only. No edits, commands, MCP processes/tools or server tasks          |
| Plan | Plan workflow; permission mode unchanged             | Inspection and plan updates. Edits, commands, MCP startup and server tasks are blocked |
| Code | Code workflow with the selected **Permissions** mode | Current behavior: approvals, Sandbox and administrator rules apply                     |

Choosing Ask selects Read only and leaves YOLO. Choosing **Read only** in
Permissions also shows Ask. Returning to Code restores an earlier **Ask each
time** or **Use scoped approvals** choice from this connection; otherwise it
selects the safe default. It never restores edits, development or YOLO modes;
select those again explicitly. Plan keeps the Permissions value, so leaving Plan
returns to it. Administrator `permissionModes` rules hide Ask without
`read_only`, and hide Code when neither `scoped` nor `ask` is allowed.

The session file stores the workflow and non-elevated permission mode, so the
mode survives restore and fork. The model and reasoning choice are also saved per
session. `/status` reports `mode` and the available modes.

Clients that implement ACP v1 session modes, rather than config options, receive
the same three modes in `modes`, can use `session/set_mode`, and receive
`current_mode_update`. Config-option clients receive `config_option_update`.
Both views stay in sync. The earlier `workflow` selector ID is still accepted
but no longer advertised. `/plan on|off` remains available.

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

The model selector lists the models Open WebUI returns for your account, with
display names where provided. The configured model is selected for new sessions.

Reasoning choices come from structured Open WebUI metadata, in the server's
declared order. Only declared levels are offered; Off (`none`) appears only when
the server declares it. If the only reasoning control declares a valid default,
new sessions and model changes select that level and send it explicitly.
Otherwise **Model default** is offered first and omits the override. Changing
models refreshes choices and selects the new model's default. Restoration keeps
a still-supported choice and otherwise uses the declared default. Metadata and HTTP
acceptance alone do not establish that a provider applies the selected control.

The context indicator uses latest-call prompt and completion tokens with the
advertised full context window, falling back to the input budget. It does not
sum billing totals or estimate missing counts. Client rendering can retain an
old value until the next usage update.

Compaction summarizes older completed history while keeping the original
transcript, leading instructions, recent request and complete tool groups.
Automatic compaction runs before inference at 80% of reported context capacity
or 700000 serialized characters when a safe older prefix exists. It also runs
when the next request would not fit the model's usable input: the advertised
`max_input_tokens`, or `context_window` minus the output allowance (the model's
`max_output_tokens`, else `outputTokenBudget`). The request is estimated from
its serialized size and the characters-per-token ratio of the server's latest
reported prompt count; without a reported count only the 80% rule applies.
Summarization uses the selected model with tools disabled, and the summary
request is held to the same input limit; see
[summary requests](#compaction-summary-requests).

A turn compacts at most three times. Failure or cancellation preserves context.
Failure notices state the reason: the request was refused (with its HTTP
status); the summary was empty, cut off at the output limit or over 16,000
characters; it did not reduce the context; no older history fits; or the session
could not be saved. Notices never quote the summary or history. When the next request still fits, an automatic failure warns once per turn and
the turn continues. When it would not fit and compaction fails, is switched off,
has reached the limit or has no complete older history left, the turn stops
before sending anything and says why; history and tool results are retained.
Summaries are untrusted text, not permission grants. Compaction cannot reduce an
indivisible oversized message or remove the local session-storage limit.

The same checks run before the single corrected-reply attempt after a malformed
or truncated response. That request is rebuilt from the current compaction
checkpoint, with current instructions, plan and available-tool guidance. It shares
the turn's three-compaction limit and stops if the input still cannot fit.
No tool from the discarded response executes.

A high-context notice appears at most once per turn, after the model's buffered
text has finished. It does not reset the context wheel: every valid provider
usage measurement still reaches the client. The wheel can stay full during
summarization until a subsequent coding response reports new usage. Recovery
messages distinguish output-limit truncation from malformed tool replies;
compaction cannot raise the model's output limit.

Plan mode allows inspection and structured progress updates. It blocks edits,
commands, MCP startup and server tasks. Plans persist through restore and
compaction without authorizing any operation.

### Compaction summary requests

A summary request does not use the session's reasoning level. An uncapped high
effort can spend the rest of the context window thinking and return no summary.
The request instead sends the lowest declared `reasoning_effort` level other than
`none`, ranked by the parameter's levels (`minimal`, `low`, `medium`, `high`,
`xhigh`, `max`), not by declaration order. When no declared level has a known
rank, as with named workspace controls, the server's declared default is used;
otherwise the model default. Thinking off is not chosen: summary quality without
reasoning has not been measured.

The request also sends `max_tokens`: 6,000, or the model's `max_output_tokens` or
`outputTokenBudget` when smaller. The cap bounds thinking and summary together on
servers that count both. The instruction asks for at most 12,000 characters (two
per capped token when the cap is smaller); summaries over 16,000 characters are
rejected. With a reported server token count, the summary input is held to 90%
of the usable input and of the context window minus the cap, so the input and
the capped reply fit together.
Manual `/compact` uses the same request and limits.

A summary cut off at the output limit, or over 16,000 characters, is retried once
with a smaller cut: at most half the input, so fewer older messages. This retry
belongs to the same compaction and does not count toward the per-turn limit.

## Incoming prompts

The default **Interrupt current turn** mode cancels active work, waits for cleanup,
and starts the latest waiting prompt. Partial assistant text and paired tool
results remain in history. Earlier waiting replacements return cancelled.

**Queue after current turn** processes delivered prompts in order, with at most
ten waiting messages. Each sees completed prior results and uses the normal
permissions. Stop cancels the active turn and all queued prompts. Logout and
disconnect discard waiting work; restore never restarts it. Individual request
cancellation removes that request. No Send now action is provided.

**Steer current turn** (`/queue steer`) adds a message sent while busy to the
running turn. It joins after the current model reply and any tool calls from
that reply finish, before the next model request. Messages join in arrival
order. A message that arrives during a final reply makes the turn continue.
If the turn ends first, for example at the round limit, or the running turn is
a slash command, the message runs as the next queued turn. Slash commands
never join a running turn. A joined message's request returns when that turn ends, with
the same stop reason. Cancelling only that request after it joined does not
remove it from history; Stop cancels the whole turn.

A joined message is stored with a short marker that tells the model it adds to
the running request. It joins before the next request is built, so the
pre-request size check and automatic compaction include it. When compaction
summarizes past it, the turn's original request stays pinned, and up to ten
joined messages after that request are kept verbatim beside it.

The client must allow sending overlapping prompts for queuing or steering to be
useful. The selector cannot add a send button to an IDE that only offers Stop
while busy. The selected mode persists, but pending messages do not.

### What current clients can express

ACP v1 has no steering or queue field. Both are proposals for ACP v2
(agent-client-protocol RFD PR 1261, "steer and queue prompts"), so the agent
selects behavior through this session option rather than per message.

| Client | Sending while busy | Use |
| --- | --- | --- |
| Zed (external agents) | Zed queues the message itself and sends it after the turn ends. **Send Now** stops the turn, then sends. Zed documents its steer toggle for its own agent only. | The default interrupt mode. Overlapping prompts do not arrive, so steer mode has no effect. |
| JetBrains AI Assistant / Air | Earlier testing found only Stop while a turn runs. The JetBrains ACP documentation does not describe queueing or steering. | No overlapping prompts arrive. Stop, then send. |
| Clients that send `session/prompt` while one is pending | Each request reaches the agent. | Choose queue or steer. |

Recheck this against the installed client version; it is not a compatibility
guarantee.

## Commands and background jobs

Command output appears as bounded, redacted tool-log updates before completion.
Background launches require explicit approval, even in development mode;
confirmed YOLO supplies session-wide approval instead.
There can be four running jobs and sixteen retained job results per session.
Each job has a maximum ten-minute lifetime and 100 KB output limit; polling
returns bounded pages. New network requests made while no turn is active are
refused rather than creating unattended approval requests. Unsandboxed YOLO
jobs do not use the network approval proxy.

A background job's tool call stays in progress while the job runs. About once
a second it shows the job state, run time, retained output size and the last
2,000 characters of output. When the job ends, the tool call becomes completed
(exit code 0) or failed (stopped, limited or nonzero). Clients that advertise the
ACP `session.notices` capability also receive a notice. At its next model
request, the model receives one short status line per finished job, so it does
not need to poll repeatedly. `poll_job` and `/jobs poll` still page the full
retained output. Clients might not show updates that arrive after a turn has
ended.

Jobs can continue after a successful turn. Stop, logout, disconnect, session
close, revocation and relevant permission/model changes stop owned jobs.
Interrupted turns also stop their jobs. Jobs are not restored or copied to forks. Process cleanup cannot
undo completed writes, external requests or detached work on a remote server.

## Checkpoints and instructions

Successful agent text edits record exact before/after content. `/undo` proposes
a diff and requests approval outside confirmed YOLO. It re-reads before applying
and refuses when later changes make the checkpoint stale. Undo covers agent file writes,
not shell commands, MCP actions, Git operations or remote tasks.

### Rewind

`/rewind` lists the session's user turns with a short excerpt and the number of
agent edits in each one. `/rewind N` discards turn N and every later message,
and restores files changed by agent edits in those turns. The next prompt
continues from the shortened history. Slash commands such as `/undo` count as
turns, as do joined steering messages.

Each affected file must still contain the agent's last edit. A file that
already matches its earlier content is skipped. If any file changed after the
agent's edit, or between two agent edits, nothing is restored and history is
unchanged. Review the file, or use `/rewind N --keep-files`, which only rewinds
the conversation. Files then stay as they are, and their checkpoints stay
available to `/undo`.

All restorations appear in one diff approval, unless YOLO is confirmed. Each
file is re-read before it is written. A file that changed during approval
stops the rewind. Restored files then match their earlier content, so a retry
skips them. A rewind cannot run while background jobs are running. Restoring
files follows the `/undo` rules: it is unavailable in Plan or read-only mode,
and removing a file the agent created is limited in the same way. Delete such
a file manually, then rewind again. Rewind clears the task plan and the context
indicator. It also drops a compaction summary that covered discarded messages.

Rewind restores only agent text edits recorded as checkpoints. It does not
revert commands, MCP or remote actions, Git operations, or edits made without a
checkpoint. Checkpoints created before this version have no turn information;
rewind leaves them for `/undo`. Your client may still show discarded messages
until you reopen the session from history. ACP v1 has no history-truncation
update. The rewind proposal in agent-client-protocol PR 1321 is an unmerged ACP
v2 draft, so this is a slash command.

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
load hooks, or activate project executable configuration. `AGENTS.md` is the
only instruction file name loaded. Other agents' files, such as `CLAUDE.md`, and
project `skills/` or `.agents/skills/` directories are not loaded; the model can
read them with file tools when the guidance points to them.

## History, forks and deletion

Session listing uses backend/header and exact workspace scope. Titles are
explicit, not automatically extracted from potentially sensitive prompts.
Forks copy conversation, valid model settings, queue preference and plan state;
they reset broad execution modes and omit jobs, tool grants, checkpoints and
remote-task runtime state. Open a fork from the client's session history.
Export writes a proposed Markdown or JSON transcript after approval; confirmed
YOLO supplies that approval automatically.
Review exported content before sharing it.

Clients can open saved sessions through ACP `session/load`, which replays the
transcript, or `session/resume`, which restores it without replay. Replay
includes user and agent messages and each recorded tool call with its stored
result and outcome. Nothing is executed or approved again. Resume is for
clients that keep their own transcript. `session/close` stops a live session's
turns and jobs and frees its slot. It keeps the saved transcript.

Local `session-UUID.json` files retain transcripts, reasoning and bounded state.
Loading rechecks roots, consent and policy; executed tools never replay. Limits
include 32 live sessions, 1000 stored sessions, 2 MB per serialized session and
64 MB aggregate storage. Quota exhaustion stops work rather than deleting or
silently truncating history. Stop the agent before deleting selected transcript
files. Keep configuration/trust files unless you intend to remove those too.
Known configured secrets are redacted, but arbitrary secrets in user text or
source files cannot be recognized reliably.
