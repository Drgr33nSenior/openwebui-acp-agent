# Upgrading and rollback

The agent has its own package, application directory and OS credential-store
entry. It does not import another agent's credentials, trust, sessions, hooks
or executable project settings.

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
