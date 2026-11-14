# Release checklist

## Source and package

- Review the complete diff and preserve unrelated working trees and installations.
- Use the existing MIT license, original SVG and accurate unofficial branding.
  Keep dependency licenses and NOTICE. Do not include deployment addresses,
  credentials, private model IDs, transcripts, test logs or local setup files.
- Update package/lockfile, protocol metadata and pinned registry distribution
  references to the same immutable version.
- Run [required checks](verification.md), dependency audits and installation from
  a tarball outside the checkout. Inspect `npm pack --dry-run` contents.
- Verify the active GitHub owner account before creating the source PR. The owner
  reviews and merges it. Do not rewrite shared history or merge automatically.
- Create a GitHub Release for the exact tested source revision. Upload the
  packed `.tgz` and `SHA256SUMS`, then download and install the public asset in a
  fresh prefix. Verify the checksum and repeat the installed-package check.
  Do not replace an existing version or asset silently.
- npm registry publication is optional and separate. If chosen, verify account
  ownership and authenticate locally; never paste tokens into chat or files.
  Publish the reviewed tarball and verify the public package's integrity.

Native Windows must remain excluded from support until state ACLs and execution
are implemented and tested. Mock tests cannot replace live IDE/backend acceptance.
No dependency audit or security control should be weakened to obtain a release.

## ACP registry

The manifest and icon are in `registry/`. Registry inclusion is separate from
GitHub release publication. The current npm-based manifest remains a proposal
until its package is published. Use version-pinned distribution references and empty environment
objects. Run upstream schema, icon, packaging and authentication checks without
altering their requirements. A structural pass does not prove a public package
exists or installs successfully.

Test installation in isolated client profiles. If the installed client supports
`llm.chat.agent.acp.external.registry.url`, record its value before changing it
and restore it afterwards. An external catalog override replaces the catalog;
it is not additive. Check support separately for AI Assistant and Air in IDEs.
Do not modify a normal profile or depend on internal extension points.

## Interactive acceptance

Record exact IDE/ACP client, Node, package and Open WebUI versions. Check:

1. Launch and IDE-driven masked setup without a companion plugin.
2. Model selection and real function calling; reasoning effects where supported.
3. Exact workspace/worktree consent, decline, session-only trust and revocation.
4. Diffs and stale-edit protection, command output, cancellation and background cleanup.
5. Direct MCP, automatic diagnostics and configured project checks.
6. Saved sessions, forks, exports and undo without replaying operations.
7. Server tasks and browser calls only when explicitly configured and approved.
8. Registry installation separately from manual registration.

Document unavailable or incomplete checks as such. Do not infer support for
all JetBrains products from one client build.
