# Open WebUI ACP Agent

An unofficial coding agent for JetBrains AI Assistant, Air in JetBrains IDEs,
and other compatible Agent Client Protocol (ACP) clients. Connect your Open WebUI
installation, select a model, and work on your project from the IDE chat.

The agent reads and edits files, runs commands, checks its changes, and connects
to configured MCP tools. Open WebUI supplies the models and their supported
controls. Choose a model with working function calling; no particular model
family is required. No companion IDE plugin or Open WebUI extension is needed
for the core coding workflow.

## Installation

Use Node.js 26 LTS and npm on macOS or Linux. The package also accepts Node 24;
see [compatibility and testing](docs/verification.md). Native Windows is not
supported; see the [Windows plan](docs/windows-plan.md) for a later version.
Linux needs bubblewrap, socat and ripgrep for command isolation.

```sh
npm install --global https://github.com/Drgr33nSenior/openwebui-acp-agent/releases/download/v0.4.1/openwebui-acp-agent-0.4.1.tgz
```

In your ACP client's custom-agent settings, use an absolute Node executable and
the installed `dist/cli.js` entrypoint with the `acp` argument. An absolute Node
path also lets the IDE's setup terminal work with a minimal PATH. A manual
JetBrains registration has this form; preserve your other entries:

```json
{
  "agent_servers": {
    "openwebui": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/installation/node_modules/openwebui-acp-agent/dist/cli.js",
        "acp"
      ],
      "env": {}
    }
  }
}
```

`npm root --global` shows the global `node_modules` directory. This release is distributed through [GitHub Releases](https://github.com/Drgr33nSenior/openwebui-acp-agent/releases/tag/v0.4.1); no npm account is needed.
The [ACP registry manifest](registry/agent.json) is a proposal for future catalog
distribution. Its npm target is not published, and it is not an installable
catalog entry for this release. This project does not ship a JetBrains
Marketplace plugin. Client support depends on the installed ACP client version.

## Connect Open WebUI

1. Select the agent in the IDE and choose **Set up Open WebUI**.
2. In the setup terminal, enter the Open WebUI installation URL and API key.
   Key input is masked. A reverse-proxy prefix such as
   `https://chat.example.org/openwebui` is supported.
3. After setup reports a successful connection, return to the IDE and reconnect
   if requested. Choose a model using the session selector.
4. Start a prompt and approve access to the exact project or worktree.

Use the Open WebUI installation URL, not an OpenAI-compatible gateway URL.
Do not append `/v1`. Administrators must enable API keys, permit them for your
account, and allow `/api/models` and `/api/chat/completions` when endpoint
restrictions are enabled. The agent does not change server settings.

Keys are stored in the OS credential store, separately from JetBrains provider
settings. There is no plaintext fallback. Never put a key in chat, command-line
arguments, project files or ACP configuration. `/login` requests setup again;
`/logout` signs out and cancels active work without deleting transcripts or
revoking the server's API key. Reconnect after login or logout.

For a client without terminal authentication, `openwebui-acp-agent login` is the
manual fallback. Browser sign-in and OAuth are not implemented. See
[configuration and troubleshooting](docs/configuration.md).

## Working with the agent

- **Code and Plan:** inspect a project first, or let the agent propose diffs and
  apply approved edits. Editor filesystem integration preserves unsaved content
  where the client supports it. Stale edits are rejected.
- **Checks after edits:** the connected JetBrains bridge supplies file problems.
  Optional project test commands run in the command sandbox. Errors return to
  the model for a bounded number of repair rounds.
- **Commands and jobs:** command output streams into the tool log. Approved
  background jobs can be listed, polled and stopped with `/jobs`.
- **Undo:** `/checkpoints` lists agent edits; `/undo` proposes a reversal without
  overwriting later changes. It does not revert commands or remote effects.
- **Sessions:** browse saved sessions, set titles, fork a conversation and export
  it as Markdown or JSON. Restoring history never replays actions.
- **Context:** model-reported usage feeds the IDE context indicator. Automatic
  compaction preserves the original transcript; `/compact` is also available.
- **Model controls:** model and reasoning selectors use Open WebUI metadata.
  **Model default** sends no reasoning override.
- **Tools:** connect MCP servers for IDE features, search, retrieval or memory.
  Optional Open WebUI-managed tasks and a browser container have separate
  configuration and approvals.

See [session controls](docs/sessions.md), [MCP and server tools](docs/tools.md),
[browser setup](docs/browser.md), and [verification after edits](docs/ide-diagnostics.md).

## Permissions

Workspace activation, operation approval and OS isolation are separate controls.
Trust applies to the exact canonical project root and inference destination.
Another project or Air worktree needs its own decision.

| Permissions mode                     | Behavior                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Read only                            | File inspection; no edits, commands or MCP execution.                                                              |
| Ask each time                        | Ask for each protected operation; ignore saved tool grants.                                                        |
| Use scoped approvals                 | Reuse explicit matching grants, otherwise ask.                                                                     |
| Allow workspace edits                | Automatically approve workspace text edits for this session.                                                       |
| Allow edits and development commands | Also approve recognized inspection/test/build commands; other commands, network access and MCP retain their rules. |
| YOLO — full access (session) | After one confirmation, automatically approve operations and run commands/local MCP without an OS sandbox. |

Where supported, approvals offer one operation, the current session, or a
remembered workspace/backend scope. Command grants match exact arguments, not
prefixes. Unsandboxed commands, background launches and local HTTP MCP tools
require fresh approval outside confirmed YOLO mode. The narrow IDE file-problems
exception is described in
[verification after edits](docs/ide-diagnostics.md). Optional approval advice
also forces a human decision.

Select **YOLO — full access (session)** or send `/permissions mode yolo`, then
confirm at the next workspace prompt. Workspace activation is still required.
YOLO permits arbitrary commands, background jobs, edits, configured MCP calls
and enabled Open WebUI tasks without routine approval. Commands have your user
account’s filesystem and network access, including outside the project; they can
delete files, disclose data or change remote services. Approval advice is disabled.

YOLO is session-only and resets on restore, fork, logout or revocation. Changing
the permission mode, Sandbox setting or enabling advice exits it. Administrator
rules, Plan mode, authentication, TLS, tool validation and resource limits remain
enforced. File tools retain workspace/stale-content checks; MCP allowlists remain
in effect. Optional server tools still need enabling separately.

Use `/permissions` to inspect or revoke grants. Broader automatic modes reset
when restoring a session. The separate **Sandbox** selector controls filesystem
and network isolation; it does not grant permission. See [the sandbox guide](docs/sandbox.md)
and [administrator rules](docs/managed-policy.md).

## Privacy and storage

The agent adds no telemetry or analytics. Approved project context is sent to
your configured Open WebUI installation, whose providers have their own logging
and data-handling policies. MCP servers and delegated tools have their own data
boundaries.

Private application state is under
`${XDG_CONFIG_HOME:-~/.config}/openwebui-acp-agent` on macOS and Linux.
`OPENWEBUI_ACP_HOME` selects an isolated profile. Transcripts can contain source
code and user-provided sensitive text. They are retained until you delete them;
there is no automatic history deletion. See [session retention](docs/sessions.md).
Ordinary coding requests do not create Open WebUI chats; explicitly approved
server tasks do, and retain those chats.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm pack
npx --no-install prettier --check src test package.json package-lock.json registry/agent.json
```

Tests use fake services and synthetic credentials. See [the contributor guide](AGENTS.md),
[design](docs/design.md), [testing](docs/verification.md), [upgrades](docs/migration.md)
and [release checklist](docs/release.md).

MIT licensed. Independent of and not endorsed by Open WebUI or JetBrains.
Third-party acknowledgements are in [NOTICE](NOTICE).
