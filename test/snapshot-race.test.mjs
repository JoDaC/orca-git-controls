import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as g from '../lib/git.mjs'
import { fresh, sleep, waitFor } from './helpers/repo.mjs'
import { start, value, deactivate } from './helpers/worker.mjs'

// A git wrapper that makes the race deterministic: while the marker file exists, the
// fingerprint's ref read waits, and listRefs creates a branch right after reading the refs.
// lib/git.mjs caches the git path on first use, so this must be set before any git call.
const realGit = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'].find((p) => existsSync(p)) || 'git'
const wrapper = path.join(path.dirname(fresh('git-wrapper')), 'git-wrapper.sh')
writeFileSync(
  wrapper,
  `#!/bin/sh
REAL="${realGit}"
if [ -n "$RACE_MARKER" ] && [ -f "$RACE_MARKER" ]; then
  case "$*" in
    *"%(objectname) %(upstream:track)") sleep 0.3 ;;
    *" refs/tags")
      out=$("$REAL" "$@"); code=$?
      rm -f "$RACE_MARKER"
      "$REAL" branch raced >/dev/null 2>&1
      printf '%s\\n' "$out"
      exit $code ;;
  esac
fi
exec "$REAL" "$@"
`,
  { mode: 0o755 }
)
process.env.ORCA_GIT_CONTROLS_GIT = wrapper

afterEach(() => deactivate())

test('a ref created mid-snapshot is not hidden by a newer stored fingerprint', async () => {
  const { work, f } = await start()
  await sleep(700)
  await value(f, 'snapshot')
  f.clear()

  const marker = fresh('race-marker')
  writeFileSync(marker, '')
  process.env.RACE_MARKER = marker
  let snap
  try {
    snap = await value(f, 'snapshot')
  } finally {
    delete process.env.RACE_MARKER
  }
  assert.equal(existsSync(marker), false, 'the wrapper raced a branch in')
  assert.ok(!snap.repo.local.items.some((b) => b.name === 'raced'))
  assert.notEqual(snap.repo.fingerprint, await g.fingerprint(work))

  const [changed] = await waitFor(() => f.postsOf('git.changed').length && f.postsOf('git.changed'))
  assert.equal(changed.payload.fingerprint, await g.fingerprint(work))
})
