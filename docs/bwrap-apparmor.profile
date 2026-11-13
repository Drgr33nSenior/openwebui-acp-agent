# Optional Ubuntu application-specific namespace permission. Administrator review
# and installation are required. Do not install automatically from agent setup.
# This adds userns permission to the otherwise unconfined, root-owned executable.
# It does not define the command sandbox: bubblewrap arguments and seccomp do.
abi <abi/4.0>,
include <tunables/global>

profile openwebui-acp-bwrap /usr/bin/bwrap flags=(default_allow) {
  userns,
}
