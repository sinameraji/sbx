#!/bin/bash
# C5 — egress-token spend-cap / TTL survival across pause->resume (spend-cap-bypass security test).
#
# CODE VERDICT (from reading the daemon; see writeup for file:line): a token's accumulated spend
# (egress_tokens.spendUsd, keyed by TOKEN) and its TTL (policy.expiresAt, an ABSOLUTE wall-clock
# ISO timestamp) both live daemon-side in the node:sqlite store. The resume/start path
# (lifecycle.ts resumeSandbox -> driver.start) never re-mints the token, zeroes spend, or extends
# expiry; token rows are dropped only on full destroy/revoke. So a pause->resume loop cannot hand
# an agent a fresh budget or a fresh clock.
#
# This EMPIRICALLY confirms the property that needs no real money: a token minted with a short TTL,
# paused past its expiry, then resumed, must come back ALREADY EXPIRED — i.e. resume gave it no
# fresh clock. It also checks the token string is unchanged (not re-minted), the row count stays 1
# (no second token), and spendUsd/expiresAt are byte-identical before vs after resume.
#
# HONEST LIMITATION: real per-call spend accrual requires a live provider key (the gateway only
# increments spendUsd from an actual upstream response). We do not have one here, so we do not
# demonstrate the 402 firing from naturally-accrued dollars. The spend counter's *survival* across
# pause/resume shares the exact same code path and store as the TTL, which this test exercises.
set +e
NODE=$(command -v node); BASE=localhost:4750
DB=/tmp/egress-test.db; rm -f "$DB" "$DB"-* 2>/dev/null
OUT=/tmp/egress-token; mkdir -p "$OUT"
sudo pkill -9 -f "daemon/dist" 2>/dev/null; sudo pkill -9 -f firecracker 2>/dev/null; sleep 2
cd ~/hotcell
sudo -E env HOTCELL_DRIVER=firecracker HOTCELL_DB="$DB" HOTCELL_FC_KERNEL=helpers/hotcell-vz/guest/vmlinux-fc \
  setsid bash -c "$NODE packages/daemon/dist/index.js > /tmp/hotcelld-egress.log 2>&1" </dev/null & disown
for i in $(seq 1 30); do curl -s --max-time 2 $BASE/healthz | grep -q ok && break; sleep 1; done
val(){ $NODE -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).id||""))}catch{}})'; }
dbq(){ for t in 1 2 3; do OUT_JSON=$($NODE -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);console.log(JSON.stringify(db.prepare("SELECT token,sandboxId,spendUsd,policy FROM egress_tokens").all()));' "$DB" 2>/dev/null); [ -n "$OUT_JSON" ] && { echo "$OUT_JSON"; return; }; sleep 1; done; echo "[]"; }
ID=$(curl -s --max-time 180 -X POST $BASE/sandboxes -H 'content-type: application/json' -d '{"image":"ubuntu:24.04","driver":"firecracker","memoryMb":2048,"cpus":1}' | val)
echo "sandbox=$ID"
# mint a token: short 20s TTL + a spend cap
MINT=$(curl -s --max-time 30 -X POST "$BASE/sandboxes/$ID/egress-tokens" -H 'content-type: application/json' -d '{"ttlMs":20000,"spendCapUsd":0.50}')
echo "mint response: $MINT"
echo "=== STATE BEFORE (right after mint) ==="; dbq | tee "$OUT/before.json"; echo
echo "pausing; token TTL=20s, we wait 25s PAUSED so it lapses while suspended..."
curl -s -X POST "$BASE/sandboxes/$ID/pause" >/dev/null; sleep 25
echo "resuming after 25s (a reset TTL would make it valid again; an absolute TTL stays expired)..."
curl -s -X POST "$BASE/sandboxes/$ID/start" >/dev/null; sleep 2
echo "=== STATE AFTER (post-resume) ==="; dbq | tee "$OUT/after.json"; echo
$NODE -e '
const fs=require("fs");
const rb=JSON.parse(fs.readFileSync(process.argv[1]+"/before.json","utf8"));
const ra=JSON.parse(fs.readFileSync(process.argv[1]+"/after.json","utf8"));
const b=rb[0]||{}, a=ra[0]||{};
const pb=JSON.parse(b.policy||"{}"), pa=JSON.parse(a.policy||"{}");
const now=Date.now();
console.log("token count before/after :", rb.length, "/", ra.length);
console.log("token string identical   :", b.token===a.token);
console.log("spendUsd before/after    :", b.spendUsd, "/", a.spendUsd, "(reset? "+(b.spendUsd!==a.spendUsd)+")");
console.log("expiresAt before/after   :", pb.expiresAt, "/", pa.expiresAt, "(extended? "+(pb.expiresAt!==pa.expiresAt)+")");
console.log("spendCapUsd before/after :", pb.spendCapUsd, "/", pa.spendCapUsd);
const expired = pa.expiresAt && now > Date.parse(pa.expiresAt);
console.log("token EXPIRED after resume (now > expiresAt):", expired);
const pass = rb.length===1 && ra.length===1 && b.token===a.token && b.spendUsd===a.spendUsd && pb.expiresAt===pa.expiresAt && expired;
console.log(pass
  ? "RESULT egress-token: PASS — pause/resume did NOT re-mint, reset spend, or extend TTL; a 20s-TTL token is EXPIRED after a 25s pause+resume. No TTL/spend-cap bypass."
  : "RESULT egress-token: REVIEW — one or more invariants not met; see values above.");
' "$OUT"
curl -s -X DELETE "$BASE/sandboxes/$ID" >/dev/null 2>&1
echo EGRESSTOKENDONE
