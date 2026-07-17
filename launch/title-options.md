# Title (you submit it — this is a recommendation, not an action)

The blog-post H1 must be **byte-identical** to the HN submission title (HN mods
retitle posts to match the article; a mismatch invites a retitle you don't control).

## The branch logic (from §5)

- If the prompt injection **lands** (the agent runs the exfil):
  → **"The prompt injection worked. The exfiltration didn't."**
- If the injection is **resisted / inconclusive** but the malicious dependency
  **lands** (it always does — zero variance):
  → **"Nobody escaped the sandbox. The API key left anyway."**

## Hard "never" list

- Never: "I told an AI agent to steal my API key." We didn't *tell* it — that's
  the whole point, and "you instructed a program to exfiltrate a secret" kills
  the thread on arrival.
- Never: a title starting with `hotcell`.
- Never: a title containing an adjective.
- Never: an "X vs Y" shape.

## Show HN (fired separately, not the same post)

**"Show HN: Hotcell – agent sandboxes where the API key never enters the sandbox"**

## Recommendation

<!-- FILLED IN AFTER THE INJECTION RESULT IS CONFIRMED — see evidence/vector1-injection/ and launch/REPORT.md -->

Based on the evidence run, the injection was **declined** by the model we
tested (Kimi K2.5) across the placements we tried, while the malicious-dependency
vector leaked deterministically. That selects the second title:

> ## Nobody escaped the sandbox. The API key left anyway.

**Why it's the right one:**
- It states the exact, defensible finding: no isolation was breached (true —
  the container held, the kernel was untouched), yet the key still left (true
  in the bare-Docker baseline). It *is* the "containment ≠ isolation" thesis
  compressed to seven words.
- It creates a question the reader has to click to resolve ("how does the key
  leave if nothing escaped?"), which is what travels.
- It names no competitor, starts with no adjective, isn't "X vs Y," and doesn't
  claim we told anything to do anything.
- It is honest about the weaker vector: we are *not* claiming a live agent chose
  to steal — we're claiming the containment boundary is the wrong boundary. The
  malicious dependency (a postinstall script — the single most common real-world
  supply-chain vector) is all it takes.

If, on a re-run with a more capable/agentic harness, the injection *does* land,
switch to the first title — it is strictly stronger, and the evidence supports it.
