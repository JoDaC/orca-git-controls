# Orca Git Branches

An Orca plugin that brings Android Studio's Git branches popup and Git menu into Orca.
Orca's own Git UI is a commit panel (commit, push, pull, sync), and it assumes one branch per
worktree. This plugin adds the rest. You can switch branches in an existing worktree, create,
rename, delete, merge, rebase and compare branches, and run the other items of Android Studio's
Git menu.

The plugin always works on the checkout of the workspace focused in Orca.

> **Status:** the git layer is tested (`npm test`). The panel was checked in a browser preview
> against a throwaway repository, in light and dark themes. It has **not yet run inside Orca**,
> because it needs Orca **1.4.246 or later** (see [Requirements](#requirements)).

## What it does

### Branches panel ("Git Branches" in the right sidebar, branch icon)

- **Search** at the top filters branches and actions, Git menu items included. Arrow keys move
  the selection. Enter or → opens the selected row. Esc or ← goes back.
- **Fetch** (top right) runs `git fetch --all --prune --tags`. The **gear** opens settings.
- **Actions:** Update Project…, Commit…, Push…, New Branch…, Checkout Tag or Revision…, and a
  **Git Menu** entry.
- **Recent:** recently checked-out branches, read from the HEAD reflog.
- **Local:** all local branches, grouped into collapsible folders by `/` (`feature/login` goes in
  folder `feature`). Favorites are listed first.
- **Remote:** grouped by remote (`origin`, `codex`, …), then by `/` folders.
- **Tags:** collapsible, collapsed by default.
- **Each branch row** shows:
  - a marker on the current branch;
  - a favorite star (`main` is starred by default; click to toggle);
  - incoming (↓, blue) and outgoing (↑, green) commit counts vs its upstream;
  - the upstream, right-aligned in muted text (struck through when it is gone);
  - a `worktree` badge when another worktree has the branch checked out;
  - a chevron that opens the branch submenu.
- **Local branch submenu:**
  - Checkout
  - New Branch from '…'…
  - Checkout and Rebase onto '<current>'
  - Compare with '<current>'
  - Show Diff with Working Tree
  - Rebase '<current>' onto '…'
  - Merge '…' into '<current>'
  - Update
  - Push…
  - Rename…
  - Delete
- **Remote branch submenu:** Checkout (makes a local tracking branch), New Branch from…, Compare,
  Show Diff with Working Tree, Rebase onto, Merge, and Delete (deletes the remote branch, after
  you confirm).
- **Tag submenu:** Checkout (detached), New Branch from…, Compare, Show Diff, Merge, Delete Tag.
- **Banner:** a banner shows while a rebase, merge, cherry-pick or revert is in progress. It has
  **Continue** and **Abort** buttons.

### Git menu (panel "Git Menu" and the command palette, prefix `Git:`)

- Commit, Push, Update Project, Pull, Fetch
- Merge…, Rebase…
- Branches…, New Branch…, New Tag…
- Reset HEAD… (soft, mixed, hard or keep)
- New Worktree… (Orca's own `orca worktree create`, so the new workspace appears in the sidebar)
- Worktrees… (each one has an "Open" button)
- Show Git Log
- Patch: Create Patch from Local Changes (saved through Orca's save dialog), Apply Patch
  (`git apply --3way`)
- Uncommitted Changes: Stash, Unstash (pop, apply or drop any stash), Rollback
- Current File: Show History, Annotate with Git Blame, Rollback
- VCS Operations Popup

Palette commands that need no input (Fetch, Pull, Push, Update Project, Stash, Unstash Latest) run
at once and report the result in a desktop notification. Commands that need input open their
dialog in the Git Branches panel.

### Behavior

- **Checkout with local changes that git refuses to carry over:** you get Android Studio's choices.
  - **Smart Checkout:** stash (untracked files included), checkout, unstash. If the unstash
    conflicts, the panel lists the files and the stash is kept.
  - **Force Checkout:** discards your changes, after a second confirmation.
  - **Cancel.**
- **Branch checked out in another worktree:** the panel shows that worktree's path and offers
  **Open That Worktree in Orca**. The branch submenu shows "Open Its Worktree in Orca" in place of
  Checkout.
- **Confirmation first** for every destructive action:
  - deleting an unmerged branch (`-D` only after you confirm);
  - `reset --hard`;
  - force push (always `--force-with-lease`; offered when a push is rejected);
  - deleting a remote branch or a tag;
  - rollback;
  - force checkout;
  - abort.
- **Errors:** git's error text is shown verbatim in a dialog, with the git command and a Copy
  button. Nothing is swallowed.
- **Outside changes:** the worker watches the repository's `.git` directory. The panel refreshes
  when a terminal, an agent or another tool changes branches, refs, the index or the working tree.
  A 15-second fingerprint poll is the fallback.
- **Theme:** the panel uses Orca's frame theme variables (`--orca-*`) and the `dark` class, so it
  follows light and dark themes live.

## Requirements

- **Orca 1.4.246 or later.** The panel needs host API 1.2: `plugin.request`, the panel-to-worker
  channel, and panel access to settings. Orca 1.4.245 has host API 1.0, where a panel cannot
  reach its worker at all, so it cannot run git. Update Orca (its built-in updater, or the
  1.4.246 release on GitHub), then restart it.
- Git 2.23 or later on the machine. The worker looks for git in `/opt/homebrew/bin`,
  `/usr/local/bin` and `/usr/bin`, in that order. To use a different binary, set
  `ORCA_GIT_BRANCHES_GIT`.

## Install locally (development folder)

The plugin runs code (a `trusted-worker`), so Orca asks you to review and approve it once. It
asks for these capabilities:

- `workspace:read`: find the focused workspace;
- `notifications:show`: report palette command results;
- `storage:own`: store favorites;
- `settings:own`: store the update method and the other settings.

### From a terminal

```sh
cd /Users/jossicruz/StudioProjects/orca-git-branches
orca plugin dev load .
```

The first load stops with `approval_required` and prints what the plugin gets, followed by a
command with `--approve <fingerprint>`. Read the list, then run that command:

```sh
orca plugin dev load . --approve <fingerprint>
```

Useful afterwards:

```sh
orca plugin open local.git-branches --panel branches   # show the panel
orca plugin shot local.git-branches                     # PNG of the panel
orca plugin logs local.git-branches                     # worker and panel logs
orca plugin dev watch .                                 # live reload while editing
orca plugin dev unload .                                # remove it
```

### From Settings

1. **Settings → Plugins:** click **Turn on plugins** if plugins are off.
2. **Development folders…:** add `/Users/jossicruz/StudioProjects/orca-git-branches`.
3. Review the requested access and enable **Git Branches** (key `local.git-branches`).
4. Open **Git Branches** from the branch icon in the right sidebar.

Settings for the plugin (update method rebase/merge, recent count, show tags, fetch on open) are
under the plugin in Orca's Settings. The panel's gear opens the same settings.

## Try it on a throwaway repository

```sh
scripts/make-demo-repo.sh          # builds $TMPDIR/orca-git-branches-demo/{work,work-hotfix,...}
orca repo add --path "$TMPDIR/orca-git-branches-demo/work"
```

The demo repository has:

- nested branch folders;
- two remotes (`origin`, `codex`);
- tags;
- branches with incoming and outgoing commits;
- a branch checked out in a second worktree;
- reflog history for Recent.

Browser preview without Orca: this runs the real worker with a stand-in host and serves the
panel with a mock `window.orca`.

```sh
node scripts/dev-server.mjs "$TMPDIR/orca-git-branches-demo/work"
open "http://localhost:4519/"            # or ?theme=dark
```

## Development

```sh
npm test        # node --test: git layer + workspace matching, against repos under $TMPDIR
```

| Path | What |
| --- | --- |
| `orca-plugin.json` | Manifest: panel, palette commands, settings, capabilities |
| `worker/main.mjs` | Worker: workspace tracking, `.git` watcher, the `git` request handler, palette commands |
| `lib/git.mjs` | All git operations (listing, grouping, ahead/behind, recent, checkout modes, worktree conflicts, …) |
| `lib/snapshot.mjs` | The JSON the panel draws |
| `lib/workspace.mjs` | Finds the focused workspace's path |
| `lib/orca-cli.mjs` | Orca CLI calls: list worktrees and terminals, open a worktree, create a worktree |
| `panel/` | The panel: plain HTML, CSS and ES modules, no build step |
| `scripts/` | Demo repository and browser preview |
| `test/` | `node:test` suites |

## Known gaps vs Android Studio (Orca API limits)

These come from what Orca's plugin API offers in 1.4.246 (host API 1.2).

- **No popup window, menu bar entry or status-bar widget.** Plugins cannot add native menus or
  open floating popups. The "popup" is a right-sidebar panel, and the Git menu is the panel's
  "Git Menu" view plus `Git:` commands in the command palette. Status-bar items arrive in Orca
  1.4.248.
- **No global shortcut that opens the panel.** Plugin keybindings can only run plugin commands.
  No host call can open or focus a plugin panel, so a palette command that needs input asks you to
  open the panel, and its dialog is waiting there. The plugin ships no default keybindings, to
  avoid clashing with Orca's own. To add one, put a `contributes.keybindings` entry for a `Git:`
  command in `orca-plugin.json`.
- **Commit, Push and Pull cannot call Orca's own actions.** Host API 1.2 has no call that runs
  Orca's built-in actions (`commands.run` arrives in host API 1.3, and the actions it can run do
  not include commit or push). "Git: Commit (Orca Source Control)" opens Orca's Source Control
  sidebar through the one declarative action that is available. The panel's Commit, Push and Pull
  are the plugin's own.
- **The focused workspace's path is inferred.** `workspace.readContext` gives the branch, the
  display name and the terminal ids, but not the path. The worker matches those against
  `orca worktree list` and `orca terminal list`. If several workspaces have the same name and
  branch and the terminals do not decide it, the worker picks the most recently active one. The
  header tooltip says when this happens. Click the header to pin a workspace.
- **Opening another worktree uses the CLI.** `workspace.open` is host API 1.3, so the plugin
  switches to a terminal of that worktree, or opens a new terminal there, through the Orca CLI.
- **"Current File" asks for the file.** Plugins are not told which editor tab is active, so
  History, Blame and Rollback have a file picker over `git ls-files`. Blame is shown in the panel,
  not as editor gutter annotations.
- **Diffs and logs are text views in the panel.** Plugins cannot open Orca's diff viewer for an
  arbitrary ref pair. Show Diff with Working Tree, Compare and Show Git Log are drawn inside the
  panel.
- **No interactive rebase, cherry-pick or shelf.** These are not in the requested menu.
  Rebase is plain `git rebase`.
- **Smart Checkout uses `git stash`.** Android Studio can use shelves, and Git has no equivalent.
  If an untracked file of yours exists in the target branch, the unstash stops and the stash is
  kept. The panel names the file.
- **Long operations.** A panel request waits at most 120 s. A slower fetch or push keeps running
  in git, but the panel reports a timeout. It refreshes when git finishes.
- **Local workspaces only.** The worker runs git on this machine. SSH and remote Orca hosts are
  not supported.
- **Desktop app only.** In Orca's browser client, frames must inline their scripts, and this panel
  loads them by relative URL.

## License

MIT
