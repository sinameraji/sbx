#!/usr/bin/env bash
# Demo part 2: the receipt (metered cost) + the microVM flex (pause with
# living processes). Continues from part1's state.
set -uo pipefail
source "$(dirname "$0")/lib.sh"
source "$DEMO_STATE"

say "6/ the receipt: every token, every dollar, metered per sandbox"
run "hotcell stats $SB"
say "an agent you didn't trust just built and served an app — for a fraction of a cent."
blank

say "7/ one more thing: microVMs. same daemon, hardware isolation, --driver applevz"
run "VM=\$(hotcell create --driver applevz --image base); echo \$VM"
run "hotcell exec \$VM 'uname -sm   # a real VM with its own kernel'"
run "hotcell start \$VM 'i=0; while true; do i=\$((i+1)); echo \$i > /tmp/tick; sleep 1; done'"
run "sleep 3; hotcell exec \$VM 'cat /tmp/tick'"
say "now hibernate it — full memory snapshot, compute freed:"
run "hotcell pause \$VM && hotcell ls | grep -E 'STATUS|\$VM' || hotcell ls"
run "hotcell exec \$VM 'cat /tmp/tick   # any operation wakes it…'"
say "…and the counter never died. processes survive hibernation."
blank

say "cleanup"
run "hotcell rm \$SB; hotcell rm \$VM"
blank
say "hotcell — npm install -g hotcell · pip install hotcell · hotcell.sh"
say "Apache-2.0, self-hosted, one daemon."
sleep 2
