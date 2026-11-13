# Optional Ubuntu application-specific namespace permission. Administrator review
# and installation are required. Do not install automatically from agent setup.
# This adds userns permission to the otherwise unconfined, root-owned executable.
# It does not define the command sandbox: bubblewrap arguments and seccomp do.
# Use the distribution's profile name: a second attachment for the same binary
# conflicts on newer Ubuntu. On CI this replaces only the disposable runner's
# bwrap profile. Other hosts require separate administrator review. Do not load
# alongside an older openwebui-acp-bwrap profile attached to the same executable.
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(default_allow) {
  userns,
}
