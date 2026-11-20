'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '../../..')
const WORKFLOW = path.join(repoRoot, '.github/workflows/release.yml')
const NATIVE = path.join(repoRoot, '.github/workflows/native.yml')
const PROMOTE = path.join(repoRoot, '.github/workflows/promote.yml')

// release.yml, checked with line and regex rules like deploy.test.js (no YAML
// parser available). Comment lines are dropped so prose cannot satisfy or trip
// a rule. The job pushes public images and signs them with the repository's
// OIDC identity, so the rules keep it on main, behind the variable, after the
// checks, with pinned actions, no install scripts and nothing spliced into a
// script, and keep the channel tag edge moving only forward and by digest.
const yml = fs.readFileSync(WORKFLOW, 'utf8')
const lines = yml.split('\n').filter((l) => !/^\s*#/.test(l))
const code = lines.join('\n')

function block (startRe, endRe) {
  const start = lines.findIndex((l) => startRe.test(l))
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (endRe.test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

// The steps of a job, split on the `      - ` step markers.
function steps (job) {
  const out = []
  for (const l of job.split('\n')) {
    if (/^ {6}- /.test(l)) out.push([l])
    else if (out.length) out[out.length - 1].push(l)
  }
  return out.map((s) => s.join('\n'))
}

const check = block(/^ {2}check:/, /^ {2}\S/)
const publish = block(/^ {2}publish:/, /^ {2}\S/)
const publishSteps = steps(publish)
const WORKERS = ['core-1', 'core-2', 'cli-1', 'cli-2', 'web-member-1', 'web-member-2', 'web-member-3', 'others']
const workers = Object.fromEntries(WORKERS.map((id) => [id, block(new RegExp('^ {2}' + id + ':\\s*$'), /^ {2}\S/)]))
const GUARD = "github\\.repository == 'Varanda-org\\/varanda' && github\\.ref == 'refs\\/heads\\/main' && vars\\.VARANDA_RELEASE == 'true'"
const PINS = {
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020'
}
const SEEDER = 'ghcr.io/varanda-org/varanda-seeder'
const WEB = 'ghcr.io/varanda-org/varanda-web'

test('release.yml: actions pinned to the commits deploy.yml uses', (t) => {
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1])
  t.is(uses.length, 3, 'three uses: lines (the anchored test steps and the publish checkout)')
  for (const u of uses) {
    const [name, ref] = u.split('@')
    t.ok(name in PINS, 'only checkout and setup-node: ' + name)
    t.ok(/^[0-9a-f]{40}$/.test(ref), 'pinned to a 40-hex SHA: ' + u)
    t.is(ref, PINS[name], 'expected pin for ' + name)
  }
  const checkouts = [...code.matchAll(/uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\s*\n\s+persist-credentials:\s*false/g)]
  t.is(checkouts.length, 2, 'every checkout has persist-credentials: false')

  const publishUses = [...publish.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1])
  t.alike(publishUses, ['actions/checkout@' + PINS['actions/checkout']], 'the only action in publish is the checkout')
  t.ok(/^ {10}fetch-depth:\s*0\s*$/m.test(publish), 'publish checks out the full history (seq)')
  t.absent(/cosign-installer|setup-buildx|login-action|build-push-action/.test(code), 'no installer or docker action')
})

test('release.yml: permissions, triggers and job shape', (t) => {
  const top = block(/^permissions:/, /^\S/)
  const topLines = top.split('\n').slice(1).filter((l) => l.trim() !== '').map((l) => l.trim())
  t.alike(topLines, ['contents: read'], 'top-level permissions are contents: read only')

  const jobs = block(/^jobs:/, /^\S/).split('\n').filter((l) => /^ {2}[A-Za-z0-9_-]+:/.test(l)).map((l) => l.trim().replace(/:.*$/, ''))
  t.alike(jobs.sort(), [...WORKERS, 'check', 'publish'].sort(), 'jobs are the eight legs, check and publish')
  for (const id of WORKERS) t.ok(workers[id], id + ' job found')
  t.absent(/^\s+strategy:/m.test(code), 'no matrix strategy')
  t.absent(/\bmatrix\b/.test(code), 'no matrix')
  t.absent(/<<:/.test(code), 'no YAML merge keys')
  t.absent(yml.includes(String.fromCharCode(0x2014)), 'no em dash')

  // Only publish widens the token, and only to what pushing and keyless
  // signing need.
  const publishPerms = block(/^ {4}permissions:\s*$/, /^ {4}\S/)
  t.alike(publishPerms.split('\n').slice(1).map((l) => l.trim()).filter(Boolean), ['contents: read', 'packages: write', 'id-token: write'], 'publish permissions are exactly contents: read, packages: write, id-token: write')
  t.ok(publish.includes(publishPerms), 'that permissions block belongs to publish')
  t.is((code.match(/^ +permissions:/gm) || []).length, 1, 'no other job sets permissions')
  t.is((code.match(/packages:\s*write/g) || []).length, 1, 'packages: write only once')
  t.is((code.match(/id-token:\s*write/g) || []).length, 1, 'id-token: write only once')

  t.ok(/^ {4}needs:\s*check\s*$/m.test(publish), 'publish needs check')
  t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(publish), 'publish runs-on ubuntu-24.04')
  t.ok(/^ {4}timeout-minutes:\s*60\s*$/m.test(publish), 'publish has a 60 minute timeout')
  t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(check), 'check runs-on ubuntu-24.04')
  t.absent(/\buses:/.test(check), 'check job has no uses: (no checkout)')
  t.absent(/^ {4}environment:/m.test(code), 'no environment (the edge channel needs no approval)')
  for (const id of WORKERS) {
    const w = workers[id]
    t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(w), id + ' runs-on ubuntu-24.04')
    t.ok(/^ {6}NODE:\s*'24'\s*$/m.test(w), id + ' sets NODE 24')
    t.ok(/^ {6}VARANDA_TEST_CONCURRENCY:\s*'1'\s*$/m.test(w), id + ' sets VARANDA_TEST_CONCURRENCY 1')
    t.ok(/^ {4}steps:\s*(&test-steps|\*test-steps)\s*$/m.test(w), id + ' uses the shared step list')
  }
  t.is((code.match(/&test-steps\b/g) || []).length, 1, 'one &test-steps anchor')
  t.ok(/^ {4}steps:\s*&test-steps\s*$/m.test(workers[WORKERS[0]]), 'the first leg defines the anchor')
  const wsOf = (id) => ((workers[id].match(/^ {6}WORKSPACE:\s*(\S+)\s*$/m) || [])[1])
  const skip = (workers.others.match(/^ {6}VARANDA_TEST_SKIP_WORKSPACES:\s*(\S+)\s*$/m) || [])[1] || ''
  t.absent(wsOf('others'), 'others has no WORKSPACE')
  t.alike(skip.split(',').sort(), [...new Set(WORKERS.filter((id) => id !== 'others').map(wsOf))].sort(), 'others skips exactly the other legs\' workspaces')

  const npmCi = lines.filter((l) => /npm ci\b/.test(l))
  t.is(npmCi.length, 1, 'one npm ci')
  t.ok(/^\s+- run:\s*npm ci --ignore-scripts\s*$/.test(npmCi[0]), 'npm ci has --ignore-scripts')

  const on = block(/^on:/, /^\S/)
  const triggers = (on.match(/^ {2}\S+:/gm) || []).map((s) => s.trim())
  t.alike(triggers, ['push:', 'workflow_dispatch:'], 'exactly two triggers: push and workflow_dispatch')
  t.ok(/^ {4}branches:\s*\[main\]\s*$/m.test(on), 'push on main only')

  t.ok(/^ {2}group:\s*release-\$\{\{ github\.ref \}\}\s*$/m.test(code), 'concurrency group is per ref (release-<ref>)')
  t.ok(/^ {2}cancel-in-progress:\s*false\s*$/m.test(code), 'cancel-in-progress is false')
})

test('release.yml: every job carries the repository, branch and variable guards', (t) => {
  const guard = new RegExp('^ {4}if:\\s*' + GUARD + '\\s*$', 'm')
  for (const id of WORKERS) t.ok(guard.test(workers[id]), id + ' job is guarded')
  t.ok(guard.test(publish), 'publish job is guarded')
  // The gate runs even when a leg failed, was cancelled or was skipped, and
  // fails closed: a skipped check would read as passing.
  t.ok(new RegExp('^ {4}if:\\s*always\\(\\) && ' + GUARD + '\\s*$', 'm').test(check), 'check gate runs always() under the guard')
  t.ok(/^ {4}needs:\s*\[\s*core-1,\s*core-2,\s*cli-1,\s*cli-2,\s*web-member-1,\s*web-member-2,\s*web-member-3,\s*others\s*\]\s*$/m.test(check), 'check needs exactly the eight legs')
  t.ok(/^\s+RESULTS:\s*\$\{\{ join\(needs\.\*\.result, ' '\) \}\}\s*$/m.test(check), 'check reads every leg result')
  t.ok(/^\s+\[ "\$#" -eq 8 \] \|\| exit 1\s*$/m.test(check), 'check requires exactly eight results')
  t.ok(/^\s+for r in "\$@"; do \[ "\$r" = success \] \|\| exit 1; done\s*$/m.test(check), 'check requires every result to be success')
})

test('release.yml: only GITHUB_TOKEN and VARANDA_RELEASE, only in env: or if:', (t) => {
  const secrets = new Set([...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
  const vars = new Set([...code.matchAll(/vars\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
  t.alike([...secrets], ['GITHUB_TOKEN'], 'secret names')
  t.alike([...vars], ['VARANDA_RELEASE'], 'variable names')
  t.absent(/\bsecrets:\s*inherit/.test(code), 'no secrets: inherit')
  t.absent(/toJSON\((secrets|vars)/i.test(code), 'no dump of the secrets or vars context')
  t.absent(/github\.token/.test(code), 'the token is read only as secrets.GITHUB_TOKEN')
  for (const l of lines) {
    if (!/\b(secrets|vars)\./.test(l)) continue
    const ok = /^\s+if:\s/.test(l) || /^\s+[A-Z_]+:\s*\$\{\{\s*(secrets|vars)\.[A-Za-z0-9_]+\s*\}\}\s*$/.test(l)
    t.ok(ok, 'only in env: or if: -> ' + l.trim())
  }
  t.ok(/--password-stdin/.test(publish), 'docker login reads the token on stdin')
  t.absent(/docker login[^\n]*(-p |--password[ =])/.test(code), 'the token is never a command-line argument')

  // Includes the body of run: | blocks (lines indented deeper than the key).
  let runIndent = -1
  for (const l of lines) {
    const indent = l.search(/\S/)
    if (runIndent !== -1 && indent !== -1 && indent <= runIndent) runIndent = -1
    const isRun = /^\s+(- )?run:/.test(l)
    if (isRun || runIndent !== -1) t.absent(l.includes('${' + '{'), 'no expression in run: -> ' + l.trim())
    if (isRun && /run:\s*\|\s*$/.test(l)) runIndent = indent
  }
})

test('release.yml: forbidden constructs are absent', (t) => {
  t.absent(/pull_request/.test(code), 'no pull_request or pull_request_target')
  t.absent(/workflow_run/.test(code), 'no workflow_run')
  t.absent(/self-hosted/.test(code), 'no self-hosted runner')
  t.absent(/continue-on-error/.test(code), 'no continue-on-error')
  t.absent(/set -x|set -[a-wyzA-Z]*x/.test(code), 'no shell tracing')
  // Channel tags move only in the registry, by digest; the one push is the
  // commit tag, from which the digest to sign is taken.
  t.absent(/\bdocker (image )?tag\b/.test(code), 'no local docker tag')
  const pushes = lines.filter((l) => /\bdocker (image )?push\b/.test(l))
  t.ok(pushes.length > 0, 'images are pushed')
  for (const l of pushes) t.ok(/^\s+if ! docker push "\$1:\$tag" > "\$log"; then\s*$/.test(l), 'only the commit tag is pushed: ' + l.trim())
})

// A step of publish, by its name.
function stepNamed (name) {
  return publishSteps.find((s) => s.split('\n')[0].trim() === '- name: ' + name) || ''
}

// The digest_of function of every step that defines it, in both workflows.
function digestFns (text) {
  const out = []
  const ls = text.split('\n')
  for (let i = 0; i < ls.length; i++) {
    if (!/^\s+digest_of\(\) \{\s*$/.test(ls[i])) continue
    const indent = ls[i].search(/\S/)
    const fn = []
    for (let j = i; j < ls.length; j++) {
      fn.push(ls[j].slice(indent))
      if (j > i && ls[j].search(/\S/) === indent && ls[j].trim() === '}') break
    }
    out.push(fn.join('\n'))
  }
  return out
}

test('release.yml: one way of reading a digest, shared with promote.yml', (t) => {
  const promote = fs.readFileSync(PROMOTE, 'utf8')
  const fns = [...digestFns(code), ...digestFns(promote)]
  t.ok(digestFns(code).length >= 3 && digestFns(promote).length >= 3, 'both workflows define digest_of where they read digests')
  for (const f of fns) t.is(f, fns[0], 'every digest_of is the same function')
  const fn = fns[0] || ''
  t.ok(fn.includes('docker buildx imagetools inspect --format \'{{json .Manifest}}\' "$1" 2> "$err"'), 'reads the manifest descriptor from the registry')
  t.ok(fn.includes('jq -er .digest'), 'takes its digest field')
  t.ok(fn.includes('if ! [[ "$d" =~ ^sha256:[0-9a-f]{64}$ ]]; then'), 'a digest must be sha256:<64 hex>')
  t.ok(fn.includes('elif grep -Fxq -- "ERROR: $1: not found" "$err"; then\n    return 0'), 'only the registry answer for that exact reference means missing')
  t.ok(/\n {2}else\n {4}cat "\$err" >&2\n[^\n]*\n {4}return 1\n {2}fi\n\}$/.test(fn), 'any other answer fails')
  const inspects = [...code.split('\n'), ...promote.split('\n')].filter((l) => /imagetools inspect/.test(l) && !/^\s*#/.test(l))
  t.is(inspects.length, fns.length, 'no digest read outside digest_of')
})

test('release.yml: a rerun reuses sha-<commit> only when both images verify', (t) => {
  const reuse = stepNamed('Reuse a release already signed for this commit')
  t.ok(reuse, 'reuse step found')
  t.absent(/cosign sign/.test(reuse), 'the reuse step signs nothing')
  t.absent(/docker (buildx )?build\b|docker push/.test(reuse), 'the reuse step builds and pushes nothing')
  const verifySeeder = reuse.indexOf('cosign verify --certificate-identity "$COSIGN_IDENTITY" --certificate-oidc-issuer "$COSIGN_ISSUER" "$SEEDER_REPO@$seeder" > /dev/null || return 1')
  const run = reuse.indexOf('docker run --rm --network none --entrypoint cat "$SEEDER_REPO@$seeder" /app/release.json')
  const commit = reuse.indexOf('[ "$' + '{BASH_REMATCH[1]}" = "$GITHUB_SHA" ] || return 1')
  const seq = reuse.indexOf('[ "$' + '{BASH_REMATCH[2]}" = "$SEQ" ] || return 1')
  const web = reuse.indexOf('web="$' + '{BASH_REMATCH[3]}"')
  const verifyWeb = reuse.indexOf('cosign verify --certificate-identity "$COSIGN_IDENTITY" --certificate-oidc-issuer "$COSIGN_ISSUER" "$WEB_REPO@$web" > /dev/null || return 1')
  const print = reuse.indexOf('printf \'%s %s %s\\n\' "$seeder" "$web" "$caddy"')
  t.ok(verifySeeder !== -1 && run !== -1 && commit !== -1 && seq !== -1 && web !== -1 && verifyWeb !== -1 && print !== -1, 'seeder verify, release.json, commit, seq, web verify and result present')
  t.ok(verifySeeder < run, 'the seeder is verified before it is ever run')
  t.ok(run < commit && commit < seq && seq < web && web < verifyWeb && verifyWeb < print, 'a release counts only after every check')
  t.ok(reuse.includes('seeder="$(digest_of "$SEEDER_REPO:$tag")" || return 2\n            [ -n "$seeder" ] || return 1'), 'a missing seeder is not reused; a registry error is told apart')
  t.ok(reuse.includes('found_web="$(digest_of "$WEB_REPO@$web")" || return 2\n            [ "$found_web" = "$web" ] || return 1'), 'the web digest of release.json must exist; a registry error is told apart')
  const matchRe = reuse.indexOf("re='^\\{\"v\":1,\"commit\":\"([0-9a-f]{40})\",\"seq\":([1-9][0-9]{0,9}),\"web\":\"ghcr\\.io/varanda-org/varanda-web@(sha256:[0-9a-f]{64})\"\\}$'")
  const match = reuse.indexOf('[[ "$release" =~ $re ]] || return 1')
  t.ok(matchRe !== -1 && matchRe < run, 'the reuse step holds the same anchored release.json regex')
  t.ok(match !== -1 && run < match && match < commit, 'release.json is matched whole before its fields are compared')
  t.ok(/^ {10}rc=0\n {10}found="\$\(signed_release\)" \|\| rc=\$\?\n {10}if \[ "\$rc" -eq 2 \]; then\n {12}echo "::error::[^"\n]*"\n {12}exit 1\n {10}elif \[ "\$rc" -eq 0 \]; then\n {12}read -r seeder web caddy <<< "\$found"\n/m.test(reuse), 'a registry error fails the step; reused only when signed_release succeeds')
  t.ok(/\n {14}echo "RELEASE_SOURCE=reused"\n {14}echo "VERIFIED_SEEDER_DIGEST=\$seeder"\n {14}echo "VERIFIED_WEB_DIGEST=\$web"\n/.test(reuse), 'the reused digests are the verified ones')
  t.ok(/\n {10}else\n[^\n]*\n {12}echo "RELEASE_SOURCE=build" >> "\$GITHUB_ENV"\n/.test(reuse), 'anything else builds')
  t.is((code.match(/RELEASE_SOURCE=reused/g) || []).length, 1, 'only the reuse step marks a release reused')

  // The build and sign steps stop on a reused release and refuse an unknown state.
  for (const name of ['Build and push both images', 'Sign and verify the pushed digests']) {
    const s = stepNamed(name)
    t.ok(/^ {10}set -Eeuo pipefail\n {10}case "\$RELEASE_SOURCE" in\n {12}reused\) echo "[^"\n]*"; exit 0 ;;\n {12}build\) ;;\n {12}\*\) echo "::error::[^"\n]*"; exit 1 ;;\n {10}esac\n/m.test(s), name + ': skipped on reuse, fails on an unknown state')
  }
})

test('release.yml: image names, build flags and the digests from the push', (t) => {
  t.ok(new RegExp('^ {6}SEEDER_REPO:\\s*' + SEEDER.replace(/\./g, '\\.') + '\\s*$', 'm').test(publish), 'seeder image name')
  t.ok(new RegExp('^ {6}WEB_REPO:\\s*' + WEB.replace(/\./g, '\\.') + '\\s*$', 'm').test(publish), 'web image name')
  t.absent(/ghcr\.io\/[^\s"'@:]*[A-Z]/.test(code), 'image names are lower case')

  const validate = publishSteps.find((s) => /deploy\/seeder\/cosign\.ref/.test(s)) || ''
  t.ok(/\[\[ "\$GITHUB_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/.test(validate), 'GITHUB_SHA is validated as 40 hex')
  t.ok(/git rev-list --count --first-parent HEAD/.test(validate), 'seq is the first-parent count')
  t.ok(validate.includes('[[ "$seq" =~ ^[1-9][0-9]{0,9}$ ]]'), 'seq is 1 to 10 digits with no leading zero, as servers accept')
  t.ok(validate.includes("re='^ghcr\\.io/sigstore/cosign/cosign:v[0-9]+\\.[0-9]+\\.[0-9]+@sha256:[0-9a-f]{64}$'"), 'cosign.ref must be the pinned cosign image')

  const builds = lines.filter((l) => /docker (buildx )?build\b/.test(l))
  t.is(builds.length, 3, 'three image builds: web, seeder and, when needed, Caddy')
  const build = stepNamed('Build and push both images')
  t.ok(build, 'build step found')
  const all = build.split(/(?=docker build )/).slice(1)
  t.is(all.length, 3, 'three build commands')
  // The release images carry the commit; the Caddy image is shared by many.
  const cmds = all.filter((c) => !c.includes('Dockerfile.caddy')).map((c) => c.split(/ \.\n/)[0])
  t.is(cmds.length, 2, 'two release build commands')
  for (const c of cmds) {
    for (const f of ['--platform linux/amd64', '--provenance=false', '--sbom=false', '--build-arg VARANDA_COMMIT="$GITHUB_SHA"', '--label org.opencontainers.image.revision="$GITHUB_SHA"']) {
      t.ok(c.includes(f), 'build has ' + f)
    }
  }
  // Both images are always built together, at the top level of the step.
  t.is(build.split('\n').filter((l) => /^ {10}docker build /.test(l)).length, 2, 'both builds are unconditional')
  t.absent(/digest_of "\$WEB_REPO:\$tag"/.test(code), 'an existing web tag is never reused')
  t.ok(/-f deploy\/seeder\/Dockerfile\.web -t "\$WEB_REPO:\$tag" \.\n {10}web="\$\(push_digest "\$WEB_REPO"\)"\n/.test(build), 'web image built from Dockerfile.web, pushed, digest from its push')
  t.ok(/-f deploy\/seeder\/Dockerfile -t "\$SEEDER_REPO:\$tag" \.\n {10}seeder="\$\(push_digest "\$SEEDER_REPO"\)"\n/.test(build), 'seeder image built from Dockerfile, pushed, digest from its push')
  t.ok(/tag="sha-\$GITHUB_SHA"/.test(build), 'the commit tag is sha-<commit>')
  t.ok(build.includes('--build-arg VARANDA_SEQ="$SEQ"'), 'seeder gets the seq')
  t.ok(build.includes('--build-arg VARANDA_WEB_IMAGE="$WEB_REPO@$web"'), 'seeder gets the web image by its pushed digest')
  t.ok(build.indexOf('web="$(push_digest "$WEB_REPO")"') < build.indexOf('--build-arg VARANDA_WEB_IMAGE'), 'web pushed before the seeder build')
  t.alike(build.split('\n').filter((l) => /^\s+(web|seeder)=/.test(l)).map((l) => l.trim()), ['web="$(push_digest "$WEB_REPO")"', 'seeder="$(push_digest "$SEEDER_REPO")"'], 'the digests come only from the pushes')

  // push_digest: the digest printed by this push, then found by digest.
  t.ok(build.includes('if ! docker push "$1:$tag" > "$log"; then'), 'push output kept')
  t.ok(build.includes('d="$(sed -nE "s/^$tag: digest: (sha256:[0-9a-f]{64}) size: [0-9]+\\$/\\\\1/p" "$log")"'), 'digest parsed from the push output line')
  t.ok(/if ! \[\[ "\$d" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]; then\n[^\n]*\n\s+return 1/.test(build), 'one sha256:<64 hex> digest or fail')
  t.ok(/if \[ "\$\(digest_of "\$1@\$d"\)" != "\$d" \]; then\n[^\n]*\n\s+return 1/.test(build), 'the pushed digest is found in the registry by digest')
  t.absent(/digest_of "\$(WEB|SEEDER)_REPO:\$tag"\)" *$/m.test(build), 'no digest read back by tag in the build step')

  t.ok(build.includes('release="$(docker run --rm --network none --entrypoint cat "$SEEDER_REPO@$seeder" /app/release.json)"'), 'release.json read offline from the pushed seeder digest')
  t.ok(build.includes("re='^\\{\"v\":1,\"commit\":\"([0-9a-f]{40})\",\"seq\":([1-9][0-9]{0,9}),\"web\":\"ghcr\\.io/varanda-org/varanda-web@(sha256:[0-9a-f]{64})\"\\}$'"), 'release.json matched whole by one anchored regex')
  t.ok(/\[ "\$\{BASH_REMATCH\[1\]\}" != "\$GITHUB_SHA" \]/.test(build) && /\[ "\$\{BASH_REMATCH\[2\]\}" != "\$SEQ" \]/.test(build), 'release.json names this commit and seq')
  t.ok(/\|\| \[ "\$\{BASH_REMATCH\[3\]\}" != "\$web" \]; then\n[^\n]*\n\s+exit 1/.test(build), 'release.json names the pushed web digest')
  t.ok(/\n {10}\{\n {12}echo "WEB_DIGEST=\$web"\n {12}echo "SEEDER_DIGEST=\$seeder"\n {12}echo "CADDY_DIGEST=\$caddy"\n {10}\} >> "\$GITHUB_ENV"/.test(build), 'the pushed digests are handed to signing')
  t.is((code.match(/echo "(WEB|SEEDER)_DIGEST=/g) || []).length, 2, 'only the build step sets the digests to sign')
})

test('release.yml: cosign keyless, only as the pinned container, verified', (t) => {
  t.ok(/^ {6}COSIGN_ISSUER:\s*https:\/\/token\.actions\.githubusercontent\.com\s*$/m.test(publish), 'issuer')
  t.ok(/^ {6}COSIGN_IDENTITY:\s*https:\/\/github\.com\/Varanda-org\/varanda\/\.github\/workflows\/release\.yml@refs\/heads\/main\s*$/m.test(publish), 'edge identity')
  const sign = stepNamed('Sign and verify the pushed digests')
  t.ok(sign, 'sign step found')
  t.is(publishSteps.filter((s) => /cosign sign/.test(s)).length, 1, 'one step signs')
  const cosignLines = lines.filter((l) => /\bcosign\b/.test(l) && !/^\s+- name:|sigstore\/cosign|cosign\.ref|COSIGN_|cosign\(\)|cosign_ref/.test(l))
  for (const l of cosignLines) t.ok(/^\s+cosign (sign|verify) /.test(l), 'cosign only through the container function: ' + l.trim())
  t.ok(/-e ACTIONS_ID_TOKEN_REQUEST_URL -e ACTIONS_ID_TOKEN_REQUEST_TOKEN /.test(sign), 'OIDC request variables passed by name only, to the signing container')
  for (const name of ['Reuse a release already signed for this commit', 'Move edge if this release is newer']) {
    t.ok(stepNamed(name), 'step found: ' + name)
    t.absent(/ACTIONS_ID_TOKEN_REQUEST/.test(stepNamed(name)), 'the verify-only container gets no OIDC token: ' + name)
  }
  for (const s of [sign, stepNamed('Reuse a release already signed for this commit'), stepNamed('Move edge if this release is newer')]) {
    t.ok(/docker run --rm --user "\$\(id -u\):\$\(id -g\)"/.test(s), 'cosign runs as a container')
    t.ok(/^\s+"\$COSIGN_IMAGE" "\$@"\s*$/m.test(s), 'the container is the image named in cosign.ref')
    t.ok(/-e COSIGN_YES=true/.test(s), 'COSIGN_YES=true')
    t.ok(/-e DOCKER_CONFIG=\/docker-config/.test(s) && /-v "\$DOCKER_CONFIG:\/docker-config:ro"/.test(s), 'docker config mounted read-only')
  }
  t.ok(sign.includes('for ref in "$WEB_REPO@$WEB_DIGEST" "$SEEDER_REPO@$SEEDER_DIGEST"; do'), 'the two pushed digests are signed')
  t.ok(/^ {12}cosign sign "\$ref"\n {12}cosign verify --certificate-identity "\$COSIGN_IDENTITY" --certificate-oidc-issuer "\$COSIGN_ISSUER" "\$ref" > \/dev\/null\n {10}done$/m.test(sign), 'each is verified right after signing, with the exact identity and issuer')
  // A verify that cannot fail the job would let an unsigned digest through.
  const verifies = lines.filter((l) => /cosign verify/.test(l))
  t.is(verifies.length, 7, 'seven verifies: seeder, web and Caddy of a reused release, a reused Caddy tag, a built Caddy, the post-sign loop and the current edge')
  for (const l of verifies) {
    t.ok(/--certificate-identity "\$COSIGN_IDENTITY" --certificate-oidc-issuer "\$COSIGN_ISSUER" "[^"]+" > \/dev\/null( \|\| return 1)?$/.test(l), 'verify pins identity and issuer and can fail: ' + l.trim())
    t.absent(/\|\|\s*(true|:)\b|;\s*true\b/.test(l), 'verify failure is never ignored: ' + l.trim())
  }
  t.absent(/certificate-identity-regexp|insecure-ignore/.test(code), 'no loose verification')
  t.ok(sign.indexOf('echo "VERIFIED_WEB_DIGEST') > sign.indexOf('cosign verify'), 'verified digests recorded only after verification')
  t.ok(sign.includes('echo "VERIFIED_WEB_DIGEST=$WEB_DIGEST"') && sign.includes('echo "VERIFIED_SEEDER_DIGEST=$SEEDER_DIGEST"'), 'the verified digests are the signed ones')
  t.is((code.match(/echo "VERIFIED_(WEB|SEEDER)_DIGEST=/g) || []).length, 4, 'only the reuse and sign steps record verified digests')
})

test('release.yml: the Caddy image is built only for a new Dockerfile.caddy and pinned in caddy.json', (t) => {
  t.ok(/^ {6}CADDY_REPO:\s*ghcr\.io\/varanda-org\/varanda-caddy\s*$/m.test(publish), 'Caddy image name')
  const validate = publishSteps.find((s) => /deploy\/seeder\/cosign\.ref/.test(s)) || ''
  t.ok(validate.includes('caddy_hash="$(sha256sum deploy/seeder/Dockerfile.caddy)"') && validate.includes('echo "CADDY_TAG=caddy-$caddy_hash"'), 'the Caddy tag is the Dockerfile.caddy hash')
  const reuse = stepNamed('Reuse a release already signed for this commit')
  const readCaddy = reuse.indexOf('caddy_json="$(docker run --rm --network none --entrypoint cat "$SEEDER_REPO@$seeder" /app/caddy.json)" || return 1')
  const verifyCaddy = reuse.indexOf('cosign verify --certificate-identity "$COSIGN_IDENTITY" --certificate-oidc-issuer "$COSIGN_ISSUER" "$CADDY_REPO@$caddy" > /dev/null || return 1')
  const print = reuse.indexOf('printf \'%s %s %s\\n\' "$seeder" "$web" "$caddy"')
  t.ok(readCaddy !== -1 && verifyCaddy > readCaddy && print > verifyCaddy, 'a reused release reuses only a verified caddy.json digest')
  t.ok(reuse.includes('found_caddy="$(digest_of "$CADDY_REPO@$caddy")" || return 2\n            [ "$found_caddy" = "$caddy" ] || return 1'), 'the caddy.json digest must exist')
  const tagged = reuse.indexOf('caddy="$(digest_of "$CADDY_REPO:$CADDY_TAG")" || return 2')
  const labelCheck = reuse.indexOf('[ "caddy-$label" = "$CADDY_TAG" ] || return 1')
  t.ok(tagged !== -1 && labelCheck > reuse.indexOf('"$CADDY_REPO@$caddy" > /dev/null || return 1', tagged), 'a Caddy tag is reused only after verify and a matching Dockerfile hash label')
  t.ok(/\n {16}echo "CADDY_SOURCE=reused"\n {16}echo "VERIFIED_CADDY_DIGEST=\$caddy"\n/.test(reuse) && /\n {14}echo "CADDY_SOURCE=build" >> "\$GITHUB_ENV"\n/.test(reuse), 'reused when verified, built otherwise')

  const build = stepNamed('Build and push both images')
  t.ok(/^ {14}docker build --platform linux\/amd64 --provenance=false --sbom=false \\\n {16}--label org\.varanda\.dockerfile-caddy="\$\{CADDY_TAG#caddy-\}" \\\n {16}-f deploy\/seeder\/Dockerfile\.caddy -t "\$CADDY_REPO:\$CADDY_TAG" deploy\/seeder\n {14}caddy="\$\(tag="\$CADDY_TAG" push_digest "\$CADDY_REPO"\)"\n/m.test(build), 'Caddy built only in the build branch, labelled, pushed as caddy-<hash>, digest from its push')
  t.ok(build.includes('reused) caddy="$VERIFIED_CADDY_DIGEST" ;;'), 'a reused Caddy keeps its verified digest')
  t.ok(build.includes('--build-arg VARANDA_CADDY_IMAGE="$CADDY_REPO@$caddy"'), 'the seeder pins the Caddy image by digest')
  t.ok(build.indexOf('--build-arg VARANDA_CADDY_IMAGE') > build.indexOf('caddy="$(tag='), 'Caddy pushed before the seeder build')
  t.ok(build.includes('if [ "$caddy_json" != "{\\"v\\":1,\\"caddy\\":\\"$CADDY_REPO@$caddy\\"}" ]; then'), 'caddy.json read back and compared')

  const sign = stepNamed('Sign and verify the pushed digests')
  t.ok(/^ {10}if \[ "\$CADDY_SOURCE" = build \]; then\n {12}cosign sign "\$CADDY_REPO@\$CADDY_DIGEST"\n {12}cosign verify [^\n]*"\$CADDY_REPO@\$CADDY_DIGEST" > \/dev\/null\n {12}echo "VERIFIED_CADDY_DIGEST=\$CADDY_DIGEST" >> "\$GITHUB_ENV"\n {10}fi\n/m.test(sign), 'only a Caddy image this run pushed is signed, then verified')
  t.absent(/CADDY_REPO:edge|CADDY_REPO" "\$VERIFIED_CADDY/.test(code), 'no channel tag for the Caddy image')
  const summary = publishSteps.find((s) => /GITHUB_STEP_SUMMARY/.test(s)) || ''
  t.ok(summary.includes('$CADDY_REPO@$VERIFIED_CADDY_DIGEST'), 'summary names the Caddy digest')
})

test('Dockerfile: caddy.json is written only with a Caddy image, in its own RUN', { skip: process.platform === 'win32' }, (t) => {
  const df = fs.readFileSync(path.join(repoRoot, 'deploy/seeder/Dockerfile'), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
  let i = df.indexOf('ARG VARANDA_CADDY_IMAGE=""')
  t.ok(i !== -1, 'ARG VARANDA_CADDY_IMAGE with an empty default')
  while (i !== -1 && i < df.length && !/^RUN\s/.test(df[i])) i++
  const out = []
  for (; i !== -1 && i < df.length; i++) {
    out.push(df[i].replace(/\\$/, ''))
    if (!/\\$/.test(df[i])) break
  }
  t.ok(i < df.findIndex((l) => /^USER\s+node/.test(l)), 'before USER node')
  const script = out.join('\n').replace(/^RUN\s+/, '')
  const run = (env) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-caddy-'))
    const file = path.join(dir, 'caddy.json')
    const r = spawnSync('sh', ['-c', script.split('/app/caddy.json').join(file)], {
      env: { PATH: process.env.PATH, VARANDA_COMMIT: '', VARANDA_CADDY_IMAGE: '', ...env }, encoding: 'utf8'
    })
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    fs.rmSync(dir, { recursive: true, force: true })
    return { status: r.status, content }
  }
  const ref = 'ghcr.io/varanda-org/varanda-caddy@sha256:' + 'c'.repeat(64)
  const commit = 'a'.repeat(40)
  t.alike(run({}), { status: 0, content: null }, 'no argument, no file')
  t.alike(run({ VARANDA_COMMIT: commit, VARANDA_CADDY_IMAGE: ref }), { status: 0, content: '{"v":1,"caddy":"' + ref + '"}\n' }, 'the exact line update.sh accepts')
  t.is(run({ VARANDA_CADDY_IMAGE: ref }).status, 1, 'a Caddy image without a commit is refused')
  for (const bad of ['ghcr.io/varanda-org/varanda-web@sha256:' + 'c'.repeat(64), ref + 'c', ref.slice(0, -1), ref.toUpperCase(), 'varanda-caddy:local']) {
    t.alike(run({ VARANDA_COMMIT: commit, VARANDA_CADDY_IMAGE: bad }), { status: 1, content: null }, 'refused: ' + bad)
  }
})

test('release.yml: edge moves only forward, by digest, read back', (t) => {
  const creates = lines.filter((l) => /imagetools create/.test(l))
  t.ok(creates.length > 0, 'edge is moved with imagetools create')
  for (const l of creates) {
    t.ok(/^\s+docker buildx imagetools create --prefer-index=false -t "\$1:edge" "\$1@\$2"\s*$/.test(l), 'by digest with --prefer-index=false: ' + l.trim())
  }
  const edgeSteps = publishSteps.filter((s) => /imagetools create/.test(s))
  t.is(edgeSteps.length, 1, 'one step moves edge')
  const edge = edgeSteps[0] || ''
  t.absent(/:stable/.test(code), 'release.yml never touches stable')

  const fetch = edge.indexOf('git fetch --no-tags --quiet origin +refs/heads/main:refs/remotes/origin/main')
  const onMain = edge.indexOf('if ! git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main; then')
  const first = edge.indexOf('imagetools create')
  t.ok(fetch !== -1 && onMain !== -1, 'fresh fetch and the check that this commit is on main present')
  t.ok(fetch < onMain && onMain < first, 'the main check comes before any move')
  t.ok(/if ! git merge-base --is-ancestor "\$GITHUB_SHA" refs\/remotes\/origin\/main; then\n(\s+echo[^\n]*\n){2}\s+exit 0\n/.test(edge), 'not on main: a notice and a green exit, nothing moved')
  t.absent(/\$tip\b|rev-parse/.test(edge), 'no tip comparison: a run that ends after the next push still moves edge')

  // The current edge counts only verified, and only its release.json says how new it is.
  const verifyEdge = edge.indexOf('cosign verify --certificate-identity "$COSIGN_IDENTITY" --certificate-oidc-issuer "$COSIGN_ISSUER" "$SEEDER_REPO@$1" > /dev/null || return 1')
  const runEdge = edge.indexOf('release="$(docker run --rm --network none --entrypoint cat "$SEEDER_REPO@$1" /app/release.json)" || return 1')
  t.ok(verifyEdge !== -1 && runEdge !== -1 && verifyEdge < runEdge, 'the current edge is verified before it is ever run')
  t.ok(edge.includes("re='^\\{\"v\":1,\"commit\":\"([0-9a-f]{40})\",\"seq\":([1-9][0-9]{0,9}),\"web\":\"ghcr\\.io/varanda-org/varanda-web@(sha256:[0-9a-f]{64})\"\\}$'"), 'the same release.json format as the reuse step')
  t.ok(edge.includes('[[ "$release" =~ $re ]] || return 1'), 'a release.json out of format does not count')
  const readEdge = edge.indexOf('if ! found="$(edge_release "$seeder_prev")"; then')
  t.ok(readEdge !== -1 && edge.indexOf('seeder_prev="$(digest_of "$SEEDER_REPO:edge")"') < readEdge && readEdge < edge.indexOf('if ! move'), 'the current edge is read before any move')
  t.ok(/if ! found="\$\(edge_release "\$seeder_prev"\)"; then\n\s+echo "::error::[^\n]*\n\s+exit 1\n/.test(edge), 'an edge that does not verify or read fails the step, nothing moved')
  t.ok(/if \[ "\$edge_seq" -ge "\$SEQ" \] \|\| ! git merge-base --is-ancestor "\$edge_commit" "\$GITHUB_SHA"; then\n(\s+echo[^\n]*\n){2}\s+exit 0\n/.test(edge), 'an edge as new or newer, or off this history: a notice and a green exit, nothing moved')

  t.ok(/for d in "\$\{VERIFIED_WEB_DIGEST:-\}" "\$\{VERIFIED_SEEDER_DIGEST:-\}" "\$\{VERIFIED_CADDY_DIGEST:-\}"; do\n\s+if ! \[\[ "\$d" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]; then\n[^\n]*\n\s+exit 1/.test(edge), 'every verified digest must be present, the Caddy one too')
  t.ok(/^ {10}if ! move "\$WEB_REPO" "\$VERIFIED_WEB_DIGEST"; then\n {12}restore "\$WEB_REPO" "\$web_prev"\n {12}exit 1\n/m.test(edge), 'web moves to its verified digest; a failure restores it and fails')
  t.ok(/^ {10}if ! move "\$SEEDER_REPO" "\$VERIFIED_SEEDER_DIGEST"; then\n {12}restore "\$SEEDER_REPO" "\$seeder_prev"\n {12}restore "\$WEB_REPO" "\$web_prev"\n {12}exit 1\n/m.test(edge), 'seeder moves last; a failure restores both and fails')
  t.ok(edge.indexOf('web_prev="$(digest_of "$WEB_REPO:edge")"') < edge.indexOf('if ! move') && edge.indexOf('seeder_prev="$(digest_of "$SEEDER_REPO:edge")"') < edge.indexOf('if ! move'), 'the previous edge digests are read first')
  t.ok(/src="\$\(digest_of "\$1@\$2"\)" \|\| return 1\n\s+if \[ "\$src" != "\$2" \]; then\n[^\n]*\n\s+return 1/.test(edge), 'the source digest is checked before tagging')
  t.ok(/if ! retag "\$1" "\$2"; then\n[^\n]*\n\s+return 1/.test(edge), 'a failed retag fails the move')
  t.ok(edge.indexOf('got="$(digest_of "$1:edge")"') > first, 'edge read back after the move')
  t.ok(/got="\$\(digest_of "\$1:edge"\)" \|\| got=""\n\s+if \[ "\$got" != "\$2" \]; then\n[^\n]*\n\s+return 1/.test(edge), 'the read-back must equal the verified digest')
  t.ok(/retag "\$1" "\$2" \|\| echo "::error::[^"\n]*"/.test(edge), 'a failed restore is reported')
  t.ok(/if \[ -n "\$2" \]; then\n[^\n]*\n\s+else\n\s+echo "::error::[^"\n]*"\n\s+fi/.test(edge), 'a missing previous digest is reported')
  t.ok(edge.indexOf('echo "EDGE_STATUS=movido"') > edge.lastIndexOf('if ! move'), 'moved is recorded only after both moves')
})

// The edge step itself, run with real bash and jq against a fake docker (the
// registry, cosign and release.json) and a fake git (main's first-parent line).
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FAKE_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n')
const save = () => fs.writeFileSync(file, JSON.stringify(state))
const resolve = (ref) => ref.includes('@') ? (state.digests.includes(ref) ? ref.slice(ref.indexOf('@') + 1) : null) : (state.tags[ref] || null)
if (args[0] === 'buildx' && args[2] === 'inspect') {
  const ref = args[args.length - 1]
  if (state.inspectFail.includes(ref)) { process.stderr.write('ERROR: registry unavailable\\n'); process.exit(1) }
  const d = resolve(ref)
  if (!d) { process.stderr.write('ERROR: ' + ref + ': not found\\n'); process.exit(1) }
  process.stdout.write(JSON.stringify({ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: d, size: 1 }) + '\\n')
} else if (args[0] === 'buildx' && args[2] === 'create') {
  const tag = args[args.indexOf('-t') + 1]
  if (state.createFailOnce.includes(tag)) {
    state.createFailOnce = state.createFailOnce.filter((x) => x !== tag)
    save()
    process.exit(1)
  }
  const src = args[args.length - 1]
  state.tags[tag] = src.slice(src.indexOf('@') + 1)
  save()
} else if (args[0] === 'run' && args.includes('verify')) {
  const identity = args[args.indexOf('--certificate-identity') + 1]
  process.exit(state.signed[args[args.length - 1]] === identity ? 0 : 1)
} else if (args[0] === 'run' && args.includes('--entrypoint')) {
  const body = state.releases[args[args.length - 2]]
  if (body === undefined) process.exit(1)
  process.stdout.write(body + '\\n')
} else {
  process.stderr.write('fake docker: unexpected ' + args.join(' ') + '\\n')
  process.exit(2)
}
`

const FAKE_GIT = `#!/usr/bin/env node
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'))
const args = process.argv.slice(2)
if (args[0] === 'fetch') process.exit(0)
if (args[0] === 'rev-parse' && args[args.length - 1] === 'refs/remotes/origin/main^{commit}') {
  process.stdout.write(state.main[state.main.length - 1] + '\\n')
  process.exit(0)
}
if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
  const at = (r) => r === 'refs/remotes/origin/main' ? state.main.length - 1 : state.main.indexOf(r)
  const a = at(args[2])
  const b = at(args[3])
  if (a === -1 || b === -1) { process.stderr.write('fatal: Not a valid commit name\\n'); process.exit(128) }
  process.exit(a <= b ? 0 : 1)
}
process.stderr.write('fake git: unexpected ' + args.join(' ') + '\\n')
process.exit(2)
`

function edgeScript () {
  const step = stepNamed('Move edge if this release is newer').split('\n')
  const start = step.findIndex((l) => /^ {8}run: \|\s*$/.test(l))
  if (start === -1) return ''
  return step.slice(start + 1).map((l) => l.slice(10)).join('\n') + '\n'
}

test('release.yml: the edge step moves edge forward only, also when main moved on', (t) => {
  for (const bin of ['bash', 'jq']) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' })
    if (probe.error || probe.status !== 0) {
      t.comment(bin + ' not found: skipping the behavioural check')
      return
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-release-edge-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'git'), FAKE_GIT, { mode: 0o755 })
  const file = path.join(dir, 'edge.sh')
  const body = edgeScript()
  t.ok(body.includes('edge_release'), 'step script extracted')
  fs.writeFileSync(file, body)

  const IDENTITY = 'https://github.com/Varanda-org/varanda/.github/workflows/release.yml@refs/heads/main'
  const commit = (n) => n.toString(16).padStart(40, 'c')
  const digest = (kind, n) => 'sha256:' + (kind === 'web' ? 'e' : 'd') + n.toString(16).padStart(63, '0')
  const main = [1, 2, 3, 4, 5, 6, 7, 8].map(commit)
  // A published release n: both images signed by release.yml, release.json naming commit n and seq n.
  const published = (n) => ({
    digests: [SEEDER + '@' + digest('seeder', n), WEB + '@' + digest('web', n)],
    signed: { [SEEDER + '@' + digest('seeder', n)]: IDENTITY, [WEB + '@' + digest('web', n)]: IDENTITY },
    releases: { [SEEDER + '@' + digest('seeder', n)]: '{"v":1,"commit":"' + commit(n) + '","seq":' + n + ',"web":"' + WEB + '@' + digest('web', n) + '"}' }
  })
  const registry = (ns, edge, extra = {}) => {
    const s = { main, tags: {}, digests: [], signed: {}, releases: {}, inspectFail: [], createFailOnce: [] }
    for (const n of ns) {
      const p = published(n)
      s.digests.push(...p.digests)
      Object.assign(s.signed, p.signed)
      Object.assign(s.releases, p.releases)
    }
    if (edge) {
      s.tags[SEEDER + ':edge'] = digest('seeder', edge)
      s.tags[WEB + ':edge'] = digest('web', edge)
    }
    return Object.assign(s, extra)
  }

  const run = (n, state) => {
    const paths = { state: path.join(dir, 'state.json'), log: path.join(dir, 'docker.log'), env: path.join(dir, 'github.env') }
    fs.writeFileSync(paths.state, JSON.stringify(state))
    for (const p of [paths.log, paths.env]) fs.writeFileSync(p, '')
    const res = spawnSync('bash', [file], {
      encoding: 'utf8',
      env: {
        PATH: bin + path.delimiter + process.env.PATH,
        FAKE_STATE: paths.state,
        FAKE_LOG: paths.log,
        GITHUB_SHA: commit(n),
        SEQ: String(n),
        GITHUB_ENV: paths.env,
        RUNNER_TEMP: dir,
        DOCKER_CONFIG: path.join(dir, 'docker-config'),
        SEEDER_REPO: SEEDER,
        WEB_REPO: WEB,
        CADDY_REPO: 'ghcr.io/varanda-org/varanda-caddy',
        COSIGN_ISSUER: 'https://token.actions.githubusercontent.com',
        COSIGN_IDENTITY: IDENTITY,
        COSIGN_IMAGE: 'ghcr.io/sigstore/cosign/cosign:v2.0.0@sha256:' + 'f'.repeat(64),
        VERIFIED_WEB_DIGEST: digest('web', n),
        VERIFIED_SEEDER_DIGEST: digest('seeder', n),
        VERIFIED_CADDY_DIGEST: 'sha256:' + 'a'.repeat(64)
      }
    })
    const after = JSON.parse(fs.readFileSync(paths.state, 'utf8'))
    const calls = fs.readFileSync(paths.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const status = (fs.readFileSync(paths.env, 'utf8').match(/^EDGE_STATUS=(.*)$/m) || [])[1]
    const edgeOf = (repo) => after.tags[repo + ':edge'] || null
    return { res, status, calls, seeder: edgeOf(SEEDER), web: edgeOf(WEB) }
  }
  const at = (r, n) => r.seeder === digest('seeder', n) && r.web === digest('web', n)

  // The case that left edge behind: main is at 8, this run is 6, edge is at 4.
  const busy = run(6, registry([4, 6], 4))
  t.is(busy.res.status, 0, 'a run that ends after the next push succeeds ' + busy.res.stderr)
  t.ok(at(busy, 6), 'and moves both edge tags to its release')
  t.is(busy.status, 'movido', 'and records it')

  const first = run(6, registry([6], null))
  t.is(first.res.status, 0, 'no edge yet ' + first.res.stderr)
  t.ok(at(first, 6), 'the first release becomes edge')

  const same = run(6, registry([6], 6))
  t.is(same.res.status, 0, 'a rerun of the edge commit ' + same.res.stderr)
  t.ok(at(same, 6), 'keeps edge on that release')

  const late = run(4, registry([4, 6], 6))
  t.is(late.res.status, 0, 'a late older run is green ' + late.res.stderr)
  t.ok(at(late, 6), 'but never moves edge back')
  t.is(late.status, 'não movido (edge no seq 6)', 'and says where edge stays')
  t.absent(late.calls.some((a) => a[2] === 'create'), 'nothing is retagged')

  const foreign = registry([3, 6], null)
  foreign.tags[SEEDER + ':edge'] = digest('seeder', 3)
  foreign.tags[WEB + ':edge'] = digest('web', 3)
  foreign.releases[SEEDER + '@' + digest('seeder', 3)] = '{"v":1,"commit":"' + 'b'.repeat(40) + '","seq":3,"web":"' + WEB + '@' + digest('web', 3) + '"}'
  const off = run(6, foreign)
  t.is(off.res.status, 0, 'an edge whose commit is not in this history ' + off.res.stderr)
  t.ok(off.seeder === digest('seeder', 3), 'stays where it is, for a person to look at')

  const unsigned = registry([4, 6], 4)
  delete unsigned.signed[SEEDER + '@' + digest('seeder', 4)]
  const bad = run(6, unsigned)
  t.is(bad.res.status, 1, 'an edge that does not verify fails the step')
  t.ok(/::error::/.test(bad.res.stdout), 'with an error')
  t.ok(at(bad, 4), 'and nothing moves')
  t.absent(bad.calls.some((a) => a[0] === 'run' && a.includes('--entrypoint')), 'an unverified edge is never run')

  const otherSigner = registry([4, 6], 4)
  otherSigner.signed[SEEDER + '@' + digest('seeder', 4)] = 'https://github.com/Varanda-org/varanda/.github/workflows/promote.yml@refs/heads/main'
  t.is(run(6, otherSigner).res.status, 1, 'an edge signed by another identity fails the step')

  const garbled = registry([4, 6], 4)
  garbled.releases[SEEDER + '@' + digest('seeder', 4)] = '{"v":1,"commit":"' + commit(4) + '","seq":"4"}'
  const unreadable = run(6, garbled)
  t.is(unreadable.res.status, 1, 'an edge with a release.json out of format fails the step')
  t.ok(at(unreadable, 4), 'and nothing moves')

  const outage = run(6, registry([4, 6], 4, { inspectFail: [SEEDER + ':edge'] }))
  t.not(outage.res.status, 0, 'a registry that does not answer about edge fails the step')
  t.ok(at(outage, 4), 'and nothing moves')

  const gone = registry([4, 6], 4)
  gone.main = main.filter((c) => c !== commit(6))
  const rewritten = run(6, gone)
  t.is(rewritten.res.status, 0, 'a commit no longer on main is green ' + rewritten.res.stderr)
  t.ok(at(rewritten, 4), 'and moves nothing')
  t.is(rewritten.calls.length, 0, 'without asking the registry anything')

  const flaky = run(6, registry([4, 6], 4, { createFailOnce: [SEEDER + ':edge'] }))
  t.is(flaky.res.status, 1, 'a seeder retag that fails fails the step')
  t.ok(at(flaky, 4), 'and both edge tags go back to the previous release')
})

test('release.yml: summary and credential cleanup', (t) => {
  const summary = publishSteps.find((s) => /GITHUB_STEP_SUMMARY/.test(s)) || ''
  for (const v of ['$GITHUB_SHA', '$SEQ', '$VERIFIED_WEB_DIGEST', '$VERIFIED_SEEDER_DIGEST', '$RELEASE_SOURCE']) t.ok(summary.includes(v), 'summary has ' + v)
  const last = publishSteps[publishSteps.length - 1] || ''
  t.ok(/^ {8}if:\s*always\(\)\s*$/m.test(last) && /rm -rf "\$RUNNER_TEMP\/docker-config"/.test(last), 'the registry credentials are removed even on failure')
  t.ok(/echo "DOCKER_CONFIG=\$RUNNER_TEMP\/docker-config"/.test(code), 'docker login writes only to that directory')
})

test('release.yml: the header orders the stable gate before VARANDA_PROMOTE', (t) => {
  const header = yml.split('\n').filter((l) => /^#/.test(l)).join('\n')
  const env = header.indexOf('1. Settings > Environments > New environment release-stable')
  const promote = header.indexOf('VARANDA_PROMOTE = true')
  t.ok(env !== -1 && promote !== -1 && env < promote, 'create release-stable before setting VARANDA_PROMOTE')
  t.ok(/required\n?#?\s*reviewers/.test(header) && /prevent self-review/.test(header) && /limited to main/.test(header), 'reviewers, no self-review, main only')
  t.ok(/VARANDA_RELEASE enables only this workflow/.test(header), 'VARANDA_RELEASE enables only release.yml')
})

test('native.yml: release.yml and promote.yml do not trigger native builds', (t) => {
  const native = fs.readFileSync(NATIVE, 'utf8')
  const allow = (native.match(/grep -Ezvq '([^']+)'/) || [])[1] || ''
  t.ok(allow.includes('workflows/(ci|deploy|site|release|promote)\\.yml$'), 'release and promote are on the allow-list')
})
