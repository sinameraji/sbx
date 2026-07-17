#!/usr/bin/env bash
now(){ perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
S=$(now); wait_to(){ awk -v t="$1" -v s="$S" -v n="$(now)" 'BEGIN{d=t-(n-s); if(d>0) system("sleep " d)}'; }
tp(){ local x="$1" i; for((i=0;i<${#x};i++)); do printf '%s' "${x:$i:1}"; sleep 0.026; done; printf '\n'; }
P(){ printf '\033[38;5;244mroot@sandbox\033[0m:~# '; }
G(){ printf '\033[38;5;114m%s\033[0m\n' "$1"; }
D(){ printf '\033[38;5;244m%s\033[0m\n' "$1"; }
clear
printf '\033[38;5;114m●\033[0m  \033[1mhotcell microVM\033[0m  \033[38;5;244m· Apple VZ · macOS\033[0m\n\n'
wait_to 2;  P; tp 'echo $OPENROUTER_API_KEY'
wait_to 4;  G 'hc-e0498f5a4f27dd9cd19e5484c3be3cd3ff206b6f…'
wait_to 6;  D '# a revocable token — the real key is on the daemon'
wait_to 9;  echo; P; tp 'sh ./install.sh   # a dependency postinstall'
wait_to 13; D 'postinstall: wget: 34.27.205.78: Network unreachable'
wait_to 16; echo; P; tp 'curl 34.27.205.78:8080/_captured'
wait_to 20; G '{"count":0,"items":[]}'
wait_to 24; echo; printf '\033[1;38;5;114m🔒  keys leaked: 0\033[0m\n'
wait_to 30; :
