# hotcell

**Sandboxes for AI agents, on your own hardware.** A Mac Mini on your desk, a cloud VM, a bare-metal box — as many isolated agent sandboxes as it can hold, and your API keys never enter any of them.

```bash
npm i -g hotcell
hotcell            # first run: 30-second guided setup — then your live fleet
```

<p align="center">
  <img src="docs/media/tui-fleet.png" width="820" alt="hotcell fleet — five sandboxes running at full CPU with live memory and cost per cell" />
</p>

## The commands that matter

```bash
hotcell keys add openrouter                                       # LLM key — stays on the host, never in a sandbox
hotcell create -n 5 --repo https://github.com/you/app --branch    # five isolated cells, each on its own branch
hotcell terminal <id>                                             # shell inside a cell
hotcell run --setup "pip install ruff" "ruff check ."             # one-shot: create → run → destroy
hotcell rm --all                                                  # everything gone; your repo untouched
```

## Five OpenCode agents on one repo

```bash
curl -fsSLO https://raw.githubusercontent.com/sinameraji/hotcell/main/examples/agents.sh
bash agents.sh https://github.com/you/app 5
#   #1  hotcell terminal a1b2c3d4e5f6   →  cd app && opencode
#   …five lines — open a terminal for each, prompt each agent at a different feature
bash agents.sh --rm        # when the PRs are open
```

Each cell gets the repo, its own branch, and OpenCode wired up. Inside a cell, `pr "<title>"` pushes the branch and opens the pull request — git, the GitHub API, and the LLM all go through hotcell's gateway, so your OpenRouter and GitHub keys stay on the host. A sandbox only ever holds a per-cell token: leak it, and it's worthless.

<p align="center">
  <img src="docs/media/key-vs-token.png" width="820" alt="On the host, hotcell keys ls shows the real key; inside the sandbox, printenv shows only a short-lived token" />
</p>

## Why hotcell

- **Keys stay out.** Sandboxes reach LLMs and GitHub through a gateway that swaps a per-sandbox token for the real key — metered, spend-capped, revocable. Optional default-deny egress (kernel-enforced on Linux and microVMs; advisory on macOS Docker).
- **As many as the hardware allows.** One daemon, live CPU/mem/cost per sandbox, admission control that refuses to over-subscribe instead of OOM-ing the box.
- **Containers or microVMs** — Docker everywhere, Firecracker (Linux/KVM) and Apple VZ (macOS) for VM-grade isolation, all behind one interface.

Docs: [guide](docs/guide.md) · [egress & keys](docs/egress.md) · [every command & config](docs/reference.md) · [Linux self-hosting](docs/self-hosting.md) · Python SDK: `pip install hotcell`

## License

Apache-2.0
