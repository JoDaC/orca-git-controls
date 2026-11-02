#!/usr/bin/env bash
# Creates a throwaway repository with branches, folders, two remotes, tags,
# ahead/behind counts and a branch checked out in a second worktree.
#   scripts/make-demo-repo.sh [dir]   (default: $TMPDIR/orca-git-controls-demo)
set -euo pipefail
DIR="${1:-${TMPDIR:-/tmp}/orca-git-controls-demo}"
case "$DIR" in
  "${TMPDIR:-/tmp}"*|/tmp/*|/private/var/folders/*) ;;
  *) echo "Refusing to create a demo repo outside \$TMPDIR: $DIR" >&2; exit 1 ;;
esac
rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR"
export GIT_AUTHOR_NAME=Demo GIT_AUTHOR_EMAIL=demo@example.com GIT_COMMITTER_NAME=Demo GIT_COMMITTER_EMAIL=demo@example.com
g() { git -c init.defaultBranch=main -c commit.gpgsign=false "$@"; }

g init -q --bare origin.git
g init -q --bare codex.git
g init -q work
cd work
g remote add origin ../origin.git
g remote add codex ../codex.git
echo "# Demo" > README.md && g add . && g commit -qm "Initial commit"
for i in 1 2 3; do echo "line $i" >> app.txt; g add . && g commit -qm "Main change $i"; done
g push -q -u origin main
g tag v1.0
g tag -a v1.1 -m "Release 1.1"

for b in feature/login feature/settings/theme feature/onboarding bugfix/crash-on-start release/1.2 experiment; do
  g checkout -q -b "$b" main
  echo "$b" > "$(echo "$b" | tr / _).txt"; g add . && g commit -qm "Work on $b"
done
g checkout -q feature/login
g push -q -u origin feature/login
echo more >> feature_login.txt && g commit -qam "Unpushed login work" && echo more2 >> feature_login.txt && g commit -qam "More unpushed login work"
g checkout -q bugfix/crash-on-start && g push -q -u origin bugfix/crash-on-start
g checkout -q release/1.2 && g push -q -u codex release/1.2
g push -q codex feature/onboarding:codex/onboarding-v2
g checkout -q main

# Someone else pushes to main and bugfix -> incoming commits.
cd ..
g clone -q origin.git other
cd other
echo remote >> app.txt && g commit -qam "Remote change on main" && g push -q origin main
g checkout -q bugfix/crash-on-start && echo fix >> bugfix_crash-on-start.txt && g commit -qam "Remote fix" && g push -q origin bugfix/crash-on-start
g checkout -q -b feature/remote-only && echo r > r.txt && g add . && g commit -qm "Remote only" && g push -q origin feature/remote-only
cd ../work
g fetch -q --all

# Reflog for "Recent".
g checkout -q experiment && g checkout -q feature/onboarding && g checkout -q feature/login && g checkout -q main

# A branch in a second worktree.
g worktree add -q ../work-hotfix -b hotfix/urgent

echo "Demo repo ready: $DIR/work"
