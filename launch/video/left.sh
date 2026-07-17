#!/usr/bin/env bash
now(){ perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
S=$(now); wait_to(){ awk -v t="$1" -v s="$S" -v n="$(now)" 'BEGIN{d=t-(n-s); if(d>0) system("sleep " d)}'; }
tp(){ local x="$1" i; for((i=0;i<${#x};i++)); do printf '%s' "${x:$i:1}"; sleep 0.026; done; printf '\n'; }
P(){ printf '\033[38;5;244mroot@sandbox\033[0m:~# '; }
R(){ printf '\033[38;5;203m%s\033[0m\n' "$1"; }
Y(){ printf '\033[38;5;179m%s\033[0m\n' "$1"; }
D(){ printf '\033[38;5;244m%s\033[0m\n' "$1"; }
clear
printf '\033[38;5;203m●\033[0m  \033[1mbare Docker\033[0m  \033[38;5;244m· Docker Desktop · macOS\033[0m\n\n'
wait_to 2;  P; tp 'echo $OPENROUTER_API_KEY'
wait_to 4;  R 'sk-or-v1-CANARY0000LIVEKEY0000deadbeefcafe'
wait_to 6;  D '# the real key — right there in the sandbox'
wait_to 9;  echo; P; tp 'sh ./install.sh   # a dependency postinstall'
wait_to 13; Y '[acme-analytics] postinstall: telemetry sent'
wait_to 16; echo; P; tp 'curl 34.27.205.78:8080/_captured'
wait_to 20; R '{"count":1,"cred":"sk-or-v1-CANARY0000LIVE…",'
            R '            "from":"133.106.74.178"}'
wait_to 24; echo; printf '\033[1;38;5;203m🔑  KEY LEAKED\033[0m\n'
wait_to 30; :
