# Contributing

## Run from source

```sh
git clone https://github.com/JoDaC/orca-git-controls.git
cd orca-git-controls
orca plugin dev load .
```

The first load stops with `approval_required` and prints the access the plugin asks for, then a
command with `--approve <fingerprint>`. Read the list and run that command.

You can also add the folder in **Settings → Plugins → Development folders…**; the plugin's key is
then `local.git-controls`.

```sh
orca plugin open local.git-controls --panel branches   # show the panel
orca plugin shot local.git-controls                     # PNG of the panel
orca plugin logs local.git-controls                     # worker and panel logs
orca plugin dev watch .                                 # reload while editing
orca plugin dev unload .                                # remove it
```

## Tests

```sh
npm test            # git layer, snapshot, Orca CLI wrapper and worker (about 1 min)
npm run test:e2e    # the panel in headless Chrome against the demo repository (about 2 min)
```

The tests run git against throwaway repositories under `$TMPDIR`. They never touch your own
repositories or call the real Orca app. The end-to-end tests skip when Chrome is not found; set
`CHROME_PATH` to point at it, and `E2E_CONCURRENCY` to change how many run at once (default 4).

## Throwaway repository and browser preview

```sh
scripts/make-demo-repo.sh                       # $TMPDIR/orca-git-controls-demo/{work,...}
orca repo add --path "$TMPDIR/orca-git-controls-demo/work"
node scripts/dev-server.mjs "$TMPDIR/orca-git-controls-demo/work"
open "http://localhost:4519/"                   # or ?theme=dark
```

The demo repository has nested branch folders, two remotes, tags, branches with incoming and
outgoing commits, a branch checked out in a second worktree, and reflog history. The browser
preview runs the real worker with a stand-in host and gives the panel a mock `window.orca`.

## Layout

| Path | What |
| --- | --- |
| `orca-plugin.json` | Manifest: panel, palette commands, settings, capabilities |
| `worker/main.mjs` | Worker: workspace tracking, `.git` watcher, the `git` request handler, palette commands |
| `lib/git.mjs` | All git operations |
| `lib/snapshot.mjs` | The JSON the panel draws |
| `lib/workspace.mjs` | Finds the focused workspace's path |
| `lib/orca-cli.mjs` | Orca CLI calls: list worktrees and terminals, open or create a worktree |
| `panel/` | The panel: plain HTML, CSS and ES modules, no build step |
| `scripts/` | Demo repository and browser preview |
| `test/` | `node:test` suites |

Git is looked up in `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin`, then on `PATH`. Set
`ORCA_GIT_CONTROLS_GIT` or `ORCA_GIT_CONTROLS_ORCA` to use other git or Orca binaries.

## Why some things work the way they do

These come from Orca's plugin API in 1.4.246 (host API 1.2).

- **Commit, Push and Pull are the plugin's own.** Host API 1.2 cannot run Orca's built-in actions
  (`commands.run` is host API 1.3, and it does not cover commit or push). "Git: Commit (Orca
  Source Control)" opens Orca's Source Control sidebar through the one declarative action
  available.
- **Palette commands that need input ask you to open the panel.** No host call opens or focuses a
  plugin panel. The plugin ships no default keybindings, to avoid clashing with Orca's.
- **The focused workspace's path is inferred.** `workspace.readContext` gives the branch, display
  name and terminal ids, not the path. The worker matches them against `orca worktree list` and
  `orca terminal list`. On a tie it picks the most recently active workspace, and the header
  tooltip says so. Click the header to pin a workspace.
- **Opening another worktree goes through the CLI.** `workspace.open` is host API 1.3, so the
  worker focuses a terminal of that worktree, or opens one there.
- **Diffs, logs and blame are text views in the panel.** Plugins cannot open Orca's diff viewer
  for an arbitrary ref pair or annotate the editor gutter.
- **Smart Checkout uses `git stash`.** If an untracked file of yours exists in the target branch,
  the unstash stops, the stash is kept, and the panel names the file.
- **Requests time out after 120 s.** A slower fetch or push keeps running in git; the panel
  refreshes when it finishes.
- **Desktop only.** Orca's browser client needs inline frame scripts, and this panel loads its
  modules by relative URL.
