# Upgrading and rollback

The agent has its own package, application directory and OS credential-store
entry. It does not import another agent's credentials, trust, sessions, hooks
or executable project settings.

## OpenMettle rename

The project is now **OpenMettle ACP**, at
[OpenMettle/openmettle-acp](https://github.com/OpenMettle/openmettle-acp).
The package is `openmettle-acp`, first released as 0.7.0; its executable is
`openmettle-acp`, with `openwebui-acp-agent` retained as an alias. The agent's
ACP title and MCP client metadata use the new name. The proposed, unpublished
ACP registry entry uses `openmettle-acp` too.

Compatibility identities remain unchanged:

- application state stays in `openwebui-acp-agent` under the configured user
  configuration directory;
- `OPENWEBUI_ACP_HOME` and `OPENWEBUI_API_KEY` keep their existing meanings;
- the OS credential service remains `openwebui-acp-agent`;
- administrator policy stays at the fixed `openwebui-acp-agent/policy.json` path;
- browser-wrapper package, image and Compose names are retained so existing
  containers and configuration continue to work.

No credential, trust or session migration runs. Existing client registrations
continue to use their installed executable until explicitly updated. When
installing 0.7.0 or later, its entrypoint is under
`node_modules/openmettle-acp/dist/cli.js`; preserve the registration's identity
and update only its command path. Keep the previous package for rollback.

Existing releases retain their original tarball names. The 0.6.0 artifact is
still `openwebui-acp-agent-0.6.0.tgz`; do not construct a renamed 0.6.0 asset URL.
Releases from 0.7.0 onwards use `openmettle-acp-VERSION.tgz`, starting with
`openmettle-acp-0.7.0.tgz`, and each needs a new immutable version. The renamed
package is distributed through GitHub Releases, not npm. The npm name check
returned no public package on 15 November 2026; that does not reserve the name or establish publishing rights.

## Upgrade

1. Stop active agent work and keep the previous version installed.
2. Install the new version in a separate prefix, or use your client's versioned
   registry installation.
3. Preserve non-secret configuration, private session files and permissions.
   Never copy keys into configuration or exported transcripts.
4. Update only this agent's client registration. Keep other agents and plugins.
5. Reconnect and check setup, model selection, workspace consent, a proposed edit,
   a command, cancellation and configured MCP tools.

Use exact versions rather than `@latest` in managed registrations. A new package
can add state fields; retain a private backup before testing a downgrade.
Restoration rechecks trust and never replays executed tools. Broad permission
modes, live jobs and unsandboxed state do not survive restoration.

For sessions whose stored workspace path is unavailable, the agent requests
explicit recovery approval before accessing the current project. Only approve
when the history belongs to that project. A valid path pointing elsewhere is
still a mismatch.

## Rollback

Stop the agent, restore its previous executable registration, and reconnect.
Use the saved state backup if the older version cannot read the new format.
Do not replace unrelated ACP entries, delete trust blocks or remove sessions to
force a launch. Revoking an operation grant does not undo completed edits or
remote effects; use checkpoints, version control and the remote service's own
controls as appropriate.

Uninstalling the package does not revoke an Open WebUI API key or delete retained
server-task chats. Use `/logout` for local sign-out and Open WebUI settings to
revoke the key or remove server chats. Delete private transcripts separately
when you no longer need them.
