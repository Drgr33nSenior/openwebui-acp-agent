# Migration and rollback

This document describes migration from the historical Qwen Code companion-plugin setup. The names below identify that old installation; the replacement is model independent and obtains its model catalog and controls from Open WebUI.

Keep the existing helper repository, installed plugin, launchers, trust rules, generated bundles, symlinks, ACP entries and sessions unchanged until separate retirement authorization. This implementation did not inspect or migrate the protected workstation credential files.

| Existing responsibility | Replacement |
| --- | --- |
| Qwen folder trust | Agent-owned canonical-root activation through ACP permissions |
| Generated Qwen runtime bundle | Versioned npm package with official ACP SDK |
| Plugin agent registration | Proposed ACP registry distribution; manual entry only for development |
| Gateway widget | `/status` and on-demand `/doctor` |
| Plugin settings | Agent login plus session configuration selectors |
| Search, retrieval and memory | Direct MCP discovery with startup and per-call approval |
| Qwen sessions | Independent local transcripts; no migration or replay |

Use an isolated IDE profile with the companion plugin disabled, a separate agent configuration directory and a temporary project. Do not remove the original installation. Enter a fresh Open WebUI API key only through local masked login. Do not read, copy, hash or migrate the legacy credential store.

For Air, use the cwd supplied by the client. Each new worktree needs its own approval. No shared parent, Git metadata directory or sibling worktree inherits trust.

Rollback consists of closing the preview agent and returning to the unchanged original profile/agent. Restore any test-profile registry override to its recorded prior value. Do not delete old sessions or trust to make rollback work. Remove the preview's isolated files only through an explicit user action after checking whether its transcripts are needed.

## Sandbox preview (0.2.0)

New sessions default to the workspace-write OS sandbox. Existing saved sessions
without a sandbox field load with that default. Existing workspace trust remains
valid, but command and MCP grant identities now include the sandbox policy; old
execution grants cannot silently authorize the changed context. Unsandboxed
selection is session-only and resets on restore or revocation.

Commands no longer use the IDE terminal API. The IDE still shows ACP permissions
and results, while the agent owns process cleanup. Filesystem editor integration
is unchanged. Home credentials and caches are not automatically accessible to
commands; Git worktrees may need a separate metadata read exception. See the
[sandbox guide](sandbox.md) before migrating active workflows.

The 0.2.0 package is prepared separately. The installed 0.1.5 preview, old helper,
ACP entries, credentials and sessions remain unchanged by this implementation.
To roll back a separately authorized installation, select its retained earlier
versioned executable; preserve newer transcripts and unrelated ACP settings.

## Version 0.3.0 permissions

Tool grants now include the administrator-policy revision in their scope. Earlier
tool-grant records remain on disk, but do not apply to the new scope; expect a
new tool approval after upgrading. Existing exact-workspace trust still requires
the same backend. Administrator rules can require stricter decisions. Approval
advice defaults to off and resets on session restore. See [managed policy](managed-policy.md).
