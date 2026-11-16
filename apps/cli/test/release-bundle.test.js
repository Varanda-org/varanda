'use strict'

// The seeder image as the signed root of a release: /app/release.json, the
// deploy bundle in /app/deploy/seeder, the image-only compose overrides and the
// cosign pin. Static checks, no Docker and no network.

const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '../../..')
const SEEDER = path.join(repoRoot, 'deploy/seeder')
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l) && l.trim() !== '')

const BUNDLE = [
  'compose.yaml', 'compose.web.yaml', 'compose.release.yaml', 'compose.release.web.yaml',
  'Caddyfile', 'update.sh', 'update.conf.example', 'well-known.sh',
  'varanda-update.service', 'varanda-update.timer', 'cosign.ref', '.env.example',
  'secrets.sealed.json', 'secrets-signers.txt'
]

const OWNED = [
  'deploy/seeder/Dockerfile', '.dockerignore', 'deploy/seeder/compose.release.yaml',
  'deploy/seeder/compose.release.web.yaml', 'deploy/seeder/cosign.ref',
  'deploy/seeder/secrets-signers.txt', 'apps/cli/test/release-bundle.test.js'
]

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const WEB = 'ghcr.io/varanda-org/varanda-web@sha256:' + 'ab'.repeat(32)

const dockerfile = read('deploy/seeder/Dockerfile')
const dfLines = code(dockerfile)
const finalFrom = dfLines.findLastIndex((l) => /^FROM\s/.test(l))
const finalStage = dfLines.slice(finalFrom)
const userAt = finalStage.findIndex((l) => /^USER\s+node\s*$/.test(l))

// The RUN that writes release.json (the first RUN after the ARGs), as the
// shell receives it.
function releaseRun () {
  let i = finalStage.indexOf('ARG VARANDA_WEB_IMAGE=""')
  while (i !== -1 && i < finalStage.length && !/^RUN\s/.test(finalStage[i])) i++
  const out = []
  for (; i !== -1 && i < finalStage.length; i++) {
    const l = finalStage[i]
    out.push(l.replace(/\\$/, ''))
    if (!/\\$/.test(l)) break
  }
  return { at: i, script: out.join('\n').replace(/^RUN\s+/, '') }
}

function runRelease (env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-release-'))
  const out = path.join(dir, 'release.json')
  const { script } = releaseRun()
  const r = spawnSync('sh', ['-c', script.split('/app/release.json').join(out)], {
    env: { PATH: process.env.PATH, VARANDA_COMMIT: '', VARANDA_SEQ: '', VARANDA_WEB_IMAGE: '', ...env },
    encoding: 'utf8'
  })
  const exists = fs.existsSync(out)
  const content = exists ? fs.readFileSync(out, 'utf8') : null
  const mode = exists ? fs.statSync(out).mode & 0o777 : null
  fs.rmSync(dir, { recursive: true, force: true })
  return { status: r.status, content, mode }
}

test('Dockerfile: three release ARGs with empty defaults, in the final stage', (t) => {
  for (const name of ['VARANDA_COMMIT', 'VARANDA_SEQ', 'VARANDA_WEB_IMAGE']) {
    const all = dfLines.filter((l) => new RegExp('^ARG\\s+' + name + '\\b').test(l))
    t.is(all.length, 1, 'one ARG ' + name)
    t.ok(finalStage.includes('ARG ' + name + '=""'), name + ' declared in the final stage with an empty default')
  }
})

test('Dockerfile: release.json is written only with a commit, before USER node', (t) => {
  const { at, script } = releaseRun()
  t.ok(userAt > 0, 'final stage switches to USER node')
  t.ok(at > 0 && script.length > 0, 'release RUN found after the ARGs')
  t.ok(at < userAt, 'the release RUN comes before USER node')
  t.ok(/if \[ -z "\$VARANDA_COMMIT" \]; then[\s\S]*exit 0;[\s\S]*fi;/.test(script), 'empty commit leaves early')
  t.ok(script.includes('printf \'{"v":1,"commit":"%s","seq":%s,"web":"%s"}\\n\' "$VARANDA_COMMIT" "$VARANDA_SEQ" "$VARANDA_WEB_IMAGE" > /app/release.json'),
    'values reach the file only as printf arguments')
  t.ok(/chmod 0444 \/app\/release\.json/.test(script), 'release.json is 0444')
  t.is(dfLines.filter((l) => l.includes('release.json >') || l.includes('> /app/release.json')).length, 1, 'one write of release.json')
})

test('Dockerfile: release RUN validates and writes the exact line', { skip: process.platform === 'win32' }, (t) => {
  const none = runRelease({})
  t.is(none.status, 0, 'no args: success')
  t.is(none.content, null, 'no args: no release.json')

  const ok = runRelease({ VARANDA_COMMIT: COMMIT, VARANDA_SEQ: '1234', VARANDA_WEB_IMAGE: WEB })
  t.is(ok.status, 0, 'valid args: success')
  t.is(ok.content, '{"v":1,"commit":"' + COMMIT + '","seq":1234,"web":"' + WEB + '"}\n', 'exact line plus LF')
  t.is(ok.mode, 0o444, 'mode 0444')
  t.ok(/^\{"v":1,"commit":"[0-9a-f]{40}","seq":[1-9][0-9]{0,9},"web":"ghcr\.io\/varanda-org\/varanda-web@sha256:[0-9a-f]{64}"\}\n$/.test(ok.content), 'matches the server regex')

  t.is(runRelease({ VARANDA_COMMIT: COMMIT, VARANDA_SEQ: '9999999999', VARANDA_WEB_IMAGE: WEB }).status, 0, '10-digit seq accepted')

  const bad = [
    ['upper-case commit', { VARANDA_COMMIT: COMMIT.toUpperCase(), VARANDA_SEQ: '1', VARANDA_WEB_IMAGE: WEB }],
    ['41-char commit', { VARANDA_COMMIT: COMMIT + '8', VARANDA_SEQ: '1', VARANDA_WEB_IMAGE: WEB }],
    ['39-char commit', { VARANDA_COMMIT: COMMIT.slice(1), VARANDA_SEQ: '1', VARANDA_WEB_IMAGE: WEB }],
    ['commit with a newline', { VARANDA_COMMIT: COMMIT.slice(1) + '\n', VARANDA_SEQ: '1', VARANDA_WEB_IMAGE: WEB }],
    ['empty seq', { VARANDA_COMMIT: COMMIT, VARANDA_WEB_IMAGE: WEB }],
    ['zero seq', { VARANDA_COMMIT: COMMIT, VARANDA_SEQ: '0', VARANDA_WEB_IMAGE: WEB }],
    ['leading zero seq', { VARANDA_COMMIT: COMMIT, VARANDA_SEQ: '01', VARANDA_WEB_IMAGE: WEB }],
    ['11-digit seq', { VARANDA_COMMIT: COMMIT, VARANDA_SEQ: '12345678901', VARANDA_WEB_IMAGE: WEB }],
    ['negative seq', { VARANDA_COMMIT: COMMIT, VARANDA_SEQ: '-1', VARANDA_WEB_IMAGE: WEB }],
    ['seq injecting a key', { VARANDA_COMMIT: COMMIT, VARANDA_SEQ: '1,"x":2', VARANDA_WEB_IMAGE: WEB }],
    ['empty web', { VARANDA_COMMIT: COMMIT, VARANDA_SEQ: '1' }],
    ['web from another org', { VARANDA_COMMIT: COMMIT, VARANDA_SEQ: '1', VARANDA_WEB_IMAGE: WEB.replace('varanda-org', 'other') }],
    ['web by tag', { VARANDA_COMMIT: COMMIT, VARANDA_SEQ: '1', VARANDA_WEB_IMAGE: 'ghcr.io/varanda-org/varanda-web:edge' }],
    ['web short digest', { VARANDA_COMMIT: COMMIT, VARANDA_SEQ: '1', VARANDA_WEB_IMAGE: WEB.slice(0, -1) }],
    ['web empty digest', { VARANDA_COMMIT: COMMIT, VARANDA_SEQ: '1', VARANDA_WEB_IMAGE: 'ghcr.io/varanda-org/varanda-web@sha256:' }],
    ['web upper-case digest', { VARANDA_COMMIT: COMMIT, VARANDA_SEQ: '1', VARANDA_WEB_IMAGE: WEB.toUpperCase() }],
    ['web with a quote', { VARANDA_COMMIT: COMMIT, VARANDA_SEQ: '1', VARANDA_WEB_IMAGE: WEB.slice(0, -1) + '"' }],
    ['seq without commit', { VARANDA_SEQ: '1' }],
    ['web without commit', { VARANDA_WEB_IMAGE: WEB }]
  ]
  for (const [name, env] of bad) {
    const r = runRelease(env)
    t.not(r.status, 0, name + ': build fails')
    t.is(r.content, null, name + ': no release.json')
  }
})

test('Dockerfile: source label and the deploy bundle copied to /app/deploy/seeder', (t) => {
  t.ok(/org\.opencontainers\.image\.source="https:\/\/github\.com\/Varanda-org\/varanda"/.test(finalStage.join('\n')), 'source label')
  const copy = finalStage.findIndex((l) => /^COPY deploy\/seeder deploy\/seeder\s*$/.test(l))
  t.ok(copy > 0, 'bundle COPY in the final stage (WORKDIR /app)')
  t.ok(copy < userAt, 'copied before USER node, so root-owned')
  t.absent(/^COPY\s+--chown/m.test(finalStage.join('\n')), 'no --chown on the final stage copies')
  t.ok(finalStage.includes('WORKDIR /app'), 'WORKDIR /app')
})

test('.dockerignore: everything excluded first, exactly the bundle admitted under deploy/', (t) => {
  const rules = code(read('.dockerignore')).map((l) => l.trim())
  t.is(rules[0], '*', 'first rule is *')
  const deployRules = rules.filter((r) => /deploy/.test(r))
  const admitted = deployRules.filter((r) => r.startsWith('!deploy/seeder/')).map((r) => r.slice('!deploy/seeder/'.length))
  t.is(deployRules.length, admitted.length, 'every deploy rule admits one file under deploy/seeder')
  t.alike(admitted.slice().sort(), BUNDLE.slice().sort(), 'exactly the bundle files')
  for (const f of admitted) t.ok(/^[A-Za-z0-9._-]+$/.test(f), 'plain file name, no glob: ' + f)
  // A later negation with a glob and no "deploy" in it (!**, !*/seeder/*) would
  // admit the server checkout's .env or www: every admit rule is listed here.
  const admits = rules.filter((r) => r.startsWith('!'))
  const expected = ['!package.json', '!package-lock.json', '!LICENSE', '!packages/core', '!packages/rpc', '!apps/cli']
    .concat(BUNDLE.map((f) => '!deploy/seeder/' + f))
  t.alike(admits.slice().sort(), expected.slice().sort(), 'the admit rules are exactly the CLI files plus the bundle')
  t.absent(admits.some((r) => r.includes('*')), 'no admit rule has a glob')
  t.absent(admitted.includes('.env'), '.env never admitted')
  t.absent(admitted.includes('www'), 'www never admitted')
  for (const r of ['!package.json', '!package-lock.json', '!LICENSE', '!packages/core', '!packages/rpc', '!apps/cli']) {
    t.ok(rules.includes(r), 'still admits ' + r)
  }
})

test('compose.release.yaml and compose.release.web.yaml: only the image keys', (t) => {
  const seederMsg = '[^}]+'
  const release = code(read('deploy/seeder/compose.release.yaml'))
  t.is(release.length, 3, 'three lines of YAML')
  t.is(release[0], 'services:')
  t.is(release[1], '  seeder:')
  t.ok(new RegExp('^ {4}image: "\\$\\{VARANDA_SEEDER_IMAGE:\\?' + seederMsg + '\\}"$').test(release[2]), 'seeder image from VARANDA_SEEDER_IMAGE (required)')

  const web = code(read('deploy/seeder/compose.release.web.yaml'))
  t.is(web.length, 5, 'five lines of YAML')
  t.is(web[0], 'services:')
  t.is(web[1], '  web:')
  t.ok(new RegExp('^ {4}image: "\\$\\{VARANDA_WEB_IMAGE:\\?' + seederMsg + '\\}"$').test(web[2]), 'web image from VARANDA_WEB_IMAGE (required)')
  t.is(web[3], '  account:')
  t.ok(new RegExp('^ {4}image: "\\$\\{VARANDA_SEEDER_IMAGE:\\?' + seederMsg + '\\}"$').test(web[4]), 'account image from VARANDA_SEEDER_IMAGE (required)')

  for (const lines of [release, web]) {
    const text = lines.join('\n')
    t.absent(/environment|volumes|build|command/.test(text), 'no other service key')
    t.absent(/!\w/.test(text), 'no YAML tag')
    t.is((text.match(/\$\{/g) || []).length, lines === release ? 1 : 2, 'only the required image variables')
  }

  t.ok(/^name: varanda-seeder$/m.test(read('deploy/seeder/compose.yaml')), 'project name stays varanda-seeder')
})

test('cosign.ref: one line, the official cosign image by version and digest', (t) => {
  const ref = fs.readFileSync(path.join(SEEDER, 'cosign.ref'), 'utf8')
  t.ok(/^ghcr\.io\/sigstore\/cosign\/cosign:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}\n$/.test(ref), 'shape and a single trailing LF')
})

test('release bundle files: no em dash', (t) => {
  for (const rel of OWNED) {
    t.absent(read(rel).includes('\u2014'), 'no em dash in ' + rel)
  }
})
