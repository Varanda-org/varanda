'use strict'

// Stamps the commit and build date into process.env at Metro start, so Metro
// inlines them as EXPO_PUBLIC_* in the bundle. Never throws: a build must not
// fail because the version label could not be resolved.
const fs = require('node:fs')
const childProcess = require('node:child_process')

const COMMIT_RE = /^[0-9a-f]{40}$/
// Same literal as BUILD_DATE_RE in src/version.js, which this CommonJS script cannot import.
const BUILD_DATE_RE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/

function isoNoMs (date) {
  return date.toISOString().replace(/\.[0-9]{3}Z$/, 'Z')
}

function resolveCommit (env, repoRoot, execFileSync) {
  const explicit = env.EXPO_PUBLIC_VARANDA_COMMIT
  if (typeof explicit === 'string' && COMMIT_RE.test(explicit)) return explicit

  // EAS drops .git (.easignore), so the builder cannot ask git.
  const eas = env.EAS_BUILD_GIT_COMMIT_HASH
  if (typeof eas === 'string' && COMMIT_RE.test(eas.toLowerCase())) return eas.toLowerCase()

  // A worktree has a .git file, a checkout a directory; never walk to a parent repo.
  if (repoRoot && fs.existsSync(repoRoot + '/.git')) {
    const out = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    if (typeof out === 'string' && /^[0-9a-f]{40}\n$/.test(out)) return out.slice(0, 40)
  }
  return ''
}

function applyBuildInfo ({
  env = process.env,
  repoRoot,
  now = () => new Date(),
  execFileSync = childProcess.execFileSync
} = {}) {
  let commit = ''
  let builtAt = ''
  try {
    commit = resolveCommit(env, repoRoot, execFileSync)
  } catch (err) {
    commit = ''
  }
  try {
    const explicit = env.EXPO_PUBLIC_VARANDA_BUILD_DATE
    builtAt = typeof explicit === 'string' && BUILD_DATE_RE.test(explicit) ? explicit : isoNoMs(now())
  } catch (err) {
    builtAt = ''
  }
  try {
    env.EXPO_PUBLIC_VARANDA_COMMIT = commit
    env.EXPO_PUBLIC_VARANDA_BUILD_DATE = builtAt
    process.stderr.write('build-info: commit ' + (commit || 'desconhecido') + '\n')
  } catch (err) {}
  return { commit, builtAt }
}

module.exports = { applyBuildInfo, BUILD_DATE_RE }
