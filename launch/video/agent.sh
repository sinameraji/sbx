#!/usr/bin/env bash
# Act 2 — the airgap-killer. Tight timing so the payoff is on screen.
now(){ perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
S=$(now); wait_to(){ awk -v t="$1" -v s="$S" -v n="$(now)" 'BEGIN{d=t-(n-s); if(d>0) system("sleep " d)}'; }
tp(){ local x="$1" i; for((i=0;i<${#x};i++)); do printf '%s' "${x:$i:1}"; sleep 0.02; done; printf '\n'; }
P(){ printf '\033[38;5;244mroot@sandbox\033[0m:~# '; }
G(){ printf '\033[38;5;114m%s\033[0m\n' "$1"; }
D(){ printf '\033[38;5;244m%s\033[0m\n' "$1"; }
W(){ printf '\033[38;5;253m%s\033[0m\n' "$1"; }
clear
printf '\033[38;5;114m●\033[0m  \033[1mhotcell microVM\033[0m  \033[38;5;244m· so is it just an airgap?\033[0m\n\n'
wait_to 1;  P; tp 'ip link'
wait_to 3;  printf '1: \033[38;5;114mlo\033[0m: <LOOPBACK,UP>   \033[38;5;244m# the only interface — no network card\033[0m\n'
wait_to 5;  echo; P; tp 'agent → LLM task  (routed over vsock)'
wait_to 8;  W 'kimi: "A utility library provides ready-to-use helper'
            W '       functions for common programming tasks."'
wait_to 11; G '✓ completion returned over vsock · cost $0.00064'
wait_to 13; echo; printf '  \033[1;38;5;114mzero network interface.\033[0m  \033[1mthe agent still works.\033[0m\n'
wait_to 15; printf '  \033[38;5;244mthat is containment — not an airgap.\033[0m\n'
wait_to 18; :
