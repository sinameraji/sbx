# Publishing hotcell

The goal UX: `npm install -g hotcell` gives the CLI (`hotcell`, alias `hc`) and
the daemon (`hotcelld`) in one install. Four packages ship from this monorepo,
in dependency order:

| Package           | What                                        | Publish order |
|-------------------|---------------------------------------------|:---:|
| `@hotcell/sdk`    | zero-dependency TS client                   | 1 |
| `@hotcell/daemon` | the daemon (containers + microVM drivers)   | 2 |
| `hotcell`         | flagship: CLI + bundled daemon bins         | 3 |
| `@hotcell/mastra` | Mastra tool integration                     | 4 |

## 0. One-time setup

```bash
npm login                          # your npmjs.com account (enable 2FA)
# Create the @hotcell scope: npmjs.com → Add Organization → name: hotcell (free plan).
# The unscoped name `hotcell` is claimed by the first publish of packages/cli.
```

## 1. Preflight (every release)

```bash
npm install && npm run build       # clean build of all workspaces
npm run test:agent                 # Go agent unit tests
npm run check:fc && npm run check:agent && npm run check:egress
npm run smoke                      # container e2e (needs Docker)
# microVM gates when touched: check:applevz / smoke:vz (Mac), smoke:fc (KVM box)
git status --short                 # must be clean; CI on main must be green
```

Version bump across all four packages (keep them in lockstep):

```bash
npm version 0.1.0 --workspaces --no-git-tag-version   # or the next version
# then update the two internal dep ranges if the major changed
git commit -am "release: v0.1.0" && git push
```

## 2. Publish (dependency order)

```bash
npm publish -w @hotcell/sdk --access public
npm publish -w @hotcell/daemon --access public
npm publish -w hotcell                       # unscoped: public by default
npm publish -w @hotcell/mastra --access public
```

Notes:
- Scoped packages need `--access public` on the FIRST publish (default is private).
- `files` in each package.json restricts the tarball to `dist/` — verify with
  `npm pack -w hotcell --dry-run` before the real publish.

### 2FA (July 2026 npm policy change)

npm is deprecating 2FA-bypass tokens (account ops: Aug 2026; direct publish:
Jan 2027 — after that such tokens can only *stage* a publish for human 2FA
approval). Publish **interactively with 2FA on**: npm ≥10 opens a browser
WebAuthn prompt per publish, or append a fresh `--otp=<code>` to each command
(codes rotate every 30s — one per publish, don't reuse). Do NOT publish via
automation tokens from the terminal.

### Future releases: trusted publishing (OIDC, no tokens)

`.github/workflows/release.yml` publishes all four packages with provenance on
a `v*` tag push. Setup (once per package, only possible AFTER its first manual
publish): npmjs.com → package → Settings → Publishing access → add Trusted
Publisher → GitHub repo `sinameraji/hotcell`, workflow `release.yml`. From then
on a release is just: `git tag v0.2.0 && git push origin v0.2.0`.

## 3. Verify the install story

```bash
npm install -g hotcell
hotcell --help                     # CLI up
hotcelld &                         # daemon starts (needs Docker for containers)
hotcell run "python3 -c 'print(2+2)'"
```

## 4. Tag + GitHub release

```bash
git tag v0.1.0 && git push origin v0.1.0
gh release create v0.1.0 --title "hotcell v0.1.0" --generate-notes
```

## 5. Python SDK (PyPI, when ready)

`sdk/python` needs a `pyproject.toml` (name: `hotcell`, check availability with
`pip index versions hotcell`) — then `python -m build && twine upload dist/*`.

## 6. Later: one-command install

- Homebrew tap (`brew install sinameraji/tap/hotcell`) wrapping the npm install
  or a bundled binary.
- `curl -fsSL https://hotcell-bw3.pages.dev/install.sh | sh` on the landing page.

## Name registry status (checked 2026-07-17)

- npm `hotcell`: **available** (404).
- npm `@hotcell/*`: scope unclaimed — create the org before publishing.
- The old `sbx` name is taken on npm; everything here already uses hotcell.
