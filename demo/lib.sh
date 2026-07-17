# Shared helpers for the self-driving terminal demo. Everything executed is
# REAL — real daemon, real sandbox, real model — only the typing cadence is
# simulated.
DEMO_STATE="${DEMO_STATE:-/tmp/hotcell-demo-state.env}"

# Print a dim "caption" line (not a command).
say() {
  printf '\033[2m# %s\033[0m\n' "$1"
  sleep "${SAY_PAUSE:-1.2}"
}

# Simulate typing a command at a prompt, then actually run it.
run() {
  printf '\033[1;32m$\033[0m '
  local cmd="$1"
  for ((i = 0; i < ${#cmd}; i++)); do
    printf '%s' "${cmd:$i:1}"
    sleep 0.014
  done
  printf '\n'
  sleep 0.25
  eval "$cmd"
  local rc=$?
  sleep "${CMD_PAUSE:-0.8}"
  return $rc
}

blank() { printf '\n'; }
