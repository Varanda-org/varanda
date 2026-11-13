// Picks the workspaces whose tests a change can reach, for a local
// `npm test -- --affected=<ref>`. CI never uses it: every pull request and
// every push to main runs every workspace.
//
// Changed files, a rename counted at both paths: when <ref> names a commit,
// `git diff --name-only --no-renames <base>` (commits since <base> plus
// staged and unstaged edits) and the untracked files git does not ignore.
// <base> is the merge base of <ref> and HEAD, so commits that reached <ref>
// after this branch left it are not counted as changes here. <ref> may also
// name a tree: the last green run, written through a throwaway index so new
// files stay untracked. The worktree is then written the same way, every
// file git does not ignore, and the two trees are compared as they are; a
// plain `git diff <tree>` would count every untracked file the tree holds.
//
// A change to the root package.json, the lockfile, scripts/ (this runner)
// or any workspace's package.json selects every workspace: those decide what
// is installed and how every test runs, and tests read every package.json.
//
// A changed workspace always runs whole. Another workspace runs when one of
// its files reaches a changed file, in a workspace or at the root (README.md,
// the workflows, deploy/). Reaching follows what each .js, .cjs, .mjs, .jsx,
// .ts, .tsx or .json file names in its string literals (comments, and
// literals with whitespace such as messages, are skipped):
//   - a relative path ('../lib/x', or the adjacent arguments '..', 'lib'),
//     from the file's directory;
//   - a path from the root into a workspace ('apps/cli/lib/x', or 'apps',
//     'cli'), or the exact path of a root file ('README.md');
//   - a path call from __dirname or from a constant set that way
//     (APP_SRC = path.join(__dirname, '../../../apps/app/src'), then
//     path.join(APP_SRC, 'thread.js')); any other use of such a constant
//     reaches its whole directory;
//   - a package name in require or import (a scoped name anywhere): the
//     package main, or the subpath named.
// A path reaches the file (trying the usual extensions and the React Native
// platform ones) or everything under the directory. A path that does not
// exist, holds a glob '*', is the root itself or a folder that only groups
// workspaces reaches nothing; a deleted file still exists for this. A bare
// workspace path ('apps/app') or a bare '..' counts only inside path.join
// or path.resolve, since elsewhere it is usually a label or a comparison. A
// package with no main file, and every workspace in the package.json
// dependencies, reach everything outside their test/. Every file reached is
// followed in turn, except the files that select every workspace anyway.
//
// The scan is a heuristic: a dependency it cannot see is caught by CI, which
// runs every workspace.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SCANNED = /\.(?:[cm]?jsx?|tsx?|json)$/
const SCAN_MAX_BYTES = 2 * 1024 * 1024
const EXTENSIONS = ['', '.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.json', '.native.js', '.web.js', '.ios.js', '.android.js']
const PATH_CALL = /\bpath\.(?:join|resolve)\s*\(\s*$/
const DECLARED_BEFORE = /\b(?:const|let|var)\s+$/
const IMPORT_BEFORE = /(?:\brequire(?:\.resolve)?\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)$/
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const LOCKFILE = 'package-lock.json'

function selectsAll (dirs, file) {
  if (file === 'package.json' || file === LOCKFILE || file.startsWith('scripts/')) return true
  return dirs.some((dir) => file === dir || file === dir + '/package.json')
}

function git (cwd, args, env) {
  const res = spawnSync('git', args, { cwd, env: env || process.env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (res.error) return { error: 'git: ' + res.error.message }
  if (res.status !== 0) {
    const first = String(res.stderr || '').trim().split('\n')[0]
    return { error: 'git ' + args[0] + ': ' + (first || 'saiu com ' + res.status) }
  }
  return { out: res.stdout }
}

function nulList (text) {
  return text.split('\0').filter(Boolean)
}

// Commit -> merge base with HEAD; tree -> itself; anything else fails, so a
// typo never selects nothing.
function resolveBase (root, ref) {
  if (ref.startsWith('-')) return { error: 'referência inválida: ' + ref }
  const commit = git(root, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'])
  if (!commit.error) {
    const base = git(root, ['merge-base', commit.out.trim(), 'HEAD'])
    if (base.error) return { error: 'sem base comum entre ' + ref + ' e HEAD' }
    return { base: base.out.trim() }
  }
  const tree = git(root, ['rev-parse', '--verify', '--quiet', ref + '^{tree}'])
  if (!tree.error) return { base: tree.out.trim(), tree: true }
  return { error: 'referência desconhecida: ' + ref }
}

// The worktree as a tree: every file git does not ignore, added through a
// copy of the index so the real one is never touched. Adding writes the new
// blobs to the object store, as `git stash` does; gc drops them once unused.
function worktreeTree (root) {
  const real = git(root, ['rev-parse', '--git-path', 'index'])
  if (real.error) return real
  const realIndex = path.resolve(root, real.out.trim())
  // Beside the real index, never in a temp dir: TMPDIR can sit inside the
  // worktree, and adding everything would then add the copy being written.
  const index = realIndex + '.affected-' + process.pid
  try {
    try { fs.copyFileSync(realIndex, index) } catch {}
    const env = { ...process.env, GIT_INDEX_FILE: index }
    const added = git(root, ['add', '-A', '--', ':/'], env)
    if (added.error) return added
    const written = git(root, ['write-tree'], env)
    if (written.error) return written
    return { tree: written.out.trim() }
  } finally {
    fs.rmSync(index, { force: true })
    fs.rmSync(index + '.lock', { force: true })
  }
}

// Paths relative to root; every list is limited to root.
function changedFiles (root, ref) {
  const prefix = git(root, ['rev-parse', '--show-prefix'])
  if (prefix.error) return { error: prefix.error }
  const strip = prefix.out.replace(/\n$/, '')
  const resolved = resolveBase(root, ref)
  if (resolved.error) return resolved
  const files = new Set()
  const add = (out) => {
    for (const file of nulList(out)) files.add(file.startsWith(strip) ? file.slice(strip.length) : file)
  }
  if (resolved.tree) {
    const now = worktreeTree(root)
    if (now.error) return now
    const diff = git(root, ['diff', '--no-color', '--name-only', '--no-renames', '-z', resolved.base, now.tree, '--', '.'])
    if (diff.error) return { error: diff.error }
    add(diff.out)
    return { files: [...files].sort() }
  }
  const diff = git(root, ['diff', '--no-color', '--name-only', '--no-renames', '-z', resolved.base, '--', '.'])
  if (diff.error) return { error: diff.error }
  add(diff.out)
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'])
  if (untracked.error) return { error: untracked.error }
  for (const file of nulList(untracked.out)) files.add(file)
  return { files: [...files].sort() }
}

function owner (dirs, file) {
  return dirs.find((dir) => file === dir || file.startsWith(dir + '/')) || null
}

// Every string literal outside comments, as { value, start, end }. A template
// literal's ${...} holes become '\0'. Regex literals are not recognised: a
// quote inside one can shift the scan, which only adds or drops a dependency.
function stringLiterals (src) {
  const found = []
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i)
      i = e === -1 ? n : e
    } else if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2)
      i = e === -1 ? n : e + 2
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      let value = ''
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') {
          value += src[j + 1] || ''
          j += 2
        } else if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
          let depth = 1
          j += 2
          while (j < n && depth > 0) {
            if (src[j] === '{') depth++
            else if (src[j] === '}') depth--
            j++
          }
          value += '\0'
        } else if (c !== '`' && src[j] === '\n') {
          break
        } else {
          value += src[j++]
        }
      }
      found.push({ value, start: i, end: j + 1 })
      i = j + 1
    } else {
      i++
    }
  }
  return found
}

// Literals with only a comma between them, joined with '/', so
// path.join(__dirname, '..', 'lib') also reads as '../lib'.
function joinedRuns (src, literals) {
  const runs = []
  let run = []
  const flush = () => { if (run.length > 1) runs.push({ value: run.map((l) => l.value).join('/'), start: run[0].start }) }
  for (const lit of literals) {
    if (run.length > 0 && !/^\s*,\s*$/.test(src.slice(run[run.length - 1].end, lit.start))) {
      flush()
      run = []
    }
    run.push(lit)
  }
  flush()
  return runs
}

function escapeRe (text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Every file under root (tracked, plus untracked not ignored), the
// directories that hold them, and each workspace's package.json.
function repoIndex (root, dirs) {
  const listed = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'])
  if (listed.error) return listed
  const files = new Set(nulList(listed.out))
  const folders = new Set()
  for (const file of files) {
    for (let d = path.posix.dirname(file); d !== '.' && !folders.has(d); d = path.posix.dirname(d)) folders.add(d)
  }
  const pkgs = new Map()
  const byName = new Map()
  for (const dir of dirs) {
    let pkg = {}
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')) } catch {}
    pkgs.set(dir, pkg)
    if (typeof pkg.name === 'string' && pkg.name) byName.set(pkg.name, dir)
  }
  return { root: path.resolve(root), dirs, files, folders, pkgs, byName }
}

// A target is { file }, { dir } (everything under it) or { dir, code: true }
// (everything under it but test/). The root itself, a folder that only
// groups workspaces (packages/, apps/) and anything outside the root reach
// nothing: root files are matched by name instead.
function resolvePath (index, p) {
  if (p === '.' || p === '..' || p.startsWith('../') || p.startsWith('/')) return []
  if (index.dirs.some((dir) => dir.startsWith(p + '/'))) return []
  const hits = EXTENSIONS.map((ext) => p + ext).filter((c) => index.files.has(c))
  if (hits.length > 0) return hits.map((file) => ({ file }))
  if (index.folders.has(p)) return [{ dir: p }]
  return []
}

function resolvePackage (index, dir, sub) {
  if (sub) {
    const hit = resolvePath(index, path.posix.join(dir, sub))
    if (hit.length > 0) return hit
  } else {
    const main = index.pkgs.get(dir).main || 'index.js'
    const hit = resolvePath(index, path.posix.join(dir, main))
    if (hit.length > 0 && hit.every((t) => t.file)) return hit
  }
  return [{ dir, code: true }]
}

// The index of the ')' that closes the '(' at open.
function callEnd (src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return i
  }
  return src.length
}

function fileTargets (index, file) {
  let src
  try {
    const abs = path.join(index.root, file)
    if (fs.statSync(abs).size > SCAN_MAX_BYTES) return []
    src = fs.readFileSync(abs, 'utf8')
  } catch {
    return []
  }
  const here = path.posix.dirname(file)
  const all = stringLiterals(src)
  const inPathCall = (pos) => {
    const before = src.slice(Math.max(0, pos - 300), pos)
    const at = Math.max(before.lastIndexOf('path.join('), before.lastIndexOf('path.resolve('))
    if (at === -1) return false
    let depth = 0
    for (const ch of before.slice(at)) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0
    return depth > 0
  }
  // The paths one string names. A string that names only a workspace
  // ('apps/app') is usually a label, and a bare '..' a comparison, so each
  // counts only as a path.join or path.resolve argument. A root file counts
  // by its exact path; a root folder only through a known base below.
  const paths = (value, inCall) => {
    const out = []
    for (const piece of value.split('\0')) {
      if (piece === '' || piece === '.' || piece === './' || /[\s*]/.test(piece)) continue
      for (const dir of index.dirs) {
        const m = new RegExp('(?:^|[^\\w.@+-])(' + escapeRe(dir) + '(?:/[\\w.@+-]+)*)').exec(piece)
        if (!m) continue
        const target = path.posix.normalize(m[1]).replace(/\/$/, '')
        if (target !== dir || inCall) out.push(...resolvePath(index, target))
      }
      const named = path.posix.normalize(piece)
      if (!owner(index.dirs, named) && index.files.has(named)) out.push({ file: named })
      if (/^\.\.?(?:\/|$)/.test(piece) && (inCall || !/^(?:\.\.\/?)+$/.test(piece))) {
        out.push(...resolvePath(index, path.posix.normalize(path.posix.join(here, piece))))
      }
    }
    return out
  }
  // The literals right after pos, with only commas and spaces between.
  const runAt = (pos) => {
    const run = []
    for (const lit of all) {
      if (lit.start < pos) continue
      if (!/^\s*,?\s*$/.test(src.slice(run.length ? run[run.length - 1].end : pos, lit.start))) break
      run.push(lit)
    }
    return run
  }
  const firstArg = (open) => /^\(\s*([A-Za-z_$][\w$]*)\s*(?=[,)])/.exec(src.slice(open))

  // Directory constants: NAME = path.join|resolve(BASE, 'lit', ...) with
  // BASE __dirname or an earlier such constant. A path call that starts
  // from one and goes on with literals reaches that path; any other use of
  // NAME reaches its whole directory.
  const targets = []
  const hidden = new Set()
  const consts = new Map()
  const baseOf = (name) => name === '__dirname' ? here : consts.get(name)
  const declCalls = new Set()
  for (const decl of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.(?:join|resolve)\s*\(/g)) {
    const open = decl.index + decl[0].length - 1
    const fa = firstArg(open)
    const base = fa ? baseOf(fa[1]) : undefined
    if (base === undefined) continue
    const run = runAt(open + fa[0].length)
    const rest = src.slice(run.length ? run[run.length - 1].end : open + fa[0].length, callEnd(src, open))
    if (!/^\s*,?\s*$/.test(rest)) continue
    consts.set(decl[1], path.posix.normalize(path.posix.join(base, ...run.map((lit) => lit.value))))
    declCalls.add(open)
  }
  for (const call of src.matchAll(/\bpath\.(?:join|resolve)\s*\(/g)) {
    const open = call.index + call[0].length - 1
    const fa = firstArg(open)
    const base = fa ? baseOf(fa[1]) : undefined
    if (base === undefined) continue
    const run = runAt(open + fa[0].length)
    for (const lit of run) hidden.add(lit)
    if (run.length > 0 && !declCalls.has(open)) targets.push(...resolvePath(index, path.posix.normalize(path.posix.join(base, ...run.map((lit) => lit.value)))))
  }
  for (const [name, dir] of consts) {
    for (const use of src.matchAll(new RegExp('(?<![\\w$.])' + escapeRe(name) + '(?![\\w$])', 'g'))) {
      const declared = DECLARED_BEFORE.test(src.slice(Math.max(0, use.index - 10), use.index))
      const joined = PATH_CALL.test(src.slice(Math.max(0, use.index - 30), use.index)) && runAt(use.index + name.length).length > 0
      if (!declared && !joined) {
        targets.push(...resolvePath(index, dir))
        break
      }
    }
  }

  const literals = all.filter((lit) => !hidden.has(lit))
  for (const lit of literals) {
    targets.push(...paths(lit.value, inPathCall(lit.start)))
    for (const [name, dir] of index.byName) {
      if (lit.value !== name && !lit.value.startsWith(name + '/')) continue
      if (!name.startsWith('@') && !IMPORT_BEFORE.test(src.slice(Math.max(0, lit.start - 40), lit.start))) continue
      targets.push(...resolvePackage(index, dir, lit.value.slice(name.length + 1)))
    }
  }
  for (const run of joinedRuns(src, literals)) targets.push(...paths(run.value, inPathCall(run.start)))
  return targets
}

// What a workspace's files reach: { files, dirs: [{ dir, code }] }.
function reachOf (index, ws, cache) {
  const files = new Set()
  const dirs = []
  const queue = []
  const addFile = (file) => {
    if (files.has(file)) return
    files.add(file)
    if (SCANNED.test(file) && !selectsAll(index.dirs, file)) queue.push(file)
  }
  const addDir = (dir, code) => {
    if (dirs.some((d) => d.dir === dir && (!code || d.code))) return
    dirs.push({ dir, code })
    for (const file of index.files) if (inDir({ dir, code }, file)) addFile(file)
  }
  addDir(ws, false)
  const pkg = index.pkgs.get(ws)
  for (const field of DEP_FIELDS) {
    for (const name of Object.keys(pkg[field] || {})) {
      const dir = index.byName.get(name)
      if (dir && dir !== ws) addDir(dir, true)
    }
  }
  while (queue.length > 0) {
    const file = queue.pop()
    if (!cache.has(file)) cache.set(file, fileTargets(index, file))
    for (const t of cache.get(file)) {
      if (t.file) addFile(t.file)
      else addDir(t.dir, Boolean(t.code))
    }
  }
  return { files, dirs }
}

function inDir ({ dir, code }, file) {
  return file.startsWith(dir + '/') && !(code && file.startsWith(dir + '/test/'))
}

function reaches (reach, file) {
  return reach.files.has(file) || reach.dirs.some((d) => inDir(d, file))
}

// -> { all: file } when every workspace must run, { affected: Set } (maybe
// empty), { unchanged: true } when nothing changed, or { error }.
function affectedWorkspaces (root, dirs, ref) {
  const changed = changedFiles(root, ref)
  if (changed.error) return changed
  if (changed.files.length === 0) return { unchanged: true }
  const touched = new Set()
  for (const file of changed.files) {
    if (selectsAll(dirs, file)) return { all: file }
    const dir = owner(dirs, file)
    if (dir) touched.add(dir)
  }
  const index = repoIndex(root, dirs)
  if (index.error) return index
  // A deleted file is still a path a reference can name.
  for (const file of changed.files) {
    index.files.add(file)
    for (let d = path.posix.dirname(file); d !== '.'; d = path.posix.dirname(d)) index.folders.add(d)
  }
  const cache = new Map()
  const affected = new Set(touched)
  for (const ws of dirs) {
    if (affected.has(ws)) continue
    const reach = reachOf(index, ws, cache)
    if (changed.files.some((file) => reaches(reach, file))) affected.add(ws)
  }
  return { affected }
}

module.exports = { affectedWorkspaces, repoIndex, reachOf, reaches }
