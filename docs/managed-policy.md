# Administrator rules and approval advice

Local administrator rules constrain operations; optional model advice helps
users review them. Neither requires enterprise integration or an API extension.
Native Windows is not supported.

## Administrator rules

The agent reads `/etc/openwebui-acp-agent/policy.json` on Linux and
`/private/etc/openwebui-acp-agent/policy.json` on macOS. The file and every parent
directory must be owned by root and must not permit group or other users to
write. Symlinks, malformed documents, unknown fields, non-regular files and files
larger than 32 KiB are refused. Administrators should replace the complete file
atomically. The agent never installs or changes this file.

No environment variable, project file or user setting can select a different
administrator policy. An absent file preserves the existing permission model.
An existing invalid file blocks protected operations; it does not fall back to
unmanaged operation. Initialization remains available without credentials.

This example limits the agent to one installation, disables MCP, permits only
sandboxed execution, and always asks for commands and edits:

```json
{
  "version": 1,
  "inferenceUrls": ["https://chat.example.org/openwebui"],
  "sandboxModes": ["workspace", "read_only"],
  "permissionModes": ["ask", "scoped", "read_only"],
  "mcpHttpUrls": [],
  "allowStdioMcp": false,
  "allowServerTools": false,
  "allowScopeExpansion": false,
  "networkDestinations": [],
  "alwaysAsk": ["command", "edit", "mcp-server", "mcp-tool", "network"],
  "reviewerModels": []
}
```

Omitted fields add no administrator restriction. Empty destination/model lists
deny all entries. Installation and MCP URLs match complete normalized URLs,
including path prefixes. They are not prefix or wildcard grants. An approved
URL still needs the user's normal authentication and permissions.

`networkDestinations` contains exact `{ "host": "example.org", "port": 443 }`
entries. It restricts connections from sandboxed commands and local MCP
processes. When present, it also forbids unsandboxed execution, which could
bypass the proxy. It does not control inference traffic, HTTP MCP destinations,
or a remote server's own network; those have separate destination rules.
An allowed server can receive data and can perform its own downstream actions.

`allowScopeExpansion: false` refuses command filesystem exceptions and explicit
command escalation. Local MCP installation read scopes still need startup
approval; disable stdio MCP if those processes must not run.
`allowServerTools: false` denies Open WebUI-managed delegated tasks. When
`mcpHttpUrls` is present, delegation also requires the Open WebUI installation
URL in that list. These controls do not restrict downstream tools inside an
allowed server; Open WebUI's account/model policy controls them. Delegated tasks
require approval or a user-selected scoped grant and retain server chats.
`alwaysAsk: ["mcp-tool"]` forces fresh approval for these tasks and direct MCP
tools. Automatic local permission modes do not grant remote access. Internal
server calls do not receive separate ACP approvals.
`alwaysAsk` overrides saved grants and automatic permission modes for the listed
operation categories. It exposes only a single-operation allow option. A model
review cannot override these rules or authorize a denied operation.

Selectors omit prohibited modes. At least one sandboxed mode and one permission
mode that requires human decisions must remain available. Policy revisions are
bound into grant scopes. Changing, adding or removing the administrator policy
invalidates an existing session; reconnect before continuing. The agent checks
before protected operations and after pending approval, and checks active turns
every 250 ms to cancel owned work when policy changes. Cancellation cannot undo
completed writes or remote effects, and stopping a process is not instantaneous.

`/status` reports the policy, its revision, selected modes and reviewer. An
administrator must also control the installed agent and launch configuration if
users must be prevented from running modified agent code. A root-owned policy
file alone cannot constrain a user who controls their own executable, another
terminal, or another ACP agent. This is a local enforcement layer, not centralized
enterprise identity, device management or a security audit service.

## Advisory review in the IDE

Choose a model in **Approval advice**, or use `/reviewer <exact-model-id>`.
Use `/reviewer off` to disable it. The selector lists discovered models allowed
by the administrator. Advice is off by default and resets when a session loads.
Changing the coding model does not change the separately selected reviewer.

After workspace consent, each protected approval sends the displayed operation,
including its proposed diff or arguments, to that model on the same configured
Open WebUI installation. It does not send conversation history automatically.
Known credentials are redacted before transmission. The reviewer has a separate
conversation and receives an explicit empty `tools` array. It cannot execute
local tools. Its input is marked as untrusted operation data.

The result is an `approve`, `deny` or `uncertain` recommendation and a short
reason, displayed in the ACP permission request. All three still require a
human decision. While advice is enabled, the agent asks for each operation even
if a saved grant or automatic permission mode would otherwise allow it. It does
not save the advisory verdict as a permission grant or transcript entry.

Requests have a 10-second deadline, a 24 KiB input limit and an 8 KiB response
limit. Oversized input is not silently truncated. Invalid JSON, unexpected tool
calls, missing models, authentication errors and timeouts produce an unavailable
review message and manual approval. Cancellation stops the review and prevents
the operation from starting. Raw model or HTTP errors are not exposed.

Open WebUI 0.12.5's
[middleware source](https://github.com/open-webui/open-webui/blob/v0.12.5/backend/open_webui/utils/middleware.py)
explicitly treats `tools: []` as opting out of normal built-in tool injection.
Server filters and model providers remain controlled by the deployment. Mock
contract tests verify the request shape; they do not prove a live deployment's
behavior or the quality of a review model's judgment.

Automatic model approval is unavailable. Model advice never replaces the user
decision, administrator restrictions or permission enforcement.
