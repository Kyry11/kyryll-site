#!/usr/bin/env bash
#
# Removes a CONTACT_SENDER_ADDRESS *secret* left by an older deploy, once the
# variable that replaces it is live.
#
# A secret shadows a variable of the same name, so while it survives the Worker
# goes on sending as whatever address it holds — which is the stale-sender
# failure this whole change exists to repair.
#
# Deliberately a script rather than inline workflow shell: the previous version
# ran `wrangler secret delete --force`, which wrangler does not accept, so the
# command failed on argument parsing every time and the warning it printed was
# the only sign. Inline shell in the deploy job is the one part of this pipeline
# a pull request never executes, and the stubs accepted any arguments, so
# nothing caught it. Here it is exercised by scripts/deploy/test/run.sh against
# a stub that validates the command the way wrangler does.
set -uo pipefail

cd "$(dirname "$0")/../../worker" || exit 0

still_present() {
  # An unreadable answer is not evidence of absence, so it is reported as still
  # present — a warning that turns out to be unnecessary costs nothing, and the
  # opposite would claim a migration that had not happened.
  #
  # Two ways to be unreadable, and only one used to be handled. A command that
  # fails is obvious. A command that *succeeds* and prints something that is not
  # a JSON array — an HTML error page, a bare scalar — made `jq -e` exit
  # non-zero for a parse error, which reads exactly like "no such secret". So a
  # malformed listing skipped the deletion and then announced the migration had
  # happened. Parsing is therefore checked before the question is asked.
  local listing
  listing=$(npx wrangler secret list 2>/dev/null) || return 0

  printf '%s' "$listing" | jq -e 'type == "array"' >/dev/null 2>&1 || return 0

  printf '%s' "$listing" | jq -e 'any(.[]; .name == "CONTACT_SENDER_ADDRESS")' >/dev/null 2>&1
}

if ! still_present; then
  echo "No CONTACT_SENDER_ADDRESS secret to retire."
  exit 0
fi

# No --force: wrangler has no such flag and rejects the whole invocation. The
# `y` covers the confirmation prompt if one is asked for; in a non-interactive
# run wrangler answers it itself, and the input is simply ignored.
printf 'y\n' | npx wrangler secret delete CONTACT_SENDER_ADDRESS >/dev/null 2>&1

# Verified rather than assumed. The exit code of a command whose flags were
# wrong looks much like the exit code of one that worked, and the whole point of
# this step is a state change somebody has to be able to rely on.
if still_present; then
  echo "::warning::The CONTACT_SENDER_ADDRESS secret is still set. It shadows the variable, so the sender stays on the old address until it is removed: npx wrangler secret delete CONTACT_SENDER_ADDRESS"
  exit 0
fi

echo "CONTACT_SENDER_ADDRESS is a variable now; the shadowing secret has been removed."
