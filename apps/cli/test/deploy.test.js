const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '../../..')
const WORKFLOW = path.join(repoRoot, '.github/workflows/deploy.yml')
const SCRIPT = path.join(repoRoot, 'deploy/seeder/deploy.sh')
// The native app association rules, sourced by deploy.sh and build-web.sh.
const WELL_KNOWN = path.join(repoRoot, 'deploy/seeder/well-known.sh')
const SOURCE_WELL_KNOWN = '. ' + JSON.stringify(WELL_KNOWN) + '\n'

// Optional seeder limits passed through compose.web.yaml (read by apps/cli/lib/cli.js).
const SEEDER_LIMITS = [
  'VARANDA_MAX_EXTERNAL', 'VARANDA_MAX_SOCKETS', 'VARANDA_FRAME_MEMORY', 'VARANDA_STORAGE_BYTES',
  'VARANDA_MEDIA_MAX_IN_FLIGHT', 'VARANDA_MEDIA_RATE', 'VARANDA_MEDIA_BURST',
  'VARANDA_INDEX_MAX_IN_FLIGHT', 'VARANDA_INDEX_RATE', 'VARANDA_INDEX_BURST'
]
// The hosted defaults of compose.web.yaml (docs/seeder-capacity.md). A limit
// missing here stays empty and takes the seeder's own default.
const HOSTED_DEFAULTS = {
  VARANDA_MAX_EXTERNAL: '96',
  VARANDA_MAX_SOCKETS: '256',
  // 3 x the seeder's 64 MiB, in the proportion of 96 to 32 connections.
  VARANDA_FRAME_MEMORY: '201326592',
  VARANDA_MEDIA_MAX_IN_FLIGHT: '32',
  VARANDA_MEDIA_RATE: '256',
  VARANDA_MEDIA_BURST: '512',
  VARANDA_INDEX_RATE: '128',
  VARANDA_INDEX_BURST: '256'
}

// deploy.yml, checked with line and regex rules (no YAML parser available).
// Comment lines are dropped so prose cannot satisfy or trip a rule.
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

const check = block(/^ {2}check:/, /^ {2}\S/)
const deploy = block(/^ {2}deploy:/, /^ {2}\S/)
const supersede = block(/^ {2}supersede:/, /^ {2}\S/)
// The eight test legs, each its own job (no matrix), gated by check.
const WORKERS = ['core-1', 'core-2', 'cli-1', 'cli-2', 'web-member-1', 'web-member-2', 'web-member-3', 'others']
const workers = Object.fromEntries(WORKERS.map((id) => [id, block(new RegExp('^ {2}' + id + ':\\s*$'), /^ {2}\S/)]))
const GUARD = "github\\.repository == 'Varanda-org\\/varanda' && github\\.ref == 'refs\\/heads\\/main' && vars\\.VARANDA_DEPLOY == 'true'"
// The deploy also needs the supersede job's go (apps/cli/test/supersede.test.js).
const GO = " && needs\\.supersede\\.outputs\\.go == 'true'"

test('deploy.yml: actions pinned to the expected commits', (t) => {
  const pins = {
    'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020'
  }
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1])
  t.is(uses.length, 2, 'two uses: lines')
  for (const u of uses) {
    const [name, ref] = u.split('@')
    t.ok(/^[0-9a-f]{40}$/.test(ref), 'pinned to a 40-hex SHA: ' + u)
    t.is(ref, pins[name], 'expected pin for ' + name)
  }
  t.alike(uses.map((u) => u.split('@')[0]).sort(), Object.keys(pins).sort())
  t.ok(/uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\s*\n\s+persist-credentials:\s*false/.test(code), 'checkout has persist-credentials: false')
})

test('deploy.yml: permissions, triggers and job shape', (t) => {
  const top = block(/^permissions:/, /^\S/)
  const topLines = top.split('\n').slice(1).filter((l) => l.trim() !== '').map((l) => l.trim())
  t.alike(topLines, ['contents: read'], 'top-level permissions are contents: read only')
  t.ok(check && deploy, 'check and deploy found')
  for (const id of WORKERS) t.ok(workers[id], id + ' job found')
  const jobs = block(/^jobs:/, /^\S/).split('\n').filter((l) => /^ {2}[A-Za-z0-9_-]+:/.test(l)).map((l) => l.trim().replace(/:.*$/, ''))
  t.alike(jobs.sort(), [...WORKERS, 'check', 'supersede', 'deploy'].sort(), 'jobs are the eight legs, check, supersede and deploy')
  t.absent(/^\s+strategy:/m.test(code), 'no matrix strategy')
  t.absent(/<<:/.test(code), 'no YAML merge keys')
  t.absent(yml.includes(String.fromCharCode(0x2014)), 'no em dash')

  t.ok(/^ {4}permissions:\s*\{\}\s*$/m.test(deploy), 'deploy job has permissions: {}')
  t.ok(/^ {4}needs:\s*\[check, supersede\]\s*$/m.test(deploy), 'deploy needs check and supersede')
  t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(deploy), 'deploy runs-on ubuntu-24.04')
  t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(check), 'check runs-on ubuntu-24.04')
  t.ok(/^ {6}name:\s*producao\s*$/m.test(deploy), 'deploy uses the producao environment')
  t.absent(/\buses:/.test(deploy), 'deploy job has no uses: (no third-party action)')
  t.absent(/^ {4}environment:/m.test(check), 'check job has no environment')
  t.absent(/\buses:/.test(check), 'check job has no uses: (no checkout)')
  for (const id of WORKERS) {
    const w = workers[id]
    t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(w), id + ' runs-on ubuntu-24.04')
    t.absent(/^ {4}environment:/m.test(w), id + ' has no environment')
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

  const on = block(/^on:/, /^\S/)
  t.ok(/^ {2}push:\s*$/m.test(on) && /branches:\s*\[main\]/.test(on), 'push trigger on main only')
  t.ok(/^ {2}workflow_dispatch:/m.test(on), 'workflow_dispatch trigger')
  t.is((on.match(/^ {2}\S+:/gm) || []).length, 2, 'exactly two triggers')

  t.absent(/^concurrency:/m.test(code), 'no workflow concurrency: a run waiting for approval would hold the newer one back')
  t.ok(/^ {6}cancel-in-progress:\s*false\s*$/m.test(deploy), 'deploy cancel-in-progress is false')
  t.ok(/^ {6}group:\s*deploy-\$\{\{ github\.ref \}\}\s*$/m.test(deploy), 'deploy concurrency group is per ref (deploy-<ref>)')
})

test('deploy.yml: every job carries the repository, branch and variable guards', (t) => {
  const guard = new RegExp('^ {4}if:\\s*' + GUARD + '\\s*$', 'm')
  for (const id of WORKERS) t.ok(guard.test(workers[id]), id + ' job is guarded')
  t.ok(guard.test(supersede), 'supersede job is guarded')
  t.ok(new RegExp('^ {4}if:\\s*' + GUARD + GO + '\\s*$', 'm').test(deploy), 'deploy job is guarded and needs the supersede go')
  // The gate runs even when a leg failed, was cancelled or was skipped, and
  // fails closed: a skipped check would read as passing.
  t.ok(new RegExp('^\\s+if:\\s*always\\(\\) && ' + GUARD + '\\s*$', 'm').test(check), 'check gate runs always() under the guard')
  t.ok(/^ {4}needs:\s*\[\s*core-1,\s*core-2,\s*cli-1,\s*cli-2,\s*web-member-1,\s*web-member-2,\s*web-member-3,\s*others\s*\]\s*$/m.test(check), 'check needs exactly the eight legs')
  t.ok(/^\s+RESULTS:\s*\$\{\{ join\(needs\.\*\.result, ' '\) \}\}\s*$/m.test(check), 'check reads every leg result')
  t.ok(/^\s+\[ "\$#" -eq 8 \] \|\| exit 1\s*$/m.test(check), 'check requires exactly eight results')
  t.ok(/^\s+for r in "\$@"; do \[ "\$r" = success \] \|\| exit 1; done\s*$/m.test(check), 'check requires every result to be success')
})

test('deploy.yml: secrets and variables are only the expected ones, only in env: or if:', (t) => {
  const secrets = new Set([...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
  const vars = new Set([...code.matchAll(/vars\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
  t.alike([...secrets].sort(), ['DEPLOY_SSH_KEY'], 'secret names')
  t.alike([...vars].sort(), ['DEPLOY_HOST', 'DEPLOY_KNOWN_HOSTS', 'VARANDA_DEPLOY'], 'variable names')
  t.absent(/\bsecrets:\s*inherit/.test(code), 'no secrets: inherit')
  t.absent(/toJSON\((secrets|vars)/i.test(code), 'no dump of the secrets or vars context')
  for (const l of lines) {
    if (!/\b(secrets|vars)\./.test(l)) continue
    const ok = /^\s+if:\s/.test(l) || /^\s+[A-Z_]+:\s*\$\{\{\s*(secrets|vars)\.[A-Za-z0-9_]+\s*\}\}\s*$/.test(l)
    t.ok(ok, 'only in env: or if: -> ' + l.trim())
  }
  // Nothing from the contexts may be interpolated into a run: script.
  t.absent(/\$\{\{\s*(secrets|vars)\./.test(code.replace(/^\s+(if:|[A-Z_]+:)\s.*$/gm, '')), 'no interpolation outside env:/if:')
})

test('deploy.yml: forbidden constructs are absent', (t) => {
  t.absent(/pull_request/.test(code), 'no pull_request or pull_request_target')
  t.absent(/\bworkflow_run\b/.test(code), 'no workflow_run')
  t.absent(/self-hosted/.test(code), 'no self-hosted runner')
  t.absent(/StrictHostKeyChecking=(no|accept-new)/.test(code), 'host key checking is never relaxed')
  t.absent(/StrictHostKeyChecking\s+(no|accept-new)/.test(code), 'no relaxed host key checking (space form)')
  t.absent(/ssh-keyscan/.test(code), 'no ssh-keyscan')
  t.absent(/ForwardAgent/.test(code), 'no agent forwarding')
})

test('deploy.yml: test step order and ssh hardening', (t) => {
  const steps = workers[WORKERS[0]].split('\n')
  const ci = steps.findIndex((l) => /^\s+- run:\s*npm ci --ignore-scripts\s*$/.test(l))
  const lint = steps.findIndex((l) => /^\s+run:\s*npm run lint\s*$/.test(l))
  const tst = steps.findIndex((l) => /^\s+- run:.*npm test -w "\$WORKSPACE"/.test(l) && /\bnpm test;/.test(l))
  const demo = steps.findIndex((l) => /^\s+run:\s*npm run demo\s*$/.test(l))
  const idx = [ci, lint, tst, demo]
  t.ok(idx.every((i) => i !== -1), 'npm ci, lint, test and demo steps present in the anchored list')
  t.alike([...idx].sort((a, b) => a - b), idx, 'npm ci, lint, test, demo in that order')
  const othersOnly = /^\s+- if:\s*env\.SUITE == 'others'\s*$/
  t.ok(lint > 0 && othersOnly.test(steps[lint - 1]), 'lint runs only in the others leg')
  t.ok(demo > 0 && othersOnly.test(steps[demo - 1]), 'demo runs only in the others leg')
  // Includes the body of run: | blocks (lines indented deeper than the key).
  let runIndent = -1
  for (const l of lines) {
    const indent = l.search(/\S/)
    if (runIndent !== -1 && indent !== -1 && indent <= runIndent) runIndent = -1
    const isRun = /^\s+(- )?run:/.test(l)
    if (isRun || runIndent !== -1) t.absent(l.includes('${' + '{'), 'no expression in run: -> ' + l.trim())
    if (isRun && /run:\s*\|\s*$/.test(l)) runIndent = indent
  }

  t.ok(/\bssh -T\b/.test(deploy), 'ssh -T')
  t.ok(/-o BatchMode=yes/.test(deploy), 'BatchMode=yes')
  t.ok(/-o StrictHostKeyChecking=yes/.test(deploy), 'StrictHostKeyChecking=yes')
  t.ok(/-o IdentitiesOnly=yes/.test(deploy), 'IdentitiesOnly=yes')
  t.ok(/-o HostKeyAlias=varanda-producao/.test(deploy), 'HostKeyAlias=varanda-producao')
  t.ok(/varanda_known_hosts/.test(deploy), 'pinned known_hosts file')
  t.ok(/\[\[ "\$DEPLOY_HOST" =~ \^\[A-Za-z0-9\.-\]\+\$ \]\]/.test(deploy), 'DEPLOY_HOST is validated before use')
  t.ok(/if \[ "\$rc" -eq 3 \]/.test(deploy) && /exit 0/.test(deploy), 'exit code 3 ends green')
  t.ok(/exit "\$rc"/.test(deploy), 'other exit codes propagate')
  t.ok(/if:\s*always\(\)[\s\S]*rm -f "\$HOME\/\.ssh\/varanda_deploy_key"/.test(deploy), 'the key is removed even on failure')
})

// deploy.sh, with comment lines dropped for the forbidden-string rules.
const sh = fs.readFileSync(SCRIPT, 'utf8')
const shLines = sh.split('\n')
const shCode = shLines.filter((l) => !/^\s*#/.test(l)).join('\n')

test('deploy.sh: executable, required strings and last line', (t) => {
  const mode = fs.statSync(SCRIPT).mode & 0o777
  t.ok((mode & 0o111) === 0o111, 'exec bit set (mode ' + mode.toString(8) + ')')
  t.is(shLines[0], '#!/usr/bin/env bash', 'shebang')
  const required = [
    'set -Eeuo pipefail',
    "trap '' HUP PIPE",
    // A server that moved to the pull updater (update.sh install) refuses the push path.
    'modo-pull',
    'cd "$root"',
    'flock',
    'merge-base --is-ancestor',
    'exec 3>&1',
    '127.0.0.1:8788/health',
    'www-anterior',
    'varanda-seeder:anterior',
    // The Caddy image (with the per-client rate limit) is kept and restored
    // the same way as the seeder image.
    'varanda-caddy:anterior',
    'varanda-caddy:local',
    'conteiner_caddy',
    'com.docker.compose.service=web',
    'implantado',
    'exit 3',
    '[0-9a-f]{40}',
    '--max-time',
    // The web build gets an exported copy of the commit, never the checkout.
    'git archive "$target"',
    'construir_web',
    '--remove-orphans',
    // sudoers trusts a file inside the checkout: it must be root-owned.
    "stat -c '%u'",
    'já implantado',
    // The snapshot reads the service container, never a one-off `compose run`.
    'com.docker.compose.oneoff=False',
    // The web build never runs as root: the exported copy belongs to nobody.
    'chown -R 65534:65534 "$stage"',
    // The rollback only undoes what the deploy actually changed.
    'servicos_trocados=1',
    'www_trocado=1',
    // The service worker and the hashed bundle are probed after the deploy,
    // and the build must produce sw.js.
    'servido_igual sw.js sw.js',
    '[ ! -f "$www/sw.js" ]',
    // Split so that standard does not read it as a template placeholder.
    'servido_igual "$' + '{bundle#/}" "$' + '{bundle#/}"',
    'o build não gerou index.html, varanda-node.js e sw.js',
    // The node copy the page loads (varanda-node-<release>.js) is probed by
    // the release mark of the www index.html, and the page lands last.
    'versao=$(versao_web "$www/index.html")',
    '[ -z "$versao" ] || servido_igual "varanda-node-$versao.js" "varanda-node-$versao.js"',
    'copiar_app "$base/src/apps/app/dist" "$novo"',
    // The new tree is built beside www and merged in by renames; the rollback
    // restores the saved www the same way (cp -a keeps its attributes).
    'mesclar_www "$novo" "$www"',
    'mesclar_www "$state/www-anterior" "$www"',
    // The account service is probed through the domain, and its OAuth client
    // must be configured before anything changes.
    '/account/health',
    // The service ends every JSON body with LF (apps/cli/lib/account/server.js
    // send); account.test.js pins the same bytes.
    "printf '%s\\n' '{\"status\":\"ok\"}'",
    'VARANDA_GOOGLE_CLIENT_ID',
    // The optional moderator list is validated by shape before anything
    // changes, and the unauthenticated panel probe is guarded by the route
    // file so a rollback to B2 skips it.
    'VARANDA_MODERATOR_EMAILS',
    // The optional usage-stats list must be a subset of the moderators, and
    // the seeder health URL it enables must stay on loopback.
    'VARANDA_STATS_EMAILS',
    'VARANDA_SEEDER_HEALTH',
    // The optional account limits are checked as positive integers in range.
    'VARANDA_MAX_MEMBERS',
    'VARANDA_ACCOUNT_MAX_CONNECTIONS',
    'VARANDA_ACCOUNT_RATE',
    'VARANDA_ACCOUNT_BURST',
    'VARANDA_ACCOUNT_MAX_PENDING',
    'VARANDA_INVITES_PER_WEEK',
    'VARANDA_FEIRA_INVITES_PER_WEEK',
    'VARANDA_FEIRA_ORIGIN',
    'VARANDA_POSTS_ORIGIN inválido em deploy/seeder/.env',
    '/account/mod/api/me',
    // The optional native app associations (rules in well-known.sh) are
    // validated before anything changes and written into www after the copy.
    'ler_associacoes "$env_file"',
    'gravar_associacoes "$www"',
    'publicar_associacoes',
    // The helper is sourced only after its owner was checked (root runs it).
    '"$root/deploy/seeder/well-known.sh" "$root/.git"',
    // The build gets the validated commit, and root rewrites version.json in
    // www from it; the probe compares with the www copy, so a rollback passes.
    'EXPO_PUBLIC_VARANDA_COMMIT="$target"',
    'gravar_versao "$novo" "$target"',
    'servido_igual version.json version.json',
    '[ ! -f "$www/version.json" ]',
    // The optional seeder limits are validated by shape before anything changes.
    ...SEEDER_LIMITS
  ]
  for (const s of required) t.ok(shCode.includes(s), 'contains ' + s)
  const nonEmpty = shLines.filter((l) => l.trim() !== '')
  t.is(nonEmpty[nonEmpty.length - 1], 'main "$@"', 'last line is main "$@"')
  const wait = fs.readFileSync(SCRIPT, 'utf8').match(/^aguardar_web\(\) \{\n[\s\S]*?^\}\n/m)
  t.ok(wait, 'aguardar_web located')
  t.absent(wait && wait[0].includes('$target'), 'aguardar_web never compares with $target (a rollback must pass)')
  t.absent(shCode.includes('cp -R "$base/src/apps/app/dist/." "$www/"'), 'www is never filled in directory order')
  t.absent(shCode.includes('cp -a "$state/www-anterior/." "$www/"'), 'nor restored in directory order by the rollback')
  t.absent(/find "\$www" -mindepth 1 -delete/.test(shCode), 'www is never emptied while Caddy serves it')
})

test('deploy.sh: forbidden constructs are absent', (t) => {
  t.absent(/\beval\b/.test(shCode), 'no eval')
  t.absent(/SSH_ORIGINAL_COMMAND/.test(shCode), 'no SSH_ORIGINAL_COMMAND')
  t.absent(/down\s+-v/.test(shCode), 'no down -v')
  t.absent(/compose[^\n]*\bdown\b/.test(shCode), 'no compose down')
  t.absent(/git clean/.test(shCode), 'no git clean')
  t.absent(/volume\s+(rm|prune)/.test(shCode), 'no volume rm/prune')
  t.absent(/seed (key|cert)/.test(shCode), 'no seed key/cert')
  t.absent(/account (key|cert)/.test(shCode), 'no account key/cert')
  // The moderator key never exists on the server: the deploy never runs
  // moderator commands.
  t.absent(/mod (init|cert|block|unblock|apply)/.test(shCode), 'no moderator commands')
  t.absent(/account\/mod\/login/.test(shCode), 'the probe never requests /account/mod/login')
  // Raw build/docker output stays on the server: Actions logs of a public
  // repository are public.
  t.absent(/tail\b[^\n]*log_file/.test(shCode), 'no log tail forwarded to the caller')
  // build-web.sh only ever builds in the exported copy, and only regular files
  // and directories are copied back out of it.
  t.absent(/^\s*bash deploy\/seeder\/build-web\.sh\s*$/m.test(shCode), 'build-web.sh never runs on the live checkout')
  t.ok(shCode.includes('bash deploy/seeder/build-web.sh "$stage"'), 'build-web.sh builds in the exported copy')
  t.ok(shCode.includes('! -type f ! -type d'), 'symlinks and special files from the build are refused')
  // Only $((...)) expansions are allowed; a standalone (( ... )) command
  // (for example an increment) would trip set -e when it evaluates to 0.
  // The embedded Node snippet (ws_script) is JavaScript, so it is left out.
  const shellOnly = shCode.replace(/^ws_script='[\s\S]*?^'$/m, '')
  t.ok(shellOnly.length < shCode.length, 'ws_script block located')
  t.absent(/(^|[^$])\(\(/.test(shellOnly), 'no standalone (( )) arithmetic command')
})

// compose.web.yaml and the Caddyfile, comment lines dropped as above.
const COMPOSE_WEB = path.join(repoRoot, 'deploy/seeder/compose.web.yaml')
const CADDYFILE = path.join(repoRoot, 'deploy/seeder/Caddyfile')

test('compose.web.yaml: the account service has its own volume', (t) => {
  const webLines = fs.readFileSync(COMPOSE_WEB, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
  const start = webLines.findIndex((l) => /^ {2}account:\s*$/.test(l))
  t.ok(start !== -1, 'account service found')
  let end = webLines.length
  for (let i = start + 1; i < webLines.length; i++) {
    if (/^ {0,2}\S/.test(webLines[i])) { end = i; break }
  }
  const account = webLines.slice(start, end).join('\n')
  t.ok(/^ {6}- account-data:\/data\s*$/m.test(account), 'account mounts account-data:/data')
  t.absent(/seeder-data/.test(account), 'account never mounts seeder-data')
  t.absent(/^ {4}build:/m.test(account), 'account has no build: (the seeder service builds the image)')
  t.ok(/^ {2}account-data:\s*$/m.test(webLines.slice(webLines.findIndex((l) => /^volumes:/.test(l))).join('\n')), 'account-data: is declared')
})

test('compose.web.yaml: VARANDA_MODERATOR_EMAILS is optional and only on the account service', (t) => {
  const webLines = fs.readFileSync(COMPOSE_WEB, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
  const hits = webLines.map((l, i) => [l, i]).filter(([l]) => l.includes('VARANDA_MODERATOR_EMAILS'))
  t.is(hits.length, 1, 'mentioned exactly once')
  const start = webLines.findIndex((l) => /^ {2}account:\s*$/.test(l))
  let end = webLines.length
  for (let i = start + 1; i < webLines.length; i++) {
    if (/^ {0,2}\S/.test(webLines[i])) { end = i; break }
  }
  t.ok(hits[0][1] > start && hits[0][1] < end, 'it sits under the account service')
  t.ok(/VARANDA_MODERATOR_EMAILS: "\$\{VARANDA_MODERATOR_EMAILS:-\}"/.test(hits[0][0]), 'optional (:-), never :?')
})

// AI report triage is optional: every variable defaults with :- (never :?),
// so an existing .env still boots with triage off. The account service gets
// all four; the seeder gets only the shared token; the web service none.
test('compose.web.yaml: AI triage variables are optional and scoped to account and seeder', (t) => {
  const webLines = fs.readFileSync(COMPOSE_WEB, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
  function service (name) {
    const start = webLines.findIndex((l) => l === '  ' + name + ':')
    let end = webLines.length
    for (let i = start + 1; i < webLines.length; i++) {
      if (/^ {0,2}\S/.test(webLines[i])) { end = i; break }
    }
    return start === -1 ? [] : webLines.slice(start, end)
  }
  const account = service('account')
  const seeder = service('seeder')
  const web = service('web')
  t.ok(account.length > 0 && seeder.length > 0 && web.length > 0, 'account, seeder and web found')
  const keyCount = (ls, name) => ls.filter((l) => new RegExp('^ {6}' + name + ':').test(l)).length

  for (const name of ['VARANDA_AI', 'VARANDA_SEEDER_HTTP', 'VARANDA_TRIAGE_TOKEN', 'VARANDA_AI_MODEL_DIR']) {
    t.is(keyCount(account, name), 1, name + ' exactly once under account')
    t.is(keyCount(web, name), 0, name + ' not on web')
  }
  t.is(keyCount(seeder, 'VARANDA_TRIAGE_TOKEN'), 1, 'VARANDA_TRIAGE_TOKEN exactly once under seeder')
  for (const name of ['VARANDA_AI', 'VARANDA_SEEDER_HTTP', 'VARANDA_AI_MODEL_DIR']) {
    t.is(keyCount(seeder, name), 0, name + ' not on seeder')
  }
  t.is(webLines.filter((l) => l.includes('VARANDA_TRIAGE_TOKEN')).length, 2, 'token mentioned only on account and seeder')

  const line = (ls, name) => ls.find((l) => new RegExp('^ {6}' + name + ':').test(l)) || ''
  t.ok(/VARANDA_AI: "\$\{VARANDA_AI:-\}"/.test(line(account, 'VARANDA_AI')), 'VARANDA_AI optional (:-)')
  t.ok(/VARANDA_TRIAGE_TOKEN: "\$\{VARANDA_TRIAGE_TOKEN:-\}"/.test(line(account, 'VARANDA_TRIAGE_TOKEN')), 'account token optional (:-)')
  t.ok(/VARANDA_TRIAGE_TOKEN: "\$\{VARANDA_TRIAGE_TOKEN:-\}"/.test(line(seeder, 'VARANDA_TRIAGE_TOKEN')), 'seeder token optional (:-)')
  t.ok(/VARANDA_SEEDER_HTTP: "\$\{VARANDA_SEEDER_HTTP:-http:\/\/127\.0\.0\.1:8789\}"/.test(line(account, 'VARANDA_SEEDER_HTTP')),
    'VARANDA_SEEDER_HTTP defaults to the seeder loopback listener')
  t.ok(seeder.some((l) => l.trim() === 'VARANDA_WS_PORT: "8789"') && seeder.some((l) => l.trim() === 'VARANDA_WS_HOST: 127.0.0.1'),
    'the seeder listener is 127.0.0.1:8789')
  t.ok(account.some((l) => l.trim() === 'network_mode: host'), 'account on the host network (reaches seeder loopback)')
  t.ok(/VARANDA_AI_MODEL_DIR: "?\/data\/ai-model"?\s*$/.test(line(account, 'VARANDA_AI_MODEL_DIR')), 'model dir inside account-data')
  for (const name of ['VARANDA_AI', 'VARANDA_SEEDER_HTTP', 'VARANDA_TRIAGE_TOKEN']) {
    t.absent(webLines.some((l) => l.includes('$' + '{' + name + ':?')), name + ' never :?')
  }

  // Unchanged hardening on account.
  const text = account.join('\n')
  t.absent(/seeder-data/.test(text), 'account still never mounts seeder-data')
  t.ok(/^ {4}read_only: true\s*$/m.test(text), 'account read_only')
  t.ok(/^ {4}cap_drop:\s*\n {6}- ALL\s*$/m.test(text), 'account cap_drop ALL')
  t.ok(/^ {4}healthcheck:/m.test(text), 'account healthcheck kept')
})

// Usage stats are optional and account-only: the list defaults to empty (tab,
// sampling and usage.json off) and the seeder health URL defaults to the
// seeder's loopback health listener. Neither ever reaches seeder or web.
test('compose.web.yaml and .env.example: usage-stats variables are optional and only on the account service', (t) => {
  const webLines = fs.readFileSync(COMPOSE_WEB, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
  function service (name) {
    const start = webLines.findIndex((l) => l === '  ' + name + ':')
    let end = webLines.length
    for (let i = start + 1; i < webLines.length; i++) {
      if (/^ {0,2}\S/.test(webLines[i])) { end = i; break }
    }
    return start === -1 ? [] : webLines.slice(start, end)
  }
  const account = service('account')
  const seeder = service('seeder')
  const web = service('web')
  t.ok(account.length > 0 && seeder.length > 0 && web.length > 0, 'account, seeder and web found')
  const keyCount = (ls, name) => ls.filter((l) => new RegExp('^ {6}' + name + ':').test(l)).length
  const line = (ls, name) => ls.find((l) => new RegExp('^ {6}' + name + ':').test(l)) || ''

  for (const name of ['VARANDA_STATS_EMAILS', 'VARANDA_SEEDER_HEALTH']) {
    t.is(webLines.filter((l) => l.includes(name)).length, 1, name + ' mentioned exactly once')
    t.is(keyCount(account, name), 1, name + ' exactly once under account')
    t.is(keyCount(seeder, name), 0, name + ' not on seeder')
    t.is(keyCount(web, name), 0, name + ' not on web')
    t.absent(webLines.some((l) => l.includes('$' + '{' + name + ':?')), name + ' never :?')
  }
  t.is(line(account, 'VARANDA_STATS_EMAILS').trim(), 'VARANDA_STATS_EMAILS: "$' + '{VARANDA_STATS_EMAILS:-}"', 'stats list optional (:-)')
  t.is(line(account, 'VARANDA_SEEDER_HEALTH').trim(), 'VARANDA_SEEDER_HEALTH: "$' + '{VARANDA_SEEDER_HEALTH:-http://127.0.0.1:8788}"',
    'seeder health defaults to the loopback health listener')

  const example = fs.readFileSync(path.join(repoRoot, 'deploy/seeder/.env.example'), 'utf8').split('\n')
  t.ok(example.includes('VARANDA_STATS_EMAILS='), '.env.example has an empty VARANDA_STATS_EMAILS= line')
})

// Web push is optional: the shared token defaults to empty (push off), so an
// existing .env still boots. The seeder gets the token and the loopback URL of
// the account service; the account service only the token; the web service
// none. The VAPID key lives in push-vapid.json on account-data, never in env.
test('compose.web.yaml and env examples: web push variables are optional and scoped to seeder and account', (t) => {
  const webLines = fs.readFileSync(COMPOSE_WEB, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
  function service (name) {
    const start = webLines.findIndex((l) => l === '  ' + name + ':')
    let end = webLines.length
    for (let i = start + 1; i < webLines.length; i++) {
      if (/^ {0,2}\S/.test(webLines[i])) { end = i; break }
    }
    return start === -1 ? [] : webLines.slice(start, end)
  }
  const account = service('account')
  const seeder = service('seeder')
  const web = service('web')
  t.ok(account.length > 0 && seeder.length > 0 && web.length > 0, 'account, seeder and web found')
  const keyCount = (ls, name) => ls.filter((l) => new RegExp('^ {6}' + name + ':').test(l)).length
  const line = (ls, name) => ls.find((l) => new RegExp('^ {6}' + name + ':').test(l)) || ''

  t.is(keyCount(seeder, 'VARANDA_PUSH_TOKEN'), 1, 'VARANDA_PUSH_TOKEN exactly once under seeder')
  t.is(keyCount(account, 'VARANDA_PUSH_TOKEN'), 1, 'VARANDA_PUSH_TOKEN exactly once under account')
  t.is(keyCount(web, 'VARANDA_PUSH_TOKEN'), 0, 'VARANDA_PUSH_TOKEN not on web')
  t.is(webLines.filter((l) => l.includes('VARANDA_PUSH_TOKEN')).length, 2, 'token mentioned only on seeder and account')
  t.is(line(seeder, 'VARANDA_PUSH_TOKEN').trim(), 'VARANDA_PUSH_TOKEN: "$' + '{VARANDA_PUSH_TOKEN:-}"', 'seeder token optional (:-)')
  t.is(line(account, 'VARANDA_PUSH_TOKEN').trim(), 'VARANDA_PUSH_TOKEN: "$' + '{VARANDA_PUSH_TOKEN:-}"', 'account token optional (:-)')

  for (const name of [
    'VARANDA_DIDIT_API_KEY', 'VARANDA_DIDIT_WORKFLOW_ID', 'VARANDA_PHONE_KEY', 'VARANDA_PHONE_DAILY_LIMIT', 'VARANDA_PHONE_REVIEW',
    'VARANDA_APNS_KEY_FILE', 'VARANDA_APNS_KEY_ID', 'VARANDA_APNS_TEAM_ID', 'VARANDA_APNS_TOPIC', 'VARANDA_APNS_SANDBOX', 'VARANDA_FCM_ACCOUNT_FILE'
  ]) {
    t.is(keyCount(account, name), 1, name + ' exactly once under account')
    t.is(keyCount(seeder, name), 0, name + ' not on seeder')
    t.is(keyCount(web, name), 0, name + ' not on web')
    t.is(webLines.filter((l) => l.includes(name)).length, 1, name + ' mentioned only on account')
    t.is(line(account, name).trim(), name + ': "$' + '{' + name + ':-}"', name + ' optional (:-)')
  }

  t.is(webLines.filter((l) => l.includes('VARANDA_ACCOUNT_HTTP')).length, 1, 'VARANDA_ACCOUNT_HTTP mentioned exactly once')
  t.is(keyCount(seeder, 'VARANDA_ACCOUNT_HTTP'), 1, 'VARANDA_ACCOUNT_HTTP under seeder')
  t.is(line(seeder, 'VARANDA_ACCOUNT_HTTP').trim(), 'VARANDA_ACCOUNT_HTTP: "$' + '{VARANDA_ACCOUNT_HTTP:-http://127.0.0.1:8790}"',
    'VARANDA_ACCOUNT_HTTP defaults to the account loopback listener')
  t.ok(account.some((l) => l.trim() === 'VARANDA_ACCOUNT_PORT: "8790"') && account.some((l) => l.trim() === 'VARANDA_ACCOUNT_HOST: 127.0.0.1'),
    'the account listener is 127.0.0.1:8790')
  for (const name of ['VARANDA_PUSH_TOKEN', 'VARANDA_ACCOUNT_HTTP']) {
    t.absent(webLines.some((l) => l.includes('$' + '{' + name + ':?')), name + ' never :?')
  }

  const example = fs.readFileSync(path.join(repoRoot, 'deploy/seeder/.env.example'), 'utf8')
  t.ok(example.split('\n').includes('VARANDA_PUSH_TOKEN='), '.env.example has an empty VARANDA_PUSH_TOKEN= line')
  const seederExample = fs.readFileSync(path.join(repoRoot, 'deploy/seeder/seeder.env.example'), 'utf8')
  t.ok(seederExample.split('\n').some((l) => /^#VARANDA_PUSH_TOKEN=/.test(l)), 'seeder.env.example documents VARANDA_PUSH_TOKEN')
  t.ok(seederExample.split('\n').some((l) => /^#VARANDA_ACCOUNT_HTTP=/.test(l)), 'seeder.env.example documents VARANDA_ACCOUNT_HTTP')

  const compose = fs.readFileSync(COMPOSE_WEB, 'utf8')
  for (const [file, text] of [['compose.web.yaml', compose], ['.env.example', example], ['seeder.env.example', seederExample]]) {
    t.absent(text.includes('VARANDA_VAPID'), 'no VARANDA_VAPID variable in ' + file)
  }
})

for (const name of ['VARANDA_MAX_MEMBERS', 'VARANDA_ACCOUNT_MAX_CONNECTIONS', 'VARANDA_ACCOUNT_RATE', 'VARANDA_ACCOUNT_BURST', 'VARANDA_ACCOUNT_MAX_PENDING', 'VARANDA_INVITES_PER_WEEK', 'VARANDA_INVITE_DROPS', 'VARANDA_FEIRA_INVITES_PER_WEEK', 'VARANDA_DIDIT_API_KEY', 'VARANDA_DIDIT_WORKFLOW_ID', 'VARANDA_DIDIT_DAILY_LIMIT', 'VARANDA_AGE_SINCE', 'VARANDA_PHONE_KEY', 'VARANDA_PHONE_DAILY_LIMIT', 'VARANDA_PHONE_REVIEW', 'VARANDA_AUDIUS_API_KEY', 'VARANDA_AUDIUS_API_URL', 'VARANDA_AUDIUS_APP_NAME', 'VARANDA_AUDIUS_MOMENTS', 'VARANDA_AUDIUS_COVERS', 'VARANDA_AUDIUS_STREAMS']) {
  test('compose.web.yaml: ' + name + ' is optional and only on the account service', (t) => {
    const webLines = fs.readFileSync(COMPOSE_WEB, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
    const hits = webLines.map((l, i) => [l, i]).filter(([l]) => l.includes(name))
    t.is(hits.length, 1, 'mentioned exactly once')
    const start = webLines.findIndex((l) => /^ {2}account:\s*$/.test(l))
    let end = webLines.length
    for (let i = start + 1; i < webLines.length; i++) {
      if (/^ {0,2}\S/.test(webLines[i])) { end = i; break }
    }
    t.ok(hits[0][1] > start && hits[0][1] < end, 'it sits under the account service')
    t.ok(new RegExp(name + ': "\\$\\{' + name + ':-\\}"').test(hits[0][0]), 'optional (:-), never :?')
  })
}

for (const name of SEEDER_LIMITS) {
  test('compose.web.yaml: ' + name + ' is optional and only on the seeder service', (t) => {
    const webLines = fs.readFileSync(COMPOSE_WEB, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
    const hits = webLines.map((l, i) => [l, i]).filter(([l]) => l.includes(name + ':') || l.includes('${' + name))
    t.is(hits.length, 1, 'mentioned exactly once')
    const start = webLines.findIndex((l) => /^ {2}seeder:\s*$/.test(l))
    let end = webLines.length
    for (let i = start + 1; i < webLines.length; i++) {
      if (/^ {0,2}\S/.test(webLines[i])) { end = i; break }
    }
    t.ok(hits[0][1] > start && hits[0][1] < end, 'it sits under the seeder service')
    t.is(hits[0][0].trim(), name + ': "${' + name + ':-' + (HOSTED_DEFAULTS[name] || '') + '}"', 'optional (:-), never :?, with the hosted default')
  })
}

test('compose.web.yaml: hosted seeder defaults, and the Caddy per-address /media limit stays at or below 25% of the media rate', (t) => {
  const compose = fs.readFileSync(COMPOSE_WEB, 'utf8')
  for (const [name, value] of Object.entries(HOSTED_DEFAULTS)) {
    t.ok(compose.includes(name + ': "${' + name + ':-' + value + '}"'), name + ' defaults to ' + value)
  }
  // Raised in the proportion of maxExternal (96 against the seeder's 32).
  t.is(Number(HOSTED_DEFAULTS.VARANDA_FRAME_MEMORY), 64 * 1024 * 1024 * (96 / 32), 'frame memory scales with maxExternal')
  t.ok(Number(HOSTED_DEFAULTS.VARANDA_MEDIA_BURST) >= Number(HOSTED_DEFAULTS.VARANDA_MEDIA_RATE), 'burst is not below the rate')
  t.ok(Number(HOSTED_DEFAULTS.VARANDA_INDEX_BURST) >= Number(HOSTED_DEFAULTS.VARANDA_INDEX_RATE), 'index burst is not below the rate')
  const example = fs.readFileSync(path.join(repoRoot, 'deploy/seeder/.env.example'), 'utf8').split('\n')
  for (const [name, value] of Object.entries(HOSTED_DEFAULTS)) {
    t.ok(example.includes('# ' + name + '=' + value), '.env.example documents ' + name + '=' + value)
  }
  // The one zone of /media/*: events per window, per client address.
  const caddy = fs.readFileSync(CADDYFILE, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  const start = caddy.indexOf('handle /media/* {')
  t.ok(start !== -1, 'handle /media/*')
  const media = caddy.slice(start, caddy.indexOf('\n\t}', start))
  const events = Number((media.match(/\bevents (\d+)/) || [])[1])
  const win = Number((media.match(/\bwindow (\d+)s\b/) || [])[1])
  t.ok(events > 0 && win > 0, 'the media zone has events and a window in seconds')
  const global = Number(HOSTED_DEFAULTS.VARANDA_MEDIA_RATE) * win
  t.ok(events <= global * 0.25, 'per-address ' + events + ' per ' + win + ' s is at most 25% of the global ' + global)
})

test('deploy.sh: conferir_antes rejects a bad or out-of-range seeder limit and accepts an .env without them', (t) => {
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    t.comment('bash not found: skipping the behavioural check')
    return
  }
  const src = fs.readFileSync(SCRIPT, 'utf8')
  const fn = src.match(/^conferir_antes\(\) \{\n[\s\S]*?^\}\n/m)
  // conferir_antes also reads the account limits table (limite_re,
  // limites_conta): the stub needs every top-level pattern it uses.
  const res = src.match(/^(domain_re|assoc_re|moderator_re|limite_re|limites_conta)=.*$/mg)
  t.ok(fn && res && res.length === 5, 'function and patterns located')
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'varanda-deploy-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'deploy/seeder'), { recursive: true })
  const envFile = path.join(dir, 'deploy/seeder/.env')
  const base = 'VARANDA_DOMAIN=app.exemplo.org\nVARANDA_ASSOCIATION=' + 'a'.repeat(64) +
    '\nVARANDA_GOOGLE_CLIENT_ID=id\nVARANDA_GOOGLE_CLIENT_SECRET=segredo-ultra\n'
  const run = (extra) => {
    fs.writeFileSync(envFile, base + extra)
    // git is stubbed: only the .env checks run, nothing touches a repository.
    const script = 'set -u\nroot=' + JSON.stringify(dir) + '\ntarget=x\n' + res.join('\n') + '\n' +
      'log() { printf "%s\\n" "$*" >&2; }\ngit() { return 0; }\n' + SOURCE_WELL_KNOWN + fn[0] + 'conferir_antes\n'
    return spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  }
  const ok = run('')
  t.is(ok.status, 0, 'an .env without the lines passes: ' + ok.stderr)
  const empty = run(SEEDER_LIMITS.map((n) => n + '=\n').join(''))
  t.is(empty.status, 0, 'empty lines pass: ' + empty.stderr)
  const good = run('VARANDA_MAX_EXTERNAL=300\nVARANDA_FRAME_MEMORY=268435456\n')
  t.is(good.status, 0, 'integers pass: ' + good.stderr)
  const bad = run('VARANDA_MAX_EXTERNAL=abc\n')
  t.is(bad.status, 1, 'a non-integer is refused')
  t.ok(bad.stderr.includes('VARANDA_MAX_EXTERNAL inválido em deploy/seeder/.env'), 'says which variable')
  t.absent(bad.stderr.includes('abc'), 'the value is not printed')
  const big = run('VARANDA_MEDIA_RATE=12345678\n')
  t.is(big.status, 1, 'eight digits are refused')
  const mem = run('VARANDA_FRAME_MEMORY=0268435456\n')
  t.is(mem.status, 1, 'a leading zero is refused')
  // The range is checked too: the seeder would exit 2 on these after the swap.
  const over = run('VARANDA_MAX_EXTERNAL=4097\n')
  t.is(over.status, 1, 'VARANDA_MAX_EXTERNAL above 4096 is refused')
  t.ok(over.stderr.includes('VARANDA_MAX_EXTERNAL inválido em deploy/seeder/.env'), 'says which variable (range)')
  t.absent(over.stderr.includes('4097'), 'the out-of-range value is not printed')
  t.is(run('VARANDA_MAX_EXTERNAL=4096\n').status, 0, 'VARANDA_MAX_EXTERNAL=4096 passes')
  t.is(run('VARANDA_FRAME_MEMORY=8454143\n').status, 1, 'VARANDA_FRAME_MEMORY below 8454144 is refused')
  t.is(run('VARANDA_FRAME_MEMORY=8454144\n').status, 0, 'VARANDA_FRAME_MEMORY=8454144 passes')
  t.is(run('VARANDA_MEDIA_MAX_IN_FLIGHT=1025\n').status, 1, 'VARANDA_MEDIA_MAX_IN_FLIGHT above 1024 is refused')
  // VARANDA_STORAGE_BYTES needs 16 digits; 64-bit bash compares them exactly.
  t.is(run('VARANDA_STORAGE_BYTES=1073741823\n').status, 1, 'VARANDA_STORAGE_BYTES below 1 GiB is refused')
  t.is(run('VARANDA_STORAGE_BYTES=1073741824\n').status, 0, 'VARANDA_STORAGE_BYTES=1073741824 passes')
  t.is(run('VARANDA_STORAGE_BYTES=1125899906842624\n').status, 0, 'VARANDA_STORAGE_BYTES at 1 PiB (16 digits) passes')
  t.is(run('VARANDA_STORAGE_BYTES=1125899906842625\n').status, 1, 'VARANDA_STORAGE_BYTES above 1 PiB is refused')
  t.is(run('VARANDA_STORAGE_BYTES=11258999068426240\n').status, 1, '17 digits are refused')
  t.is(run('VARANDA_STORAGE_BYTES=01073741824\n').status, 1, 'a leading zero is refused')
  t.is(run('VARANDA_MAX_EXTERNAL=0000000000000300\n').status, 1, 'a zero-padded 16-digit value is refused')
  // Compose passes a quoted value verbatim (comment included), so a quoted
  // value is refused instead of being cleaned up here; an unquoted trailing
  // comment is dropped by Compose and here alike.
  t.is(run('VARANDA_MAX_EXTERNAL="300 # vagas"\n').status, 1, 'a quoted value with a comment is refused')
  t.is(run("VARANDA_MAX_EXTERNAL='300'\n").status, 1, 'a quoted value is refused')
  t.is(run('VARANDA_MAX_EXTERNAL=300 # vagas\n').status, 0, 'an unquoted value with a trailing comment passes')
  t.is(run('VARANDA_MAX_EXTERNAL = 4097\n').status, 1, 'spaces around = do not hide an out-of-range value')
})

test('deploy.sh: conferir_antes checks VARANDA_STATS_EMAILS against the moderators and VARANDA_SEEDER_HEALTH stays on loopback', (t) => {
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    t.comment('bash not found: skipping the behavioural check')
    return
  }
  const src = fs.readFileSync(SCRIPT, 'utf8')
  const fn = src.match(/^conferir_antes\(\) \{\n[\s\S]*?^\}\n/m)
  const res = src.match(/^(domain_re|assoc_re|moderator_re|limite_re|limites_conta)=.*$/mg)
  t.ok(fn && res && res.length === 5, 'function and patterns located')
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'varanda-deploy-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'deploy/seeder'), { recursive: true })
  const envFile = path.join(dir, 'deploy/seeder/.env')
  const base = 'VARANDA_DOMAIN=app.exemplo.org\nVARANDA_ASSOCIATION=' + 'a'.repeat(64) +
    '\nVARANDA_GOOGLE_CLIENT_ID=id\nVARANDA_GOOGLE_CLIENT_SECRET=segredo-ultra\n' +
    'VARANDA_MODERATOR_EMAILS=Mod@x.test,b@x.test\n'
  const run = (extra) => {
    fs.writeFileSync(envFile, base + extra)
    // git is stubbed: only the .env checks run, nothing touches a repository.
    const script = 'set -u\nroot=' + JSON.stringify(dir) + '\ntarget=x\n' + res.join('\n') + '\n' +
      'log() { printf "%s\\n" "$*" >&2; }\ngit() { return 0; }\n' + SOURCE_WELL_KNOWN + fn[0] + 'conferir_antes\n'
    return spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  }
  const none = run('')
  t.is(none.status, 0, 'an .env without the stats line passes: ' + none.stderr)
  const empty = run('VARANDA_STATS_EMAILS=\n')
  t.is(empty.status, 0, 'an empty stats line passes: ' + empty.stderr)
  const subset = run('VARANDA_STATS_EMAILS=mod@x.test\n')
  t.is(subset.status, 0, 'a moderator passes, case-insensitively: ' + subset.stderr)
  const outsider = run('VARANDA_STATS_EMAILS=c@x.test\n')
  t.is(outsider.status, 1, 'an e-mail that is not a moderator is refused')
  t.ok(outsider.stderr.includes('VARANDA_STATS_EMAILS inválido em deploy/seeder/.env'), 'says which variable')
  t.absent(outsider.stderr.includes('c@x.test'), 'the e-mail is not printed')
  t.is(run('VARANDA_STATS_EMAILS=sem-arroba\n').status, 1, 'an item without @ is refused')
  // Only a whole list item matches: a moderator's suffix is not a moderator.
  t.is(run('VARANDA_STATS_EMAILS=od@x.test\n').status, 1, 'a partial match is refused')

  const remote = run('VARANDA_STATS_EMAILS=mod@x.test\nVARANDA_SEEDER_HEALTH=http://10.0.0.1:8788\n')
  t.is(remote.status, 1, 'a non-loopback seeder health URL is refused with stats on')
  t.ok(remote.stderr.includes('VARANDA_SEEDER_HEALTH inválido em deploy/seeder/.env'), 'says which variable (health)')
  t.absent(remote.stderr.includes('10.0.0.1'), 'the URL is not printed')
  const loop = run('VARANDA_STATS_EMAILS=mod@x.test\nVARANDA_SEEDER_HEALTH=http://127.0.0.1:8788\n')
  t.is(loop.status, 0, 'the loopback health URL passes: ' + loop.stderr)
  t.is(run('VARANDA_STATS_EMAILS=mod@x.test\nVARANDA_SEEDER_HEALTH=http://127.0.0.1:65536\n').status, 1, 'a port above 65535 is refused')
  const off = run('VARANDA_SEEDER_HEALTH=http://10.0.0.1:8788\n')
  t.is(off.status, 0, 'with stats off the health URL is not read: ' + off.stderr)
  // Compose applies a line with spaces around '=' and passes quotes through
  // to the service, which would refuse them: the gate reads and refuses alike.
  t.is(run('VARANDA_STATS_EMAILS = c@x.test\n').status, 1, 'spaces around = do not hide an outsider')
  t.is(run('VARANDA_STATS_EMAILS="mod@x.test"\n').status, 1, 'a quoted stats list is refused')
  // The subset check reads the moderator line Compose applies (the last one,
  // spaces around '=' allowed), not an earlier unspaced line.
  t.is(run('VARANDA_MODERATOR_EMAILS = mod@x.test\nVARANDA_STATS_EMAILS=mod@x.test\n').status, 0,
    'a spaced moderator line still counts for the subset check')
  t.is(run('VARANDA_MODERATOR_EMAILS = outra@x.test\nVARANDA_STATS_EMAILS=mod@x.test\n').status, 1,
    'a later spaced moderator line overrides the earlier one')
  t.is(run('VARANDA_STATS_EMAILS=mod@x.test\nVARANDA_SEEDER_HEALTH = http://10.0.0.1:8788\n').status, 1,
    'spaces around = do not hide a remote health URL')
  t.is(run('VARANDA_STATS_EMAILS=mod@x.test\nVARANDA_SEEDER_HEALTH="http://127.0.0.1:8788"\n').status, 1,
    'a quoted health URL is refused')
})

// Native passkeys: the OS only offers the domain's passkey to the app the
// domain declares under /.well-known. Values are fake on purpose.
const FAKE_CERT = Array(32).fill('0A').join(':')
const FAKE_CERT_2 = Array(32).fill('0B').join(':')
const FAKE_IOS = 'ABCDE12345.app.varanda'

function hasBash (t) {
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    t.comment('bash not found: skipping the behavioural check')
    return false
  }
  return true
}

const ASSOC_BASE_ENV = 'VARANDA_DOMAIN=app.exemplo.org\nVARANDA_ASSOCIATION=' + 'a'.repeat(64) +
  '\nVARANDA_GOOGLE_CLIENT_ID=id\nVARANDA_GOOGLE_CLIENT_SECRET=segredo-ultra\n'

const ASSOC_BAD = [
  ['VARANDA_ANDROID_CERT_SHA256', FAKE_CERT.toLowerCase()],
  ['VARANDA_ANDROID_CERT_SHA256', FAKE_CERT.slice(3)],
  ['VARANDA_ANDROID_CERT_SHA256', FAKE_CERT.replace(/:/g, '')],
  ['VARANDA_ANDROID_CERT_SHA256', FAKE_CERT + '"],"x":["'],
  ['VARANDA_ANDROID_CERT_SHA256', ',' + FAKE_CERT],
  ['VARANDA_ANDROID_CERT_SHA256', FAKE_CERT + ','],
  ['VARANDA_ANDROID_CERT_SHA256', FAKE_CERT + ',,' + FAKE_CERT_2],
  ['VARANDA_ANDROID_CERT_SHA256', FAKE_CERT + ', ' + FAKE_CERT_2],
  ['VARANDA_ANDROID_CERT_SHA256', FAKE_CERT + ',' + FAKE_CERT_2.toLowerCase()],
  ['VARANDA_ANDROID_CERT_SHA256', FAKE_CERT + ',' + FAKE_CERT_2 + ',' + FAKE_CERT],
  ['VARANDA_ANDROID_CERT_SHA256', FAKE_CERT + ',' + FAKE_CERT],
  ['VARANDA_ANDROID_CERT_SHA256', ['0A', '0B', '0C', '0D', '0E'].map((b) => Array(32).fill(b).join(':')).join(',')],
  ['VARANDA_ANDROID_CERT_SHA256', FAKE_CERT + ',' + FAKE_CERT_2 + '"],"x":["'],
  ['VARANDA_IOS_APP_ID', 'abcde12345.app.varanda'],
  ['VARANDA_IOS_APP_ID', 'ABCDE1234.app.varanda'],
  ['VARANDA_IOS_APP_ID', 'ABCDE12345.app.varanda.debug'],
  ['VARANDA_IOS_APP_ID', 'ABCDE12345xapp.varanda']
]

function checkAssocShapes (t, wk) {
  t.alike(JSON.parse(fs.readFileSync(path.join(wk, 'assetlinks.json'), 'utf8')), [{
    relation: ['delegate_permission/common.get_login_creds', 'delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: 'app.varanda', sha256_cert_fingerprints: [FAKE_CERT] }
  }], 'assetlinks.json shape (handle_all_urls for the Auth Tab return)')
  t.alike(JSON.parse(fs.readFileSync(path.join(wk, 'apple-app-site-association'), 'utf8')),
    {
      webcredentials: { apps: [FAKE_IOS] },
      applinks: { apps: [], details: [{ appIDs: [FAKE_IOS], components: [{ '/': '/anuncio/*' }, { '/': '/publicacao/*' }, { '/': '/@*' }, { '/': '/m/*' }] }] }
    }, 'apple-app-site-association shape (applinks for /anuncio/, /publicacao/, /@ and /m/ only)')
}

// Written exactly so a single certificate keeps the bytes an installation
// already serves.
function assetlinksBytes (...certs) {
  return '[{"relation":["delegate_permission/common.get_login_creds","delegate_permission/common.handle_all_urls"],' +
    '"target":{"namespace":"android_app","package_name":"app.varanda","sha256_cert_fingerprints":["' + certs.join('","') + '"]}}]\n'
}

// A temporary root with deploy/seeder/.env and a www holding the SPA.
function assocFixture (t) {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'varanda-deploy-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'deploy/seeder'), { recursive: true })
  const www = path.join(dir, 'www')
  fs.mkdirSync(www, { recursive: true })
  fs.writeFileSync(path.join(www, 'index.html'), 'app')
  return { dir, www, wk: path.join(www, '.well-known'), envFile: path.join(dir, 'deploy/seeder/.env') }
}

test('deploy.sh: native app associations are validated and rendered into www', (t) => {
  if (!hasBash(t)) return
  const src = fs.readFileSync(SCRIPT, 'utf8')
  const fn = src.match(/^conferir_antes\(\) \{\n[\s\S]*?^\}\n/m)
  const pub = src.match(/^publicar_associacoes\(\) \{\n[\s\S]*?^\}\n/m)
  const res = src.match(/^(domain_re|assoc_re|moderator_re|limite_re|limites_conta)=.*$/mg)
  t.ok(fn && pub && res && res.length === 5, 'functions and patterns located')
  const { dir, www, wk, envFile } = assocFixture(t)
  const run = (extra) => {
    fs.writeFileSync(envFile, ASSOC_BASE_ENV + extra)
    const script = 'set -Eeuo pipefail\nroot=' + JSON.stringify(dir) + '\nwww=' + JSON.stringify(www) +
      '\ntarget=x\n' + res.join('\n') + '\n' +
      'log() { printf "%s\\n" "$*" >&2; }\ngit() { return 0; }\n' + SOURCE_WELL_KNOWN + fn[0] + pub[0] +
      'conferir_antes\npublicar_associacoes\n'
    return spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  }
  const exists = (name) => fs.existsSync(path.join(wk, name))

  const none = run('')
  t.is(none.status, 0, 'an .env without the lines passes: ' + none.stderr)
  t.absent(fs.existsSync(wk), 'no association file and no empty .well-known')
  t.ok(fs.existsSync(path.join(www, 'index.html')), 'the SPA is untouched')
  t.ok(none.stderr.includes('aviso: VARANDA_ANDROID_CERT_SHA256 vazio'), 'warns that Android sign-in is off')
  t.ok(none.stderr.includes('aviso: VARANDA_IOS_APP_ID vazio'), 'warns that iOS sign-in is off')

  const both = run('VARANDA_ANDROID_CERT_SHA256=' + FAKE_CERT + '\nVARANDA_IOS_APP_ID=' + FAKE_IOS + '\n')
  t.is(both.status, 0, 'well-formed values pass: ' + both.stderr)
  checkAssocShapes(t, wk)
  t.is(fs.readFileSync(path.join(wk, 'assetlinks.json'), 'utf8'), assetlinksBytes(FAKE_CERT), 'one certificate: the bytes do not change')
  t.absent(both.stderr.includes('aviso'), 'no warning with both set')
  t.alike(fs.readdirSync(wk).sort(), ['apple-app-site-association', 'assetlinks.json'], 'no temporary file left')

  // Play's app signing certificate and the EAS keystore's, at the same time.
  const two = run('VARANDA_ANDROID_CERT_SHA256=' + FAKE_CERT + ',' + FAKE_CERT_2 + '\nVARANDA_IOS_APP_ID=' + FAKE_IOS + '\n')
  t.is(two.status, 0, 'two certificates pass: ' + two.stderr)
  t.alike(JSON.parse(fs.readFileSync(path.join(wk, 'assetlinks.json'), 'utf8'))[0].target.sha256_cert_fingerprints, [FAKE_CERT, FAKE_CERT_2], 'both, in order')
  t.is(fs.readFileSync(path.join(wk, 'assetlinks.json'), 'utf8'), assetlinksBytes(FAKE_CERT, FAKE_CERT_2), 'two certificates: exact bytes')
  const four = ['0A', '0B', '0C', '0D'].map((b) => Array(32).fill(b).join(':'))
  const max = run('VARANDA_ANDROID_CERT_SHA256=' + four.join(',') + '\nVARANDA_IOS_APP_ID=' + FAKE_IOS + '\n')
  t.is(max.status, 0, 'four certificates pass: ' + max.stderr)
  t.alike(JSON.parse(fs.readFileSync(path.join(wk, 'assetlinks.json'), 'utf8'))[0].target.sha256_cert_fingerprints, four, 'all four, in order')
  for (const wrapped of ['"' + FAKE_CERT + ',' + FAKE_CERT_2 + '"', "'" + FAKE_CERT + ',' + FAKE_CERT_2 + "' # Play, EAS"]) {
    const quoted = run('VARANDA_ANDROID_CERT_SHA256=' + wrapped + '\nVARANDA_IOS_APP_ID=' + FAKE_IOS + '\n')
    t.is(quoted.status, 0, 'one pair of quotes around the whole list still passes: ' + quoted.stderr)
    t.is(fs.readFileSync(path.join(wk, 'assetlinks.json'), 'utf8'), assetlinksBytes(FAKE_CERT, FAKE_CERT_2), 'the same bytes as unquoted')
  }

  // A file left by an earlier deploy goes away when its variable is emptied.
  const androidOnly = run('VARANDA_ANDROID_CERT_SHA256=' + FAKE_CERT + '\nVARANDA_IOS_APP_ID=\n')
  t.is(androidOnly.status, 0, 'Android only passes: ' + androidOnly.stderr)
  t.ok(exists('assetlinks.json'), 'assetlinks.json kept')
  t.absent(exists('apple-app-site-association'), 'apple-app-site-association removed')
  t.ok(androidOnly.stderr.includes('aviso: VARANDA_IOS_APP_ID vazio'), 'warns that iOS sign-in is off')
  t.is(run('').status, 0, 'emptying both passes')
  t.absent(fs.existsSync(wk), 'both files removed')

  for (const [name, value] of ASSOC_BAD) {
    const r = run(name + '=' + value + '\n')
    t.is(r.status, 1, name + ' malformed is refused: ' + value)
    t.ok(r.stderr.includes(name + ' inválido em deploy/seeder/.env'), 'says which variable')
    t.absent(r.stderr.includes(value) || r.stderr.includes('0A:0A') || r.stderr.includes('0a:0a'), 'the value is not printed')
  }
})

// One table for both readers of VARANDA_ANDROID_CERT_SHA256: well-known.sh
// publishes the list in assetlinks.json and the account service turns it into
// passkey origins (../lib/account/webauthn.js parseAndroidCerts), so a value
// one of them takes and the other refuses would split sign-in from deletion.
// Only strings the .env reader passes as written: it drops CR, outer spaces,
// a trailing comment and one pair of quotes around the whole value before
// checking; quotes left inside the list are refused.
// The React Native debug keystore committed with the app: its private key is
// public, so it never goes in.
const DEBUG_CERT = 'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C'
const CERT_LIST_OK = [
  ['empty: Android sign-in off', '', []],
  ['one', FAKE_CERT, [FAKE_CERT]],
  ['two, in order', FAKE_CERT_2 + ',' + FAKE_CERT, [FAKE_CERT_2, FAKE_CERT]],
  ['four, the cap', ['0A', '0B', '0C', '0D'].map((b) => Array(32).fill(b).join(':')).join(','), ['0A', '0B', '0C', '0D'].map((b) => Array(32).fill(b).join(':'))]
]
const CERT_LIST_BAD = [
  ['five', ['0A', '0B', '0C', '0D', '0E'].map((b) => Array(32).fill(b).join(':')).join(',')],
  ['a duplicate', FAKE_CERT + ',' + FAKE_CERT],
  ['a later duplicate', FAKE_CERT + ',' + FAKE_CERT_2 + ',' + FAKE_CERT],
  ['a leading empty item', ',' + FAKE_CERT],
  ['a trailing empty item', FAKE_CERT + ','],
  ['an empty item between', FAKE_CERT + ',,' + FAKE_CERT_2],
  ['only a comma', ','],
  ['an inner space', FAKE_CERT + ', ' + FAKE_CERT_2],
  ['quotes around each item', '"' + FAKE_CERT + '","' + FAKE_CERT_2 + '"'],
  ['single quotes around each item', "'" + FAKE_CERT + "','" + FAKE_CERT_2 + "'"],
  ['a quote inside the list', '"' + FAKE_CERT + ',' + FAKE_CERT_2],
  ['a space inside a fingerprint', FAKE_CERT.replace(':', ': ')],
  ['lowercase', FAKE_CERT.toLowerCase()],
  ['a lowercase second item', FAKE_CERT + ',' + FAKE_CERT_2.toLowerCase()],
  ['a short fingerprint', FAKE_CERT.slice(3)],
  ['a long fingerprint', FAKE_CERT + ':0A'],
  ['no colons', FAKE_CERT.replace(/:/g, '')],
  ['a semicolon separator', FAKE_CERT + ';' + FAKE_CERT_2],
  ['JSON after the list', FAKE_CERT + '],x:['],
  ['the public debug key', DEBUG_CERT],
  ['the public debug key in a list', FAKE_CERT + ',' + DEBUG_CERT + ',' + FAKE_CERT_2]
]

test('well-known.sh and the account service agree on VARANDA_ANDROID_CERT_SHA256', (t) => {
  if (!hasBash(t)) return
  const { parseAndroidCerts } = require('../lib/account/webauthn')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-certs-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const envFile = path.join(dir, '.env')
  const shell = (value) => {
    fs.writeFileSync(envFile, 'VARANDA_ANDROID_CERT_SHA256=' + value + '\n')
    return spawnSync('bash', ['-c', 'set -Eeuo pipefail\nlog() { printf "%s\\n" "$*" >&2; }\n' + SOURCE_WELL_KNOWN +
      'ler_associacoes ' + JSON.stringify(envFile) + '\nprintf "%s" "$android_cert"\n'], { encoding: 'utf8' })
  }
  for (const [label, value, certs] of CERT_LIST_OK) {
    t.alike(parseAndroidCerts(value), certs, label + ': the service takes it')
    const r = shell(value)
    t.is(r.status, 0, label + ': well-known.sh takes it: ' + r.stderr)
    t.alike(r.stdout === '' ? [] : r.stdout.split(','), certs, label + ': the same list')
  }
  for (const [label, value] of CERT_LIST_BAD) {
    t.exception.all(() => parseAndroidCerts(value), /^TypeError: invalid android certificate fingerprint$/, label + ': the service refuses it')
    const r = shell(value)
    t.is(r.status, 1, label + ': well-known.sh refuses it')
    t.ok(r.stderr.includes('VARANDA_ANDROID_CERT_SHA256 inválido em deploy/seeder/.env'), label + ': names the variable')
    t.absent((value.length > 2 && r.stderr.includes(value)) || /0A:0A|0a:0a|0A0A|FA:C6/.test(r.stderr), label + ': never prints the value')
    t.is(r.stdout, '', label + ': nothing read')
  }
})

// A config-only change (certificate rotation, or switching a platform off)
// must take effect on a rerun of the same commit, which skips the rebuild.
test('deploy.sh: the already-deployed path refreshes the association files', (t) => {
  if (!hasBash(t)) return
  const src = fs.readFileSync(SCRIPT, 'utf8')
  const fn = src.match(/^conferir_antes\(\) \{\n[\s\S]*?^\}\n/m)
  const pub = src.match(/^publicar_associacoes\(\) \{\n[\s\S]*?^\}\n/m)
  const early = src.match(/^ {2}if \[ "\$sem_registro" = 0 \] && \[ "\$previous" = "\$target" \][\s\S]*?^ {2}fi\n/m)
  const res = src.match(/^(domain_re|assoc_re|moderator_re|limite_re|limites_conta)=.*$/mg)
  t.ok(fn && pub && early && res && res.length === 5, 'functions, early-exit block and patterns located')
  const mainFn = src.slice(src.indexOf('\nmain() {'))
  t.ok(mainFn.indexOf('\n  conferir_antes\n') !== -1 && mainFn.indexOf('\n  conferir_antes\n') < mainFn.indexOf(early[0]),
    'conferir_antes runs before the early exit')
  t.ok(early[0].indexOf('publicar_associacoes') < early[0].indexOf('exit 0'), 'refreshed before the early exit 0')
  const { dir, www, wk, envFile } = assocFixture(t)
  const run = (extra) => {
    fs.writeFileSync(envFile, ASSOC_BASE_ENV + extra)
    const script = 'set -Eeuo pipefail\nroot=' + JSON.stringify(dir) + '\nwww=' + JSON.stringify(www) +
      '\ntarget=x\nprevious=x\nsem_registro=0\n' + res.join('\n') + '\n' +
      'log() { printf "%s\\n" "$*" >&2; }\n' +
      'git() { if [ "$1" = rev-parse ]; then echo x; fi; return 0; }\n' +
      'verificar_saude() { return 0; }\nweb_com_env_atual() { return 0; }\n' + SOURCE_WELL_KNOWN + fn[0] + pub[0] +
      'conferir_antes\n' + early[0] + 'echo "fell through" >&2\nexit 9\n'
    return spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  }
  const set = run('VARANDA_ANDROID_CERT_SHA256=' + FAKE_CERT + '\nVARANDA_IOS_APP_ID=' + FAKE_IOS + '\n')
  t.is(set.status, 0, 'already deployed and healthy exits 0: ' + set.stderr)
  checkAssocShapes(t, wk)
  const bad = run('VARANDA_ANDROID_CERT_SHA256=00\nVARANDA_IOS_APP_ID=\n')
  t.is(bad.status, 1, 'a malformed value refuses the rerun')
  t.ok(fs.existsSync(path.join(wk, 'apple-app-site-association')), 'a refused run leaves the files alone')
  const off = run('')
  t.is(off.status, 0, 'clearing both on the same commit exits 0: ' + off.stderr)
  t.absent(fs.existsSync(wk), 'both files removed without a new commit')
})

// The Caddy reads VARANDA_TRUSTED_PROXIES and VARANDA_MEDIA_ORIGIN only when it
// starts, and a rerun of the same commit starts nothing: when the running web
// container disagrees with .env, the early path recreates it (and probes again).
test('deploy.sh: the already-deployed path recreates the web container when its proxies or media origin differ from .env', (t) => {
  if (!hasBash(t)) return
  const src = fs.readFileSync(SCRIPT, 'utf8')
  const web = src.match(/^web_com_env_atual\(\) \{\n[\s\S]*?^\}\n/m)
  const cid = src.match(/^conteiner_caddy\(\) \{\n[\s\S]*?^\}\n/m)
  const early = src.match(/^ {2}if \[ "\$sem_registro" = 0 \] && \[ "\$previous" = "\$target" \][\s\S]*?^ {2}fi\n/m)
  t.ok(web && cid && early, 'functions and early-exit block located')
  t.ok(early[0].indexOf('web_com_env_atual') < early[0].indexOf('publicar_associacoes') && early[0].includes('compose up -d --force-recreate --no-deps web'),
    'the web is recreated, as for a Caddyfile change, before the association refresh')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-web-env-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const envFile = path.join(dir, 'container.env')
  const calls = path.join(dir, 'calls')
  const container = path.join(dir, 'container')
  // docker ps prints the container id (when there is one); docker inspect prints
  // its environment, one NAME=value per line, as the real --format does.
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\n' +
    'case "$1" in\n' +
    '  ps) [ -f ' + JSON.stringify(container) + ' ] && echo abc123 ;;\n' +
    '  inspect) [ "$4" = abc123 ] && cat ' + JSON.stringify(envFile) + ' ;;\n' +
    'esac\nexit 0\n', { mode: 0o755 })
  const PATH_ENV = { ...process.env, PATH: bin + path.delimiter + process.env.PATH }
  const NET = 'PATH=/usr/bin:/bin\nHOME=/root\n'
  const run = ({ running, proxies, media, hasContainer = true, composeFails = false, healthyAfter = true }) => {
    fs.writeFileSync(envFile, NET + running)
    fs.rmSync(container, { force: true })
    if (hasContainer) fs.writeFileSync(container, '')
    fs.rmSync(calls, { force: true })
    const script = 'set -Eeuo pipefail\ntarget=x\nprevious=x\nsem_registro=0\n' +
      'trusted_proxies=' + JSON.stringify(proxies) + '\nmedia_origin=' + JSON.stringify(media) + '\n' +
      'log() { printf "%s\\n" "$*" >&2; }\n' +
      'git() { if [ "$1" = rev-parse ]; then echo x; fi; return 0; }\n' +
      'saude=0\nverificar_saude() { saude=$((saude + 1)); if [ "$saude" -gt 1 ] && [ ' + (healthyAfter ? 0 : 1) + ' = 1 ]; then return 1; fi; return 0; }\n' +
      'compose() { echo "compose $*" >> ' + JSON.stringify(calls) + '; ' + (composeFails ? 'return 1' : 'return 0') + '; }\n' +
      'publicar_associacoes() { echo associacoes >> ' + JSON.stringify(calls) + '; return 0; }\n' +
      cid[0] + web[0] + early[0] + 'echo "fell through" >&2\nexit 9\n'
    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: PATH_ENV })
    return { ...res, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' }
  }
  const RECREATE = 'compose up -d --force-recreate --no-deps web\n'
  const same = run({ running: '', proxies: '', media: '' })
  t.is(same.status, 0, 'both empty on both sides: exits 0: ' + same.stderr)
  t.is(same.calls, 'associacoes\n', 'nothing recreated')
  const both = run({ running: 'VARANDA_TRUSTED_PROXIES=203.0.113.0/24 2001:db8::/32\nVARANDA_MEDIA_ORIGIN=https://midia.exemplo.org\n', proxies: '203.0.113.0/24 2001:db8::/32', media: 'https://midia.exemplo.org' })
  t.is(both.status, 0, 'both set and equal: exits 0: ' + both.stderr)
  t.is(both.calls, 'associacoes\n', 'nothing recreated')
  t.is(run({ running: 'VARANDA_TRUSTED_PROXIES=\nVARANDA_MEDIA_ORIGIN=\n', proxies: '', media: '' }).calls, 'associacoes\n', 'empty values in the container equal an empty .env')
  for (const [label, args] of [
    ['proxies added in .env', { running: '', proxies: '203.0.113.0/24', media: '' }],
    ['proxies changed in .env', { running: 'VARANDA_TRUSTED_PROXIES=203.0.113.0/24\n', proxies: '198.51.100.0/24', media: '' }],
    ['proxies removed from .env', { running: 'VARANDA_TRUSTED_PROXIES=203.0.113.0/24\n', proxies: '', media: '' }],
    ['media origin added in .env', { running: 'VARANDA_TRUSTED_PROXIES=203.0.113.0/24\n', proxies: '203.0.113.0/24', media: 'https://midia.exemplo.org' }],
    ['media origin changed in .env', { running: 'VARANDA_TRUSTED_PROXIES=203.0.113.0/24\nVARANDA_MEDIA_ORIGIN=https://a.exemplo.org\n', proxies: '203.0.113.0/24', media: 'https://b.exemplo.org' }],
    ['media origin removed from .env', { running: 'VARANDA_MEDIA_ORIGIN=https://a.exemplo.org\n', proxies: '', media: '' }],
    ['no web container', { running: '', proxies: '', media: '', hasContainer: false }]
  ]) {
    const r = run(args)
    t.is(r.status, 0, label + ': exits 0: ' + r.stderr)
    t.is(r.calls, RECREATE + 'associacoes\n', label + ': the web is recreated, then the associations refreshed')
    t.ok(r.stderr.includes('recriando o web'), label + ': says so')
  }
  const failedUp = run({ running: '', proxies: '203.0.113.0/24', media: '', composeFails: true })
  t.is(failedUp.status, 1, 'a failing recreate fails the run')
  t.absent(failedUp.calls.includes('associacoes') || failedUp.stderr.includes('fell through'), 'and nothing else is refreshed')
  const unhealthy = run({ running: '', proxies: '203.0.113.0/24', media: '', healthyAfter: false })
  t.is(unhealthy.status, 1, 'a recreated web that fails the probe fails the run')
  t.ok(unhealthy.stderr.includes('não passou na verificação de saúde'), 'and says so')
  t.absent(unhealthy.calls.includes('associacoes'), 'without refreshing the associations')
})

// The update is all-or-nothing: a failing second write (disk full, say) must
// leave the published files byte-identical, clean its temporaries and fail
// with a message that does not claim nothing was attempted.
test('deploy.sh: a failing association write leaves the published files untouched', (t) => {
  if (!hasBash(t)) return
  const src = fs.readFileSync(SCRIPT, 'utf8')
  const fn = src.match(/^conferir_antes\(\) \{\n[\s\S]*?^\}\n/m)
  const pub = src.match(/^publicar_associacoes\(\) \{\n[\s\S]*?^\}\n/m)
  const early = src.match(/^ {2}if \[ "\$sem_registro" = 0 \] && \[ "\$previous" = "\$target" \][\s\S]*?^ {2}fi\n/m)
  const res = src.match(/^(domain_re|assoc_re|moderator_re|limite_re|limites_conta)=.*$/mg)
  t.ok(fn && pub && early && res && res.length === 5, 'functions, early-exit block and patterns located')
  const { dir, www, wk, envFile } = assocFixture(t)
  const OLD_CERT = Array(32).fill('0B').join(':')
  const OLD_IOS = 'ZZZZZ99999.app.varanda'
  // The step after writing a temporary file fails for this one (a full disk
  // would fail the write itself), once the earlier ones were written.
  let failing = null
  const run = (extra) => {
    fs.writeFileSync(envFile, ASSOC_BASE_ENV + extra)
    const script = 'set -Eeuo pipefail\nroot=' + JSON.stringify(dir) + '\nwww=' + JSON.stringify(www) +
      '\ntarget=x\nprevious=x\nsem_registro=0\n' + res.join('\n') + '\n' +
      'log() { printf "%s\\n" "$*" >&2; }\n' +
      'git() { if [ "$1" = rev-parse ]; then echo x; fi; return 0; }\n' +
      'verificar_saude() { return 0; }\nweb_com_env_atual() { return 0; }\n' +
      (failing === null ? '' : 'chmod() { if [ "$2" = ' + JSON.stringify(failing) + ' ]; then return 1; fi; command chmod "$@"; }\n') +
      'erro_antes() { echo "nada foi alterado" >&2; exit 1; }\ntrap erro_antes ERR\n' +
      SOURCE_WELL_KNOWN + fn[0] + pub[0] +
      'conferir_antes\n' + early[0] + 'echo "fell through" >&2\nexit 9\n'
    return spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  }
  const first = run('VARANDA_ANDROID_CERT_SHA256=' + OLD_CERT + '\nVARANDA_IOS_APP_ID=' + OLD_IOS + '\n')
  t.is(first.status, 0, 'the previous files are published: ' + first.stderr)
  const before = {
    android: fs.readFileSync(path.join(wk, 'assetlinks.json')),
    ios: fs.readFileSync(path.join(wk, 'apple-app-site-association'))
  }
  failing = path.join(wk, 'apple-app-site-association.tmp')
  for (const [label, extra] of [
    ['both changed', 'VARANDA_ANDROID_CERT_SHA256=' + FAKE_CERT + '\nVARANDA_IOS_APP_ID=' + FAKE_IOS + '\n'],
    ['iOS changed, Android cleared', 'VARANDA_ANDROID_CERT_SHA256=\nVARANDA_IOS_APP_ID=' + FAKE_IOS + '\n']
  ]) {
    const r = run(extra)
    t.is(r.status, 1, label + ': the run fails')
    t.ok(r.stderr.includes('as anteriores ficaram como estavam'), label + ': says the previous files were kept')
    t.ok(r.stderr.includes('associações do app nativo não foram atualizadas'), label + ': the deploy says so')
    t.absent(r.stderr.includes('nada foi alterado') || r.stderr.includes('fell through'), label + ': no misleading message')
    t.alike(fs.readFileSync(path.join(wk, 'assetlinks.json')), before.android, label + ': assetlinks.json byte-identical')
    t.alike(fs.readFileSync(path.join(wk, 'apple-app-site-association')), before.ios, label + ': apple-app-site-association byte-identical')
    t.absent(fs.existsSync(path.join(wk, 'assetlinks.json.tmp')), label + ': no temporary file left')
  }
  failing = null
  const ok = run('VARANDA_ANDROID_CERT_SHA256=' + FAKE_CERT + '\nVARANDA_IOS_APP_ID=' + FAKE_IOS + '\n')
  t.is(ok.status, 0, 'once writable again the update goes through: ' + ok.stderr)
  checkAssocShapes(t, wk)
})

// /.well-known/app-release.json: the build Google Play serves to everyone,
// read by the Android app (apps/app/src/storeRelease.js). The bytes must be
// what that parser takes, or the notice never shows.
const storeReleaseBytes = (build) => '{"v":1,"android":{"build":' + build + '}}\n'
const STORE_BAD = ['00', '0123', '1234567890', '-77', '4.5', '12a', '0x1F', '7e3', '55,66', '88 99', '+42', '١٢']

test('deploy.sh: VARANDA_ANDROID_STORE_BUILD publishes app-release.json in the shape the app parses', async (t) => {
  if (!hasBash(t)) return
  const { parseStoreRelease, MAX_STORE_BUILD } = await import('../../app/src/storeRelease.js')
  const src = fs.readFileSync(SCRIPT, 'utf8')
  const fn = src.match(/^conferir_antes\(\) \{\n[\s\S]*?^\}\n/m)
  const pub = src.match(/^publicar_associacoes\(\) \{\n[\s\S]*?^\}\n/m)
  const res = src.match(/^(domain_re|assoc_re|moderator_re|limite_re|limites_conta)=.*$/mg)
  t.ok(fn && pub && res && res.length === 5, 'functions and patterns located')
  t.ok(/^android_store_build=''$/m.test(src), 'deploy.sh declares the global beside android_cert')
  const { dir, www, wk, envFile } = assocFixture(t)
  const release = path.join(wk, 'app-release.json')
  const run = (extra) => {
    fs.writeFileSync(envFile, ASSOC_BASE_ENV + extra)
    const script = 'set -Eeuo pipefail\nroot=' + JSON.stringify(dir) + '\nwww=' + JSON.stringify(www) +
      '\ntarget=x\nandroid_cert=\nios_app_id=\nandroid_store_build=\n' + res.join('\n') + '\n' +
      'log() { printf "%s\\n" "$*" >&2; }\ngit() { return 0; }\n' + SOURCE_WELL_KNOWN + fn[0] + pub[0] +
      'conferir_antes\npublicar_associacoes\n'
    return spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  }

  const none = run('')
  t.is(none.status, 0, 'unset passes: ' + none.stderr)
  t.absent(fs.existsSync(wk), 'no app-release.json and no empty .well-known')
  t.absent(none.stderr.includes('VARANDA_ANDROID_STORE_BUILD'), 'no warning when unset')

  for (const build of [1, 42, MAX_STORE_BUILD]) {
    const r = run('VARANDA_ANDROID_STORE_BUILD=' + build + '\n')
    t.is(r.status, 0, build + ' passes: ' + r.stderr)
    const text = fs.readFileSync(release, 'utf8')
    t.is(text, storeReleaseBytes(build), build + ': exact bytes')
    t.is(parseStoreRelease(text), build, build + ': storeRelease.js parses the same build')
    t.alike(fs.readdirSync(wk), ['app-release.json'], build + ': only that file, no temporary left')
  }
  for (const written of ['"314"', "'314' # Play 1.3", ' 314 \r', '314 # depois do lançamento completo']) {
    const r = run('VARANDA_ANDROID_STORE_BUILD=' + written + '\n')
    t.is(r.status, 0, 'parsed like VARANDA_IOS_APP_ID: ' + JSON.stringify(written) + ' ' + r.stderr)
    t.is(fs.readFileSync(release, 'utf8'), storeReleaseBytes(314), 'the same bytes as 314')
  }
  const last = run('VARANDA_ANDROID_STORE_BUILD=7\nVARANDA_ANDROID_STORE_BUILD=8\n')
  t.is(last.status, 0, 'the last line wins: ' + last.stderr)
  t.is(fs.readFileSync(release, 'utf8'), storeReleaseBytes(8), 'build 8')

  // Beside the associations, which keep their bytes.
  const all = run('VARANDA_ANDROID_CERT_SHA256=' + FAKE_CERT + '\nVARANDA_IOS_APP_ID=' + FAKE_IOS + '\nVARANDA_ANDROID_STORE_BUILD=9\n')
  t.is(all.status, 0, 'with both associations: ' + all.stderr)
  checkAssocShapes(t, wk)
  t.is(fs.readFileSync(path.join(wk, 'assetlinks.json'), 'utf8'), assetlinksBytes(FAKE_CERT), 'assetlinks.json bytes unchanged')
  t.alike(fs.readdirSync(wk).sort(), ['app-release.json', 'apple-app-site-association', 'assetlinks.json'], 'three files, no temporary left')
  const before = Object.fromEntries(fs.readdirSync(wk).map((f) => [f, fs.readFileSync(path.join(wk, f))]))

  for (const value of STORE_BAD) {
    const r = run('VARANDA_ANDROID_CERT_SHA256=' + FAKE_CERT_2 + '\nVARANDA_ANDROID_STORE_BUILD=' + value + '\n')
    t.is(r.status, 1, 'refused: ' + value)
    t.ok(r.stderr.includes('VARANDA_ANDROID_STORE_BUILD inválido em deploy/seeder/.env'), value + ': names the variable')
    t.absent(r.stderr.includes(value), value + ': the value is not printed')
    t.alike(fs.readdirSync(wk).sort(), Object.keys(before).sort(), value + ': no file added or removed')
    for (const [f, bytes] of Object.entries(before)) t.alike(fs.readFileSync(path.join(wk, f)), bytes, value + ': ' + f + ' unchanged')
  }

  // Emptied or removed after being set: the file goes, the associations stay.
  const emptied = run('VARANDA_ANDROID_CERT_SHA256=' + FAKE_CERT + '\nVARANDA_IOS_APP_ID=' + FAKE_IOS + '\nVARANDA_ANDROID_STORE_BUILD=\n')
  t.is(emptied.status, 0, 'empty passes: ' + emptied.stderr)
  t.absent(fs.existsSync(release), 'empty removes app-release.json')
  checkAssocShapes(t, wk)
  t.is(run('VARANDA_ANDROID_STORE_BUILD=10\n').status, 0, 'set again')
  t.ok(fs.existsSync(release), 'published again')
  const unset = run('VARANDA_ANDROID_CERT_SHA256=' + FAKE_CERT + '\n')
  t.is(unset.status, 0, 'the line removed passes: ' + unset.stderr)
  t.absent(fs.existsSync(release), 'unset removes app-release.json')
  t.ok(fs.existsSync(path.join(wk, 'assetlinks.json')), 'assetlinks.json kept')
})

// The same all-or-nothing rule as the associations, on the already-deployed
// path that applies an .env change without a new commit.
test('deploy.sh: a failing app-release.json write leaves every published file as it was', (t) => {
  if (!hasBash(t)) return
  const src = fs.readFileSync(SCRIPT, 'utf8')
  const fn = src.match(/^conferir_antes\(\) \{\n[\s\S]*?^\}\n/m)
  const pub = src.match(/^publicar_associacoes\(\) \{\n[\s\S]*?^\}\n/m)
  const early = src.match(/^ {2}if \[ "\$sem_registro" = 0 \] && \[ "\$previous" = "\$target" \][\s\S]*?^ {2}fi\n/m)
  const res = src.match(/^(domain_re|assoc_re|moderator_re|limite_re|limites_conta)=.*$/mg)
  t.ok(fn && pub && early && res && res.length === 5, 'functions, early-exit block and patterns located')
  const { dir, www, wk, envFile } = assocFixture(t)
  // The step after writing a temporary file fails for this one (a full disk
  // would fail the write itself), once the earlier ones were written.
  let failing = null
  const run = (extra) => {
    fs.writeFileSync(envFile, ASSOC_BASE_ENV + extra)
    const script = 'set -Eeuo pipefail\nroot=' + JSON.stringify(dir) + '\nwww=' + JSON.stringify(www) +
      '\ntarget=x\nprevious=x\nsem_registro=0\n' + res.join('\n') + '\n' +
      'log() { printf "%s\\n" "$*" >&2; }\n' +
      'git() { if [ "$1" = rev-parse ]; then echo x; fi; return 0; }\n' +
      'verificar_saude() { return 0; }\nweb_com_env_atual() { return 0; }\n' +
      (failing === null ? '' : 'chmod() { if [ "$2" = ' + JSON.stringify(failing) + ' ]; then return 1; fi; command chmod "$@"; }\n') +
      'erro_antes() { echo "nada foi alterado" >&2; exit 1; }\ntrap erro_antes ERR\n' +
      SOURCE_WELL_KNOWN + fn[0] + pub[0] +
      'conferir_antes\n' + early[0] + 'echo "fell through" >&2\nexit 9\n'
    return spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  }
  const first = run('VARANDA_ANDROID_CERT_SHA256=' + FAKE_CERT_2 + '\nVARANDA_IOS_APP_ID=ZZZZZ99999.app.varanda\nVARANDA_ANDROID_STORE_BUILD=5\n')
  t.is(first.status, 0, 'the previous files are published: ' + first.stderr)
  const names = ['app-release.json', 'apple-app-site-association', 'assetlinks.json']
  t.alike(fs.readdirSync(wk).sort(), names, 'three files')
  const before = Object.fromEntries(names.map((f) => [f, fs.readFileSync(path.join(wk, f))]))
  // The last one, after the two association files were written.
  failing = path.join(wk, 'app-release.json.tmp')
  for (const [label, extra] of [
    ['all changed', 'VARANDA_ANDROID_CERT_SHA256=' + FAKE_CERT + '\nVARANDA_IOS_APP_ID=' + FAKE_IOS + '\nVARANDA_ANDROID_STORE_BUILD=6\n'],
    ['build changed, associations cleared', 'VARANDA_ANDROID_STORE_BUILD=6\n']
  ]) {
    const r = run(extra)
    t.is(r.status, 1, label + ': the run fails')
    t.ok(r.stderr.includes('as anteriores ficaram como estavam'), label + ': says the previous files were kept')
    t.absent(r.stderr.includes('nada foi alterado') || r.stderr.includes('fell through'), label + ': no misleading message')
    for (const f of names) t.alike(fs.readFileSync(path.join(wk, f)), before[f], label + ': ' + f + ' byte-identical')
    t.absent(fs.existsSync(path.join(wk, 'assetlinks.json.tmp')) || fs.existsSync(path.join(wk, 'apple-app-site-association.tmp')) ||
      fs.existsSync(path.join(wk, 'app-release.json.tmp')), label + ': no temporary file left')
  }
  failing = null
  const ok = run('VARANDA_ANDROID_CERT_SHA256=' + FAKE_CERT + '\nVARANDA_IOS_APP_ID=' + FAKE_IOS + '\nVARANDA_ANDROID_STORE_BUILD=6\n')
  t.is(ok.status, 0, 'once writable again the update goes through: ' + ok.stderr)
  checkAssocShapes(t, wk)
  t.is(fs.readFileSync(path.join(wk, 'app-release.json'), 'utf8'), storeReleaseBytes(6), 'build 6 published')
  const off = run('VARANDA_ANDROID_CERT_SHA256=' + FAKE_CERT + '\nVARANDA_IOS_APP_ID=' + FAKE_IOS + '\n')
  t.is(off.status, 0, 'unset on the same commit exits 0: ' + off.stderr)
  t.absent(fs.existsSync(path.join(wk, 'app-release.json')), 'app-release.json removed without a new commit')
})

// A web export as finish-web.js leaves it: index.html marked with the release
// and the node copy named after it, beside varanda-node.js and sw.js.
const RELEASE = '0123456789abcdef'
const RELEASE_NODE = 'varanda-node-' + RELEASE + '.js'
function writeWebDist (dist) {
  fs.writeFileSync(path.join(dist, 'index.html'), '<html><head><meta name="varanda-release" content="' + RELEASE + '"></head></html>')
  for (const f of ['varanda-node.js', RELEASE_NODE, 'sw.js']) fs.writeFileSync(path.join(dist, f), f)
}

// The manual publication (README) replaces www too: it must render the same
// files from the same rules, and refuse a malformed value before building.
test('build-web.sh: writes the association files and refuses malformed values', (t) => {
  if (!hasBash(t)) return
  const BUILD = path.join(repoRoot, 'deploy/seeder/build-web.sh')
  t.ok(fs.readFileSync(BUILD, 'utf8').includes('. "$root/deploy/seeder/well-known.sh"'), 'build-web.sh sources well-known.sh')
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'varanda-build-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'deploy/seeder'), { recursive: true })
  fs.copyFileSync(BUILD, path.join(dir, 'deploy/seeder/build-web.sh'))
  fs.copyFileSync(WELL_KNOWN, path.join(dir, 'deploy/seeder/well-known.sh'))
  const dist = path.join(dir, 'apps/app/dist')
  fs.mkdirSync(dist, { recursive: true })
  writeWebDist(dist)
  // docker is stubbed: it only records that the build ran.
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const marker = path.join(dir, 'docker-ran')
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\ntouch ' + JSON.stringify(marker) + '\n', { mode: 0o755 })
  const www = path.join(dir, 'deploy/seeder/www')
  const wk = path.join(www, '.well-known')
  const envFile = path.join(dir, 'deploy/seeder/.env')
  // build-web.sh reads the arg-mode owner with GNU stat; the stub answers
  // the same on macOS (BSD stat) and Linux.
  fs.writeFileSync(path.join(bin, 'stat'), '#!/bin/sh\necho ' + process.getuid() + ':' + process.getgid() + '\n', { mode: 0o755 })
  const baseEnv = { ...process.env, PATH: bin + path.delimiter + process.env.PATH }
  delete baseEnv.EXPO_PUBLIC_VARANDA_COMMIT
  const run = (env, extraEnv = {}, args = []) => {
    fs.rmSync(marker, { force: true })
    fs.writeFileSync(envFile, env)
    return spawnSync('bash', [path.join(dir, 'deploy/seeder/build-web.sh'), ...args], {
      encoding: 'utf8',
      env: { ...baseEnv, ...extraEnv }
    })
  }
  const both = run('VARANDA_ANDROID_CERT_SHA256=' + FAKE_CERT + '\nVARANDA_IOS_APP_ID=' + FAKE_IOS + '\n')
  t.is(both.status, 0, 'publishes with both set: ' + both.stderr)
  t.ok(fs.existsSync(path.join(www, 'index.html')), 'the app is published')
  t.ok(fs.existsSync(path.join(www, RELEASE_NODE)), 'with the node copy the page loads')
  t.ok(fs.readFileSync(BUILD, 'utf8').includes('copiar_app "$root/apps/app/dist" "$novo"'), 'the page lands last (copiar_app)')
  t.ok(fs.readFileSync(BUILD, 'utf8').includes('mesclar_www "$novo" "$www"'), 'www changes by renames (mesclar_www), never emptied first')
  t.absent(fs.existsSync(path.join(dir, 'deploy/seeder/.www-novo')), 'the staging copy is removed')
  checkAssocShapes(t, wk)
  const off = run('')
  t.is(off.status, 0, 'publishes with both empty: ' + off.stderr)
  t.absent(fs.existsSync(wk), 'no association file with both empty')
  t.ok(off.stderr.includes('aviso: VARANDA_IOS_APP_ID vazio'), 'warns that iOS sign-in is off')
  fs.writeFileSync(path.join(www, 'index.html'), 'previous')
  for (const [name, value] of ASSOC_BAD) {
    const r = run(name + '=' + value + '\n')
    t.not(r.status, 0, name + ' malformed is refused: ' + value)
    t.ok(r.stderr.includes(name + ' inválido em deploy/seeder/.env'), 'says which variable')
    t.absent(fs.existsSync(marker), 'refused before the build')
  }
  t.is(fs.readFileSync(path.join(www, 'index.html'), 'utf8'), 'previous', 'www untouched by a refused run')
  const badStore = run('VARANDA_ANDROID_STORE_BUILD=0x2A\n')
  t.not(badStore.status, 0, 'a malformed VARANDA_ANDROID_STORE_BUILD is refused')
  t.ok(badStore.stderr.includes('VARANDA_ANDROID_STORE_BUILD inválido em deploy/seeder/.env'), 'says which variable')
  t.absent(badStore.stderr.includes('0x2A'), 'never prints the value')
  t.absent(fs.existsSync(marker), 'refused before the build')
  const store = run('VARANDA_ANDROID_STORE_BUILD=42\n')
  t.is(store.status, 0, 'publishes app-release.json: ' + store.stderr)
  t.is(fs.readFileSync(path.join(wk, 'app-release.json'), 'utf8'), '{"v":1,"android":{"build":42}}\n', 'with the exact bytes')
  t.is(run('').status, 0, 'publishes with it empty')
  t.absent(fs.existsSync(wk), 'and drops app-release.json')

  // version.json: written by the host from the validated commit, never from
  // what the container left in dist.
  const version = path.join(www, 'version.json')
  const COMMIT = 'ab'.repeat(20)
  const bytes = '{"v":1,"commit":"' + COMMIT + '"}\n'
  t.is(run('').status, 0, 'no commit and no .git still publishes')
  t.absent(fs.existsSync(version), 'no version.json without a commit')
  const badCommit = run('', { EXPO_PUBLIC_VARANDA_COMMIT: 'xyz' })
  t.not(badCommit.status, 0, 'a malformed commit is refused')
  t.ok(badCommit.stderr.includes('EXPO_PUBLIC_VARANDA_COMMIT inválido'), 'says which variable')
  t.absent(badCommit.stderr.includes('xyz'), 'never prints the value')
  t.absent(fs.existsSync(marker), 'refused before the build')
  fs.writeFileSync(path.join(dist, 'version.json'), '{"v":1,"commit":"planted"}\n')
  const good = run('', { EXPO_PUBLIC_VARANDA_COMMIT: COMMIT })
  t.is(good.status, 0, 'a valid commit publishes: ' + good.stderr)
  t.is(fs.readFileSync(version, 'utf8'), bytes, 'www/version.json has the exact bytes')
  t.is(run('').status, 0, 'a later run without a commit publishes')
  t.absent(fs.existsSync(version), 'and drops version.json')

  // Arg mode (deploy.sh): the stage dist gets the file, www is not touched.
  const stage = path.join(dir, 'stage')
  const stageDist = path.join(stage, 'apps/app/dist')
  fs.mkdirSync(stageDist, { recursive: true })
  writeWebDist(stageDist)
  fs.writeFileSync(path.join(stageDist, 'version.json'), '{"v":1,"commit":"planted"}\n')
  const wwwBefore = fs.readdirSync(www).sort()
  const arg = run('', { EXPO_PUBLIC_VARANDA_COMMIT: COMMIT }, [stage])
  t.is(arg.status, 0, 'arg mode with a valid commit exits 0: ' + arg.stderr)
  t.ok(fs.existsSync(marker), 'arg mode runs the build')
  t.is(fs.readFileSync(path.join(stageDist, 'version.json'), 'utf8'), bytes, 'stage dist/version.json rewritten by the host')
  t.alike(fs.readdirSync(www).sort(), wwwBefore, 'www untouched in arg mode')
  t.absent(fs.existsSync(version), 'no version.json published in arg mode')
  fs.rmSync(path.join(stageDist, 'version.json'))
  fs.mkdirSync(path.join(stageDist, 'version.json'))
  const blocked = run('', { EXPO_PUBLIC_VARANDA_COMMIT: COMMIT }, [stage])
  t.not(blocked.status, 0, 'a directory at dist/version.json fails the build')
  t.ok(fs.statSync(path.join(stageDist, 'version.json')).isDirectory(), 'nothing written through it')

  // The page loads the node copy named by its release mark: a build without
  // the copy or without the mark is refused, in both modes, before www changes.
  const NO_COPY = 'o build não gerou a marca varanda-release e a cópia varanda-node-<versão>.js'
  const published = fs.readFileSync(path.join(www, 'index.html'))
  fs.rmSync(path.join(dist, RELEASE_NODE))
  const noCopy = run('')
  t.not(noCopy.status, 0, 'a build without the release node copy is refused')
  t.ok(noCopy.stderr.includes(NO_COPY), 'says what is missing')
  t.ok(fs.readFileSync(path.join(www, 'index.html')).equals(published), 'www untouched')
  writeWebDist(dist)
  fs.writeFileSync(path.join(dist, 'index.html'), '<html><head></head></html>')
  const noMark = run('')
  t.not(noMark.status, 0, 'a build without the release mark is refused')
  t.ok(noMark.stderr.includes(NO_COPY), 'says what is missing')
  t.ok(fs.readFileSync(path.join(www, 'index.html')).equals(published), 'www still untouched')
  fs.rmSync(path.join(stageDist, 'version.json'), { recursive: true })
  fs.rmSync(path.join(stageDist, RELEASE_NODE))
  const argNoCopy = run('', { EXPO_PUBLIC_VARANDA_COMMIT: COMMIT }, [stage])
  t.not(argNoCopy.status, 0, 'arg mode refuses it too')
  t.ok(argNoCopy.stderr.includes(NO_COPY), 'and says what is missing')
})

// www is a bind mount that Caddy serves while the deploy runs: the new tree
// goes in by renames, index.html last, and only then the old files go away.
test('well-known.sh: mesclar_www swaps www without emptying it', (t) => {
  if (!hasBash(t)) return
  const src = fs.readFileSync(WELL_KNOWN, 'utf8')
  const fn = src.match(/^mesclar_www\(\) \{\n[\s\S]*?^\}\n/m)
  t.ok(fn, 'mesclar_www located')
  if (!fn) return
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-mesclar-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const novo = path.join(dir, 'novo')
  const www = path.join(dir, 'www')
  const log = path.join(dir, 'mv.log')
  const write = (base, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true })
    fs.writeFileSync(path.join(base, rel), text)
  }
  write(www, 'index.html', 'old page')
  write(www, 'sw.js', 'old sw')
  write(www, 'old-bundle.js', 'old bundle')
  write(www, 'shared.js', 'old shared')
  write(www, 'gone/x.txt', 'gone')
  write(www, 'flip', 'a file that becomes a directory')
  write(novo, 'index.html', 'new page')
  write(novo, 'sw.js', 'new sw')
  write(novo, 'new-bundle.js', 'new bundle')
  write(novo, 'shared.js', 'new shared')
  write(novo, '.well-known/assetlinks.json', '[]')
  write(novo, 'flip/inner.txt', 'inner')
  // Every rename is logged with what www holds at that moment.
  const script = 'set -Eeuo pipefail\n' +
    'mv() { printf "%s %s\\n" "$' + '{*: -1}" "$(cat ' + JSON.stringify(www) + '/index.html 2>/dev/null || echo NONE)" >> ' + JSON.stringify(log) + '; command mv "$@"; }\n' +
    'export -f mv\n' + fn[0] + 'mesclar_www ' + JSON.stringify(novo) + ' ' + JSON.stringify(www) + '\n'
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  t.is(r.status, 0, 'merges: ' + r.stderr)
  const tree = (base) => {
    const out = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else out.push(path.relative(base, p) + '=' + fs.readFileSync(p, 'utf8'))
      }
    }
    walk(base)
    return out
  }
  t.alike(tree(www), tree(novo), 'www ends equal to the new tree, old files gone')
  t.ok(fs.existsSync(path.join(novo, 'index.html')), 'the source is left intact')
  const moves = fs.readFileSync(log, 'utf8').trim().split('\n')
  t.ok(moves.every((l) => !l.endsWith(' NONE')), 'index.html never missing during the swap')
  t.ok(moves[moves.length - 1].startsWith(path.join(www, 'index.html') + ' ') || moves[moves.length - 1].startsWith(www + '/./index.html '), 'index.html is renamed last')
  const swAt = moves.findIndex((l) => /\/sw\.js /.test(l))
  t.ok(swAt === moves.length - 2, 'sw.js right before index.html')
  t.ok(moves.slice(0, -1).every((l) => l.endsWith(' old page')), 'the old page stays until its own rename')
})

// The rollback calls mesclar_www inside `if !`, where bash ignores errexit:
// a failed copy must still fail the call, before anything is deleted. A
// symlink already at a file path is replaced, never followed out of www.
test('well-known.sh: mesclar_www fails under if ! on a failed copy and never follows a link', (t) => {
  if (!hasBash(t)) return
  const src = fs.readFileSync(WELL_KNOWN, 'utf8')
  const fn = src.match(/^mesclar_www\(\) \{\n[\s\S]*?^\}\n/m)
  t.ok(fn, 'mesclar_www located')
  if (!fn) return
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-mesclar-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const novo = path.join(dir, 'novo')
  const www = path.join(dir, 'www')
  const fora = path.join(dir, 'fora')
  fs.mkdirSync(novo)
  fs.mkdirSync(www)
  fs.mkdirSync(fora)
  fs.writeFileSync(path.join(novo, 'index.html'), 'new page')
  fs.writeFileSync(path.join(novo, 'a.js'), 'new a')
  fs.writeFileSync(path.join(www, 'index.html'), 'old page')
  fs.writeFileSync(path.join(www, 'old.js'), 'old')
  fs.symlinkSync(fora, path.join(www, 'a.js'))
  const run = (pre) => spawnSync('bash', ['-c', 'set -Eeuo pipefail\n' + pre + fn[0] +
    'if ! mesclar_www ' + JSON.stringify(novo) + ' ' + JSON.stringify(www) + '; then echo FAILED; fi\n'], { encoding: 'utf8' })

  const failed = run('cp() { return 1; }\nexport -f cp\n')
  t.ok(failed.stdout.includes('FAILED'), 'a failed copy fails the call: ' + failed.stderr)
  t.ok(fs.existsSync(path.join(www, 'old.js')), 'nothing is deleted after a failed copy')
  t.is(fs.readFileSync(path.join(www, 'index.html'), 'utf8'), 'old page', 'the old page stays')

  const ok = run('')
  t.absent(ok.stdout.includes('FAILED'), 'merges: ' + ok.stderr)
  t.alike(fs.readdirSync(fora), [], 'nothing was written through the link')
  t.absent(fs.lstatSync(path.join(www, 'a.js')).isSymbolicLink(), 'the link is replaced by the file')
  t.is(fs.readFileSync(path.join(www, 'a.js'), 'utf8'), 'new a', 'with the new content')
})

test('well-known.sh: copiar_app copies index.html last and versao_web reads the release mark', (t) => {
  if (!hasBash(t)) return
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-copy-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dist = path.join(dir, 'dist')
  const www = path.join(dir, 'www')
  fs.mkdirSync(path.join(dist, '_expo/static/js/web'), { recursive: true })
  fs.mkdirSync(path.join(dist, '.well-known'))
  fs.mkdirSync(www)
  writeWebDist(dist)
  fs.writeFileSync(path.join(dist, '_expo/static/js/web/index-ab12.js'), 'bundle')
  fs.writeFileSync(path.join(dist, '.well-known/x'), 'dot')
  fs.writeFileSync(path.join(dist, 'manifest.webmanifest'), '{}')
  // cp is wrapped: it records each source in order and its option, and fails
  // on demand.
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const order = path.join(dir, 'order')
  const opts = path.join(dir, 'opts')
  const failOn = path.join(dir, 'fail-on')
  fs.writeFileSync(path.join(bin, 'cp'), '#!/bin/sh\n' +
    'for a; do src=$prev; prev=$a; done\n' +
    'name=$(basename "$src")\n' +
    'printf \'%s\\n\' "$name" >> ' + JSON.stringify(order) + '\n' +
    'printf \'%s\\n\' "$1" >> ' + JSON.stringify(opts) + '\n' +
    'if [ -f ' + JSON.stringify(failOn) + ' ] && [ "$name" = "$(cat ' + JSON.stringify(failOn) + ')" ]; then exit 1; fi\n' +
    'exec /bin/cp "$@"\n', { mode: 0o755 })
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH }
  const sh = (body) => spawnSync('bash', ['-c', 'set -Eeuo pipefail\nlog() { printf "%s\\n" "$*" >&2; }\n' + SOURCE_WELL_KNOWN + body], { encoding: 'utf8', env })
  const copy = () => sh('copiar_app ' + JSON.stringify(dist) + ' ' + JSON.stringify(www) + '\n')

  const ok = copy()
  t.is(ok.status, 0, 'copies: ' + ok.stderr)
  const sources = fs.readFileSync(order, 'utf8').trim().split('\n')
  t.alike(sources.slice(-2), ['sw.js', 'index.html'], 'sw.js, then index.html, last')
  t.ok(sources.indexOf(RELEASE_NODE) < sources.indexOf('index.html'), 'the node copy before the page')
  for (const f of ['index.html', 'sw.js', 'varanda-node.js', RELEASE_NODE, 'manifest.webmanifest', '_expo/static/js/web/index-ab12.js', '.well-known/x']) {
    t.ok(fs.readFileSync(path.join(www, f)).equals(fs.readFileSync(path.join(dist, f))), 'same bytes: ' + f)
  }
  t.alike(fs.readdirSync(www).sort(), fs.readdirSync(dist).sort(), 'nothing more, nothing less')
  const lines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n')
  t.alike(lines(opts).filter((o) => o !== '-R'), [], 'cp -R by default')

  fs.rmSync(www, { recursive: true })
  fs.mkdirSync(www)
  fs.rmSync(order)
  fs.writeFileSync(failOn, RELEASE_NODE)
  const failed = copy()
  t.not(failed.status, 0, 'a failed copy fails copiar_app')
  t.absent(fs.existsSync(path.join(www, 'index.html')), 'and the page never lands')
  fs.rmSync(failOn)

  const reset = () => {
    fs.rmSync(www, { recursive: true })
    fs.mkdirSync(www)
    fs.rmSync(order, { force: true })
    fs.rmSync(opts, { force: true })
  }
  // The rollback restores the saved www with -a: owner, mode and dates stay
  // (Caddy's ETag follows the date), and the page still lands last.
  const old = new Date('2001-02-03T04:05:06Z')
  const dated = ['index.html', 'sw.js', RELEASE_NODE, '_expo/static/js/web/index-ab12.js']
  for (const f of dated) fs.utimesSync(path.join(dist, f), old, old)
  reset()
  const kept = sh('copiar_app ' + JSON.stringify(dist) + ' ' + JSON.stringify(www) + ' -a\n')
  t.is(kept.status, 0, 'copies with -a: ' + kept.stderr)
  t.alike(lines(opts).filter((o) => o !== '-a'), [], 'every cp gets -a')
  t.alike(lines(order).slice(-2), ['sw.js', 'index.html'], 'sw.js, then index.html, last with -a too')
  for (const f of dated) t.is(fs.statSync(path.join(www, f)).mtimeMs, old.getTime(), 'date kept: ' + f)

  // A saved www without sw.js is restored without one, the page still last,
  // and an empty one restores nothing, like a copy of the whole folder.
  fs.renameSync(path.join(dist, 'sw.js'), path.join(dir, 'sw.js'))
  reset()
  const noSw = copy()
  t.is(noSw.status, 0, 'copies without sw.js: ' + noSw.stderr)
  t.is(lines(order).at(-1), 'index.html', 'the page last')
  t.absent(fs.existsSync(path.join(www, 'sw.js')), 'and no sw.js appears')
  fs.renameSync(path.join(dir, 'sw.js'), path.join(dist, 'sw.js'))
  const empty = path.join(dir, 'empty')
  fs.mkdirSync(empty)
  reset()
  const none = sh('copiar_app ' + JSON.stringify(empty) + ' ' + JSON.stringify(www) + ' -a\n')
  t.is(none.status, 0, 'an empty source copies: ' + none.stderr)
  t.alike(fs.readdirSync(www), [], 'nothing')
  // A missing source (a saved www that is gone) fails, like the cp of the
  // folder it replaces, and leaves the destination as it was.
  fs.writeFileSync(path.join(www, 'keep'), 'kept')
  const gone = sh('copiar_app ' + JSON.stringify(path.join(dir, 'absent')) + ' ' + JSON.stringify(www) + ' -a\n')
  t.not(gone.status, 0, 'a missing source fails copiar_app')
  t.alike(fs.readdirSync(www), ['keep'], 'and leaves the destination untouched')

  const read = (file) => sh('versao_web ' + JSON.stringify(file) + '\n')
  const marked = read(path.join(dist, 'index.html'))
  t.is(marked.status, 0)
  t.is(marked.stdout, RELEASE, 'the release of the mark')
  for (const [label, html] of [['no mark', '<html><head></head></html>'], ['15 hex', '<meta name="varanda-release" content="0123456789abcde">'], ['upper case', '<meta name="varanda-release" content="0123456789ABCDEF">']]) {
    fs.writeFileSync(path.join(dir, 'index.html'), html)
    const r = read(path.join(dir, 'index.html'))
    t.is(r.status, 0, label + ': exits 0')
    t.is(r.stdout, '', label + ': nothing')
  }
  const missing = read(path.join(dir, 'absent.html'))
  t.is(missing.status, 0, 'a missing index.html exits 0')
  t.is(missing.stdout, '', 'with nothing')
})

test('well-known.sh: gravar_versao refuses malformed commits and links', (t) => {
  if (!hasBash(t)) return
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-version-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const www = path.join(dir, 'www')
  fs.mkdirSync(www)
  const version = path.join(www, 'version.json')
  const COMMIT = '0123456789abcdef'.repeat(3).slice(0, 40)
  const run = (target, commit) => spawnSync('bash', ['-c',
    'set -Eeuo pipefail\nlog() { printf "%s\\n" "$*" >&2; }\n' + SOURCE_WELL_KNOWN +
    'gravar_versao ' + JSON.stringify(target) + ' ' + JSON.stringify(commit) + '\n'], { encoding: 'utf8' })
  const ok = run(www, COMMIT)
  t.is(ok.status, 0, 'a valid commit is written: ' + ok.stderr)
  t.is(fs.readFileSync(version, 'utf8'), '{"v":1,"commit":"' + COMMIT + '"}\n', 'exact bytes')
  t.absent(fs.existsSync(version + '.tmp'), 'no temporary file left')
  for (const [label, bad] of [['uppercase', COMMIT.toUpperCase()], ['39 characters', COMMIT.slice(0, 39)]]) {
    const r = run(www, bad)
    t.is(r.status, 1, label + ' is refused')
    t.ok(r.stderr.includes('commit inválido para version.json'), label + ': says why')
    t.absent(r.stderr.includes(bad), label + ': never prints the value')
    t.is(fs.readFileSync(version, 'utf8'), '{"v":1,"commit":"' + COMMIT + '"}\n', label + ': file untouched')
  }
  const empty = run(www, '')
  t.is(empty.status, 0, 'an empty commit passes')
  t.absent(fs.existsSync(version), 'and removes the file')
  const outside = path.join(dir, 'outside')
  fs.writeFileSync(outside, 'secret')
  fs.symlinkSync(outside, version)
  const link = run(www, COMMIT)
  t.is(link.status, 1, 'a symlink at the destination is refused')
  t.is(fs.readFileSync(outside, 'utf8'), 'secret', 'the link target is untouched')
  fs.rmSync(version)
  const linkedDir = path.join(dir, 'linked')
  fs.symlinkSync(www, linkedDir)
  t.is(run(linkedDir, COMMIT).status, 1, 'a symlinked directory is refused')
  t.absent(fs.existsSync(version), 'nothing written through it')
  fs.writeFileSync(version, 'kept')
  t.is(run(linkedDir, '').status, 1, 'an empty commit through a symlinked directory is refused too')
  t.is(fs.readFileSync(version, 'utf8'), 'kept', 'and nothing is removed through it')
  fs.rmSync(version)
  // A .tmp the build left (mode 000, as uid 65534 could) must not lend its mode
  // to the published file.
  fs.writeFileSync(version + '.tmp', 'stale', { mode: 0o000 })
  const stale = run(www, COMMIT)
  t.is(stale.status, 0, 'a leftover regular .tmp is replaced: ' + stale.stderr)
  t.is(fs.statSync(version).mode & 0o777, 0o644, 'the published file is 0644')
  t.is(fs.readFileSync(version, 'utf8'), '{"v":1,"commit":"' + COMMIT + '"}\n', 'with the exact bytes')
})

// gravar_associacoes runs as root: no write may follow a planted link, and
// a directory where a file goes must fail before anything is swapped.
test('well-known.sh: gravar_associacoes refuses links and directories in its paths', (t) => {
  if (!hasBash(t)) return
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-assoc-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const www = path.join(dir, 'www')
  fs.mkdirSync(www)
  const wk = path.join(www, '.well-known')
  const NAMES = ['app-release.json', 'apple-app-site-association', 'assetlinks.json']
  const run = (target, { cert = FAKE_CERT, ios = FAKE_IOS, build = '7' } = {}) => spawnSync('bash', ['-c',
    'set -Eeuo pipefail\nlog() { printf "%s\\n" "$*" >&2; }\n' + SOURCE_WELL_KNOWN +
    'android_cert=' + JSON.stringify(cert) + '\nios_app_id=' + JSON.stringify(ios) + '\nandroid_store_build=' + JSON.stringify(build) + '\n' +
    'gravar_associacoes ' + JSON.stringify(target) + '\n'], { encoding: 'utf8' })
  const ok = run(www)
  t.is(ok.status, 0, 'all three are published: ' + ok.stderr)
  t.alike(fs.readdirSync(wk).sort(), NAMES)
  const snapshot = () => Object.fromEntries(fs.readdirSync(wk).sort().map((f) => [f, fs.lstatSync(path.join(wk, f)).isFile() ? fs.readFileSync(path.join(wk, f), 'utf8') : 'not a file']))
  const before = snapshot()
  const outside = path.join(dir, 'outside')
  for (const name of NAMES) {
    for (const planted of [name + '.tmp', name]) {
      fs.writeFileSync(outside, 'secret')
      const p = path.join(wk, planted)
      const saved = fs.existsSync(p) ? fs.readFileSync(p) : null
      if (saved !== null) fs.rmSync(p)
      fs.symlinkSync(outside, p)
      const r = run(www, { build: '8' })
      t.is(r.status, 1, 'a symlink at ' + planted + ' is refused')
      t.ok(r.stderr.includes('não é um arquivo comum'), planted + ': says why')
      t.is(fs.readFileSync(outside, 'utf8'), 'secret', planted + ': the link target is untouched')
      fs.rmSync(p, { force: true })
      if (saved !== null) fs.writeFileSync(p, saved)
      t.alike(snapshot(), before, planted + ': the published files are as they were')
    }
  }
  for (const name of NAMES) {
    for (const vars of [{ build: '8' }, { cert: '', ios: '', build: '' }]) {
      const p = path.join(wk, name)
      const saved = fs.readFileSync(p)
      fs.rmSync(p)
      fs.mkdirSync(p)
      const label = 'a directory at ' + name + (vars.build === '' ? ' (variables emptied)' : '')
      const r = run(www, vars)
      t.is(r.status, 1, label + ' fails the step')
      t.alike(fs.readdirSync(p), [], label + ': nothing moved into it')
      fs.rmdirSync(p)
      fs.writeFileSync(p, saved)
      t.alike(snapshot(), before, label + ': the other files are as they were')
      t.alike(fs.readdirSync(wk).sort(), NAMES, label + ': no temporary file left')
    }
  }
  const real = path.join(dir, 'real')
  fs.mkdirSync(real)
  fs.renameSync(wk, path.join(real, '.well-known'))
  fs.symlinkSync(path.join(real, '.well-known'), wk)
  const linked = run(www, { build: '8' })
  t.is(linked.status, 1, 'a symlinked .well-known is refused')
  t.ok(linked.stderr.includes('não é um diretório comum'), 'says why')
  t.is(fs.readFileSync(path.join(real, '.well-known/app-release.json'), 'utf8'), before['app-release.json'], 'nothing written through it')
  fs.rmSync(wk)
  fs.renameSync(path.join(real, '.well-known'), wk)
  // A leftover regular .tmp (mode 000) must not lend its mode to the file.
  fs.writeFileSync(path.join(wk, 'app-release.json.tmp'), 'stale', { mode: 0o000 })
  const stale = run(www, { build: '9' })
  t.is(stale.status, 0, 'a leftover regular .tmp is replaced: ' + stale.stderr)
  t.is(fs.readFileSync(path.join(wk, 'app-release.json'), 'utf8'), '{"v":1,"android":{"build":9}}\n')
  for (const name of NAMES) t.is(fs.statSync(path.join(wk, name)).mode & 0o777, 0o644, name + ' is 0644')
})

test('.env.example: native app association variables are documented and empty', (t) => {
  const example = fs.readFileSync(path.join(repoRoot, 'deploy/seeder/.env.example'), 'utf8').split('\n')
  t.ok(example.includes('VARANDA_ANDROID_CERT_SHA256='), 'empty VARANDA_ANDROID_CERT_SHA256= line')
  t.ok(example.includes('VARANDA_IOS_APP_ID='), 'empty VARANDA_IOS_APP_ID= line')
  t.ok(example.includes('VARANDA_ANDROID_STORE_BUILD='), 'empty VARANDA_ANDROID_STORE_BUILD= line')
})

test('deploy.sh: the seeder limit ranges match apps/cli/lib/cli.js', (t) => {
  const cli = fs.readFileSync(path.join(repoRoot, 'apps/cli/lib/cli.js'), 'utf8')
  const fromCli = {}
  for (const m of cli.matchAll(/optionalEnvInteger\(env, '(VARANDA_[A-Z_]+)', (\d+), (\d+)\)/g)) {
    fromCli[m[1]] = m[2] + ':' + m[3]
  }
  const fromSh = {}
  for (const m of shCode.matchAll(/\b(VARANDA_[A-Z_]+):(\d+):(\d+)\b/g)) {
    // The account limits table (limites_conta) is checked against account.js below.
    if (!SEEDER_LIMITS.includes(m[1])) continue
    t.absent(m[1] in fromSh, m[1] + ' appears once in the deploy.sh table')
    fromSh[m[1]] = m[2] + ':' + m[3]
  }
  t.alike(Object.keys(fromCli).sort(), SEEDER_LIMITS.slice().sort(), 'cli.js reads exactly the seeder limits')
  t.alike(fromSh, fromCli, 'deploy.sh checks the same min:max as cli.js')
})

test('Caddyfile: no handle /mod, and the CSP is unchanged', (t) => {
  const caddy = fs.readFileSync(CADDYFILE, 'utf8')
  t.absent(caddy.includes('handle /mod'), 'no handle /mod')
  // Two lines, one per response (@semMidia without VARANDA_MEDIA_ORIGIN, the
  // default; @comMidia with it): without the variable the CSP is as ever.
  const cspLines = caddy.split('\n').filter((l) => /^\s*header @(sem|com)Midia >?Content-Security-Policy /.test(l))
  t.is(cspLines.length, 2, 'two CSP lines, the without-media and the with-media one')
  const csp = cspLines.filter((l) => l.includes('@semMidia')).map((l) => l.replace(/^\s*header @semMidia >?/, ''))
  t.is(csp.length, 1, 'one CSP line without the media origin')
  // Byte-identical to the B2 tree (Caddyfile:20) plus frame-src for music cards:
  // the panel is written for it.
  t.is(csp[0].trim(), 'Content-Security-Policy "default-src \'self\'; script-src \'self\' \'wasm-unsafe-eval\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; media-src \'self\' blob:; font-src \'self\' data:; connect-src \'self\' wss://{$VARANDA_DOMAIN}; frame-src https://www.youtube-nocookie.com https://w.soundcloud.com https://open.spotify.com https://embed.music.apple.com; manifest-src \'self\'; worker-src \'self\'; frame-ancestors \'none\'; base-uri \'none\'; form-action \'none\'; object-src \'none\'"', 'CSP line unchanged')
  t.is(caddy.split('\n').filter((l) => !/^\s*#/.test(l) && l.includes('camera=()')).length, 1, 'camera=() once')
})

test('Caddyfile: /account/* drops the client address headers', (t) => {
  const caddy = fs.readFileSync(CADDYFILE, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  t.ok(caddy.includes('handle /account/*'), 'handle /account/*')
  t.ok(caddy.includes('header_up -X-Forwarded-For'), 'header_up -X-Forwarded-For')
  t.ok(caddy.includes('header_up -X-Real-Ip'), 'header_up -X-Real-Ip')
})

test('Caddyfile: /media/* drops the client address headers and keeps the upstream cache header', (t) => {
  const caddy = fs.readFileSync(CADDYFILE, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  const start = caddy.indexOf('handle /media/* {')
  t.ok(start !== -1, 'handle /media/*')
  const media = caddy.slice(start, caddy.indexOf('\n\t}', start))
  t.ok(media.includes('header_up -X-Forwarded-For'), 'header_up -X-Forwarded-For')
  t.ok(media.includes('header_up -X-Real-Ip'), 'header_up -X-Real-Ip')
  t.ok(media.includes('header_up Host {upstream_hostport}'), 'Host rewritten')
  // Only with VARANDA_MEDIA_ORIGIN, and only by rewriting the seeder's own
  // value (adding s-maxage for the edge): the handle never sets a header of
  // its own, so without the variable the upstream cache header goes through.
  const cacheLines = media.split('\n').filter((l) => l.includes('Cache-Control'))
  t.is(cacheLines.length, 1, 'one Cache-Control line in the /media/* handle')
  t.ok(/^\s*header @comMidia >Cache-Control "\^\(public, max-age=31536000, immutable\)\$" "\$1, s-maxage=60"$/.test(cacheLines[0]),
    'it only appends s-maxage to the upstream value, and only with the media origin')
  t.absent(media.replace(cacheLines[0], '').includes('immutable'), 'nothing else in the /media/* handle sets a cache header')
})

test('compose.web.yaml and Dockerfile.caddy: the Caddy image is built, pinned and restorable', (t) => {
  const webLines = fs.readFileSync(COMPOSE_WEB, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
  const start = webLines.findIndex((l) => /^ {2}web:\s*$/.test(l))
  t.ok(start !== -1, 'web service found')
  let end = webLines.length
  for (let i = start + 1; i < webLines.length; i++) {
    if (/^ {0,2}\S/.test(webLines[i])) { end = i; break }
  }
  const web = webLines.slice(start, end).join('\n')
  t.ok(/^ {4}build:\s*\n {6}context: \.\s*\n {6}dockerfile: Dockerfile\.caddy\s*$/m.test(web), 'web builds from Dockerfile.caddy')
  t.ok(/^ {4}image: varanda-caddy:local\s*$/m.test(web), 'web image is varanda-caddy:local')
  for (const k of ['network_mode: host', 'read_only: true', 'no-new-privileges:true']) t.ok(web.includes(k), 'web keeps ' + k)

  const df = fs.readFileSync(path.join(repoRoot, 'deploy/seeder/Dockerfile.caddy'), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
  const froms = df.filter((l) => /^FROM\s/.test(l))
  t.is(froms.length, 2, 'two stages')
  for (const f of froms) t.ok(/^FROM caddy:2\.11\.6[a-z-]*@sha256:[0-9a-f]{64}( AS \w+)?$/.test(f), 'image pinned by sha256 digest: ' + f)
  const build = df.filter((l) => /xcaddy build/.test(l))
  t.is(build.length, 1, 'one xcaddy build')
  const mod = build[0].match(/--with (\S+)/)
  t.ok(mod && /^github\.com\/mholt\/caddy-ratelimit@(v\d+\.\d+\.\d+|[0-9a-f]{40})$/.test(mod[1]), 'module pinned to an exact version or commit')
  t.absent(df.join('\n').includes('@latest'), 'no @latest')
  t.absent(/--with\s+\S+\s*(\\|$)/m.test(df.join('\n').replace(/--with \S+@\S+/g, '')), 'no unpinned --with')
  t.ok(df.some((l) => l.trim() === 'COPY --from=builder /usr/bin/caddy /usr/bin/caddy'), 'the built binary replaces the runtime one')
})

test('deploy.sh: recusar_pull refuses a server that moved to the pull updater, under the lock and before ler_sha', (t) => {
  const src = fs.readFileSync(SCRIPT, 'utf8')
  const fn = src.match(/^recusar_pull\(\) \{\n[\s\S]*?^\}\n/m)
  const main = src.match(/^main\(\) \{\n[\s\S]*?^\}\n/m)
  t.ok(fn && main, 'recusar_pull and main located')
  const calls = main[0].split('\n').map((l) => l.trim())
  const lock = calls.indexOf('pegar_lock')
  const refuse = calls.indexOf('recusar_pull')
  const sha = calls.indexOf('ler_sha')
  t.ok(lock >= 0 && refuse > lock, 'recusar_pull runs after pegar_lock')
  t.ok(sha > refuse, 'recusar_pull runs before ler_sha (no fetch, build or container change yet)')
  for (const step of ['escolher_alvo', 'guardar_snapshots', 'construir_web']) {
    const at = calls.indexOf(step)
    t.ok(at < 0 || at > refuse, 'recusar_pull runs before ' + step)
  }
  if (!hasBash(t)) return

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-modo-pull-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const run = () => spawnSync('bash', ['-c', 'set -Eeuo pipefail\nstate=' + JSON.stringify(dir) +
    '\nlog() { printf "%s\\n" "$*"; }\n' + fn[0] + 'recusar_pull\nprintf "seguiu\\n"\n'], { encoding: 'utf8' })

  const free = run()
  t.is(free.status, 0, 'without the marker it returns 0: ' + free.stderr)
  t.is(free.stdout, 'seguiu\n', 'without the marker it prints nothing and the deploy goes on')

  fs.writeFileSync(path.join(dir, 'modo-pull'), '')
  const marked = run()
  t.is(marked.status, 1, 'with the marker it exits 1 (failure, nothing changed)')
  t.ok(marked.stdout.includes('este servidor atualiza por imagem'), 'says the server updates by image')
  t.ok(marked.stdout.includes('/var/lib/varanda-deploy/modo-pull'), 'says how to go back to the push path')
  t.absent(marked.stdout.includes('seguiu'), 'nothing after the refusal runs')
})

test('deploy.sh: bash -n and refusal to run as non-root', (t) => {
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    t.comment('bash not found: skipping the syntax and behavioural checks')
    return
  }
  const syntax = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })
  t.is(syntax.status, 0, 'bash -n passes: ' + syntax.stderr)

  if (process.getuid && process.getuid() === 0) {
    t.comment('running as root: skipping the non-root refusal check')
    return
  }
  const res = spawnSync('bash', [SCRIPT], { input: '', encoding: 'utf8' })
  t.is(res.status, 1, 'exits 1 when not root')
  t.ok(res.stderr.includes('exigido root'), 'stderr says exigido root')
  t.is(res.stdout, '', 'nothing on stdout')
})

test('deploy.sh: conferir_antes rejects a bad VARANDA_MAX_MEMBERS and accepts an .env without the limits', (t) => {
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    t.comment('bash not found: skipping the behavioural check')
    return
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-deploy-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'deploy/seeder'), { recursive: true })
  const envFile = path.join(dir, 'deploy/seeder/.env')
  const base = 'VARANDA_DOMAIN=example.org\nVARANDA_ASSOCIATION=' + 'a'.repeat(64) + '\nVARANDA_GOOGLE_CLIENT_ID=id\nVARANDA_GOOGLE_CLIENT_SECRET=secret\n'
  // Only the conferir_antes function is run (never the script itself), with
  // git stubbed to report a clean tree.
  const run = (extra) => {
    fs.writeFileSync(envFile, base + extra)
    const script = [
      'set -u',
      "log() { printf '%s\\n' \"$*\" >&2; }",
      'git() { case "$1" in status) ;; *) return 0 ;; esac; }',
      'target=HEAD',
      "domain_re='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'",
      "assoc_re='^[0-9a-fA-F]{64}$'",
      "moderator_re='^[^[:space:],@]+@[^[:space:],@]+$'",
      "limite_re='^[1-9][0-9]{0,7}$'",
      shText.match(/^origem_re='[^'\n]*'$/m)[0],
      shText.match(/^limites_conta='[^'\n]*'$/m)[0],
      'root=' + JSON.stringify(dir),
      SOURCE_WELL_KNOWN,
      shText.slice(shText.indexOf('\nconferir_antes() {') + 1, shText.indexOf('\n}\n', shText.indexOf('\nconferir_antes() {')) + 3),
      'conferir_antes'
    ].join('\n')
    return spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  }
  const shText = fs.readFileSync(SCRIPT, 'utf8')
  const okRun = run('')
  t.is(okRun.status, 0, 'an .env without the limit lines passes: ' + okRun.stderr)
  const good = run('VARANDA_MAX_MEMBERS=500\nVARANDA_ACCOUNT_RATE=\n')
  t.is(good.status, 0, 'a valid value and an empty one pass: ' + good.stderr)
  for (const bad of ['abc', '0']) {
    const res = run('VARANDA_MAX_MEMBERS=' + bad + '\n')
    t.is(res.status, 1, 'VARANDA_MAX_MEMBERS=' + bad + ' exits 1')
    t.ok(res.stderr.includes('VARANDA_MAX_MEMBERS inválido em deploy/seeder/.env'), 'says the value is invalid')
    t.absent(res.stderr.includes('=' + bad) || res.stdout.includes(bad), 'the value is not echoed')
  }
  // The range is the account service's, not only the shape: a value it would
  // refuse at start fails here, before any container is replaced.
  const top = run('VARANDA_MAX_MEMBERS=4096\n')
  t.is(top.status, 0, 'VARANDA_MAX_MEMBERS=4096 passes: ' + top.stderr)
  for (const [name, bad] of [['VARANDA_MAX_MEMBERS', '4097'], ['VARANDA_ACCOUNT_RATE', '10001']]) {
    const res = run(name + '=' + bad + '\n')
    t.is(res.status, 1, name + '=' + bad + ' exits 1')
    t.ok(res.stderr.includes(name + ' inválido em deploy/seeder/.env'), 'says the value is invalid')
    t.absent(res.stderr.includes(bad) || res.stdout.includes(bad), 'the value is not echoed')
  }
  // Compose passes a quoted value verbatim (comment included), so a quoted
  // value is refused instead of being cleaned up here; an unquoted trailing
  // comment is dropped by Compose and here alike.
  for (const quoted of ['"300 # vagas"', "'300'"]) {
    const res = run('VARANDA_MAX_MEMBERS=' + quoted + '\n')
    t.is(res.status, 1, 'a quoted VARANDA_MAX_MEMBERS exits 1')
    t.ok(res.stderr.includes('VARANDA_MAX_MEMBERS inválido em deploy/seeder/.env'), 'says the quoted value is invalid')
  }
  const commented = run('VARANDA_MAX_MEMBERS=300 # vagas\n')
  t.is(commented.status, 0, 'an unquoted value with a trailing comment passes: ' + commented.stderr)
  t.is(run('VARANDA_MAX_MEMBERS = 4097\n').status, 1, 'spaces around = do not hide an out-of-range value')
  // Surprise invites without the weekly number would stop the service at start.
  for (const extra of ['VARANDA_INVITE_DROPS=1\n', 'VARANDA_INVITE_DROPS=1\nVARANDA_INVITES_PER_WEEK=\n']) {
    const res = run(extra)
    t.is(res.status, 1, 'VARANDA_INVITE_DROPS without VARANDA_INVITES_PER_WEEK exits 1')
    t.ok(res.stderr.includes('VARANDA_INVITE_DROPS exige VARANDA_INVITES_PER_WEEK em deploy/seeder/.env'), 'says what is missing')
  }
  // The Feira weekly count needs the ordinary invites and the triage token.
  const token = 'ab'.repeat(32)
  for (const extra of ['VARANDA_FEIRA_INVITES_PER_WEEK=10\nVARANDA_TRIAGE_TOKEN=' + token + '\n',
    'VARANDA_FEIRA_INVITES_PER_WEEK=10\nVARANDA_INVITES_PER_WEEK=\nVARANDA_TRIAGE_TOKEN=' + token + '\n']) {
    const res = run(extra)
    t.is(res.status, 1, 'VARANDA_FEIRA_INVITES_PER_WEEK without VARANDA_INVITES_PER_WEEK exits 1')
    t.ok(res.stderr.includes('VARANDA_FEIRA_INVITES_PER_WEEK exige VARANDA_INVITES_PER_WEEK em deploy/seeder/.env'), 'says what is missing')
    t.absent(res.stderr.includes(token), 'the token is not echoed')
  }
  const noToken = run('VARANDA_FEIRA_INVITES_PER_WEEK=10\nVARANDA_INVITES_PER_WEEK=1\n')
  t.is(noToken.status, 1, 'VARANDA_FEIRA_INVITES_PER_WEEK without the triage token exits 1')
  t.ok(noToken.stderr.includes('VARANDA_FEIRA_INVITES_PER_WEEK exige VARANDA_TRIAGE_TOKEN em deploy/seeder/.env'), 'says the token is missing')
  const feira = run('VARANDA_FEIRA_INVITES_PER_WEEK=100\nVARANDA_INVITES_PER_WEEK=1\nVARANDA_TRIAGE_TOKEN=' + token + '\n')
  t.is(feira.status, 0, 'the pair and the knob pass: ' + feira.stderr)
  for (const bad of ['0', '101', 'abc']) {
    const res = run('VARANDA_FEIRA_INVITES_PER_WEEK=' + bad + '\nVARANDA_INVITES_PER_WEEK=1\nVARANDA_TRIAGE_TOKEN=' + token + '\n')
    t.is(res.status, 1, 'VARANDA_FEIRA_INVITES_PER_WEEK=' + bad + ' exits 1')
    t.ok(res.stderr.includes('VARANDA_FEIRA_INVITES_PER_WEEK inválido em deploy/seeder/.env'), 'says the value is invalid')
  }
  // The Feira origin is one lower-case https origin, or empty (routes off).
  for (const ok of ['', 'https://varanda.example', 'https://varanda.example:8443']) {
    t.is(run('VARANDA_FEIRA_ORIGIN=' + ok + '\n').status, 0, 'VARANDA_FEIRA_ORIGIN=' + ok + ' passes')
  }
  for (const bad of ['http://varanda.example', 'https://Varanda.example', 'https://varanda.example/', 'varanda.example', 'https://varanda.example/f']) {
    const res = run('VARANDA_FEIRA_ORIGIN=' + bad + '\n')
    t.is(res.status, 1, 'VARANDA_FEIRA_ORIGIN=' + bad + ' exits 1')
    t.ok(res.stderr.includes('VARANDA_FEIRA_ORIGIN inválido em deploy/seeder/.env'), 'says the origin is invalid')
  }
  // The post pages origin follows the same rule, on its own.
  for (const ok of ['', 'https://varanda.example', 'https://varanda.example:8443']) {
    t.is(run('VARANDA_POSTS_ORIGIN=' + ok + '\n').status, 0, 'VARANDA_POSTS_ORIGIN=' + ok + ' passes')
  }
  for (const bad of ['http://varanda.example', 'https://Varanda.example', 'https://varanda.example/', 'varanda.example', 'https://varanda.example/p']) {
    const res = run('VARANDA_POSTS_ORIGIN=' + bad + '\n')
    t.is(res.status, 1, 'VARANDA_POSTS_ORIGIN=' + bad + ' exits 1')
    t.ok(res.stderr.includes('VARANDA_POSTS_ORIGIN inválido em deploy/seeder/.env'), 'says the posts origin is invalid')
    t.absent(res.stderr.includes('VARANDA_FEIRA_ORIGIN'), 'not blamed on the Feira origin')
    const withFeira = run('VARANDA_FEIRA_ORIGIN=https://varanda.example\nVARANDA_POSTS_ORIGIN=' + bad + '\n')
    t.is(withFeira.status, 1, 'a valid Feira origin does not excuse a bad posts origin')
  }
  t.is(run('VARANDA_FEIRA_ORIGIN=https://varanda.example\nVARANDA_POSTS_ORIGIN=https://outra.example\n').status, 0, 'both origins set pass')
  const drops = run('VARANDA_INVITES_PER_WEEK=1\nVARANDA_INVITE_DROPS=1\n')
  t.is(drops.status, 0, 'both set passes: ' + drops.stderr)
  t.is(run('VARANDA_INVITE_DROPS=2\nVARANDA_INVITES_PER_WEEK=1\n').status, 1, 'VARANDA_INVITE_DROPS only takes 1')
})

test('compose.web.yaml: the seeder origin is VARANDA_FEIRA_ORIGIN, empty by default; the account origin is unchanged', (t) => {
  const webLines = fs.readFileSync(COMPOSE_WEB, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
  const hits = webLines.map((l, i) => [l.trim(), i]).filter(([l]) => l.startsWith('VARANDA_PUBLIC_ORIGIN:'))
  t.is(hits.length, 2, 'two services set VARANDA_PUBLIC_ORIGIN')
  const seederAt = webLines.findIndex((l) => /^ {2}seeder:\s*$/.test(l))
  const accountAt = webLines.findIndex((l) => /^ {2}account:\s*$/.test(l))
  const seederLine = hits.find(([, i]) => i > seederAt && (accountAt < seederAt || i < accountAt))
  t.ok(seederLine, 'one sits under the seeder service')
  t.is(seederLine[0], 'VARANDA_PUBLIC_ORIGIN: "${VARANDA_FEIRA_ORIGIN:-}"', 'seeder origin: empty unless VARANDA_FEIRA_ORIGIN') // eslint-disable-line no-template-curly-in-string
  t.ok(hits.some(([l]) => l === 'VARANDA_PUBLIC_ORIGIN: "https://${VARANDA_DOMAIN:?defina VARANDA_DOMAIN em deploy/seeder/.env}"'), 'account origin unchanged') // eslint-disable-line no-template-curly-in-string
  const example = fs.readFileSync(path.join(repoRoot, 'deploy/seeder/seeder.env.example'), 'utf8').split('\n')
  t.ok(example.some((l) => /^#VARANDA_FEIRA_ORIGIN=/.test(l)), 'seeder.env.example documents VARANDA_FEIRA_ORIGIN')
  t.ok(example.some((l) => /^#VARANDA_FEIRA_INVITES_PER_WEEK=10$/.test(l)), 'seeder.env.example documents VARANDA_FEIRA_INVITES_PER_WEEK')
})

// The post pages switch is its own variable, off by default, only on the
// seeder, and never derived from the Feira origin.
test('compose.web.yaml and seeder.env.example: VARANDA_POSTS_ORIGIN is optional, empty by default and only on the seeder', (t) => {
  const webLines = fs.readFileSync(COMPOSE_WEB, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
  const hits = webLines.map((l, i) => [l, i]).filter(([l]) => l.includes('VARANDA_POSTS_ORIGIN'))
  t.is(hits.length, 1, 'mentioned exactly once')
  const start = webLines.findIndex((l) => /^ {2}seeder:\s*$/.test(l))
  let end = webLines.length
  for (let i = start + 1; i < webLines.length; i++) {
    if (/^ {0,2}\S/.test(webLines[i])) { end = i; break }
  }
  t.ok(start !== -1 && hits[0][1] > start && hits[0][1] < end, 'it sits under the seeder service')
  t.is(hits[0][0].trim(), 'VARANDA_POSTS_ORIGIN: "${VARANDA_POSTS_ORIGIN:-}"', 'optional (:-), never :?, never the Feira origin') // eslint-disable-line no-template-curly-in-string
  const example = fs.readFileSync(path.join(repoRoot, 'deploy/seeder/seeder.env.example'), 'utf8').split('\n')
  const at = example.findIndex((l) => /^#VARANDA_POSTS_ORIGIN=https:\/\/varanda\.example$/.test(l))
  t.ok(at !== -1, 'seeder.env.example documents VARANDA_POSTS_ORIGIN, commented out (off)')
  t.absent(example.some((l) => /^VARANDA_POSTS_ORIGIN=/.test(l)), 'never set by default')
  const note = example.slice(Math.max(0, at - 8), at).join('\n')
  t.ok(/versão 48/.test(note), 'the comment ties it to Terms version 48')
})

test('deploy.sh: limites_conta matches the ranges in account.js LIMIT_ENV', (t) => {
  const accountJs = fs.readFileSync(path.join(repoRoot, 'apps/cli/lib/commands/account.js'), 'utf8')
  const block = accountJs.match(/const LIMIT_ENV = Object\.freeze\(\{([\s\S]*?)\}\)/)
  t.ok(block, 'LIMIT_ENV located in account.js')
  const fromJs = {}
  for (const m of block[1].matchAll(/(VARANDA_[A-Z_]+):\s*\['\w+',\s*(\d+),\s*(\d+)\]/g)) {
    fromJs[m[1]] = [Number(m[2]), Number(m[3])]
  }
  const line = shCode.match(/^limites_conta='([^'\n]*)'$/m)
  t.ok(line, 'limites_conta located in deploy.sh')
  const fromSh = {}
  for (const entry of line[1].split(/\s+/).filter(Boolean)) {
    const [name, min, max] = entry.split(':')
    fromSh[name] = [Number(min), Number(max)]
  }
  t.is(Object.keys(fromJs).length, 8, 'eight limits in account.js')
  t.alike(fromSh, fromJs, 'same names and ranges')
  // The shape check allows at most 8 digits, so every max must fit in it.
  for (const [name, [, max]] of Object.entries(fromSh)) t.ok(max < 1e8, name + ' max fits limite_re')
})

test('compose files: seeder and account carry a permanent VARANDA_START_WAIT, and account has a 30 s stop grace', (t) => {
  const composeLines = (file) => fs.readFileSync(path.join(repoRoot, 'deploy/seeder', file), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
  const serviceBlock = (ls, name) => {
    const start = ls.findIndex((l) => l === '  ' + name + ':')
    if (start === -1) return ''
    let end = ls.length
    for (let i = start + 1; i < ls.length; i++) {
      if (/^ {0,2}\S/.test(ls[i])) { end = i; break }
    }
    return ls.slice(start, end).join('\n')
  }
  const seeder = serviceBlock(composeLines('compose.yaml'), 'seeder')
  t.ok(/^ {6}VARANDA_START_WAIT: "300"\s*$/m.test(seeder), 'seeder (compose.yaml) sets VARANDA_START_WAIT: "300"')
  const account = serviceBlock(composeLines('compose.web.yaml'), 'account')
  t.ok(/^ {6}VARANDA_START_WAIT: "300"\s*$/m.test(account), 'account (compose.web.yaml) sets VARANDA_START_WAIT: "300"')
  t.ok(/^ {4}stop_grace_period: 30s\s*$/m.test(account), 'account has stop_grace_period: 30s')
})

// The CDN variables (all off unless set). The Caddyfile reads both from the
// web container's environment, so compose passes them there, empty by default.
test('compose.web.yaml: the Caddy web service passes VARANDA_TRUSTED_PROXIES and VARANDA_MEDIA_ORIGIN, empty by default', (t) => {
  const webLines = fs.readFileSync(COMPOSE_WEB, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
  const start = webLines.findIndex((l) => /^ {2}web:\s*$/.test(l))
  let end = webLines.length
  for (let i = start + 1; i < webLines.length; i++) {
    if (/^ {0,2}\S/.test(webLines[i])) { end = i; break }
  }
  t.ok(start !== -1, 'web service found')
  const web = webLines.slice(start, end)
  for (const name of ['VARANDA_TRUSTED_PROXIES', 'VARANDA_MEDIA_ORIGIN']) {
    t.is(webLines.filter((l) => l.includes(name)).length, 1, name + ' appears once in compose.web.yaml')
    t.ok(web.includes('      ' + name + ': "${' + name + ':-}"'), name + ' is optional (:-), empty by default, under the web service')
  }
  const example = fs.readFileSync(path.join(repoRoot, 'deploy/seeder/.env.example'), 'utf8').split('\n')
  for (const name of ['VARANDA_TRUSTED_PROXIES', 'VARANDA_MEDIA_ORIGIN']) {
    t.ok(example.includes(name + '='), name + ' is documented, empty, in .env.example')
  }
})

// A CDN origin needs the CDN's ranges too (VARANDA_TRUSTED_PROXIES), or every
// client of /media/* would share one per-address limit.
const CDN = 'VARANDA_TRUSTED_PROXIES=203.0.113.0/24\n'

test('deploy.sh: conferir_antes accepts an empty or https origin in VARANDA_MEDIA_ORIGIN and refuses anything else', (t) => {
  if (!hasBash(t)) return
  const shText = fs.readFileSync(SCRIPT, 'utf8')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-deploy-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'deploy/seeder'), { recursive: true })
  const envFile = path.join(dir, 'deploy/seeder/.env')
  const base = 'VARANDA_DOMAIN=example.org\nVARANDA_ASSOCIATION=' + 'a'.repeat(64) + '\nVARANDA_GOOGLE_CLIENT_ID=id\nVARANDA_GOOGLE_CLIENT_SECRET=secret\n'
  const run = (extra) => {
    fs.writeFileSync(envFile, base + extra)
    const script = [
      'set -u',
      "log() { printf '%s\\n' \"$*\" >&2; }",
      'git() { case "$1" in status) ;; *) return 0 ;; esac; }',
      'target=HEAD',
      "domain_re='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'",
      "assoc_re='^[0-9a-fA-F]{64}$'",
      "moderator_re='^[^[:space:],@]+@[^[:space:],@]+$'",
      "limite_re='^[1-9][0-9]{0,7}$'",
      shText.match(/^origem_re='[^'\n]*'$/m)[0],
      shText.match(/^limites_conta='[^'\n]*'$/m)[0],
      "media_origin=''",
      'root=' + JSON.stringify(dir),
      SOURCE_WELL_KNOWN,
      shText.slice(shText.indexOf('\nconferir_antes() {') + 1, shText.indexOf('\n}\n', shText.indexOf('\nconferir_antes() {')) + 3),
      'conferir_antes',
      'printf "origin=[%s]\\n" "$media_origin"'
    ].join('\n')
    return spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  }
  const none = run('')
  t.is(none.status, 0, 'an .env without the line passes: ' + none.stderr)
  t.ok(none.stdout.includes('origin=[]'), 'and leaves it empty')
  t.is(run('VARANDA_MEDIA_ORIGIN=\n').status, 0, 'an empty value passes')
  const good = run(CDN + 'VARANDA_MEDIA_ORIGIN=https://midia.exemplo.org # CDN\n')
  t.is(good.status, 0, 'an https origin with a trailing comment passes: ' + good.stderr)
  t.ok(good.stdout.includes('origin=[https://midia.exemplo.org]'), 'and is read without the comment')
  t.is(run(CDN + 'VARANDA_MEDIA_ORIGIN=https://midia.exemplo.org:8443\n').status, 0, 'a port passes')
  for (const bad of ['http://midia.exemplo.org', 'https://midia.exemplo.org/', 'https://midia.exemplo.org/x', 'midia.exemplo.org',
    'https://MIDIA.exemplo.org', 'https://*.exemplo.org', 'https://u@midia.exemplo.org', 'https://midia.exemplo.org?x=1', '"https://midia.exemplo.org"']) {
    const res = run('VARANDA_MEDIA_ORIGIN=' + bad + '\n')
    t.is(res.status, 1, 'VARANDA_MEDIA_ORIGIN=' + bad + ' is refused')
    t.ok(res.stderr.includes('VARANDA_MEDIA_ORIGIN inválido em deploy/seeder/.env'), 'says which variable')
  }
})

// conferir_antes of deploy.sh on a fixture .env: { status, stderr, stdout }.
function runConferirAntes (t, extra) {
  const shText = fs.readFileSync(SCRIPT, 'utf8')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-deploy-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'deploy/seeder'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'deploy/seeder/.env'), 'VARANDA_DOMAIN=example.org\nVARANDA_ASSOCIATION=' + 'a'.repeat(64) +
    '\nVARANDA_GOOGLE_CLIENT_ID=id\nVARANDA_GOOGLE_CLIENT_SECRET=secret\n' + extra)
  const script = [
    'set -u',
    "log() { printf '%s\\n' \"$*\" >&2; }",
    'git() { case "$1" in status) ;; *) return 0 ;; esac; }',
    'target=HEAD',
    "domain_re='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'",
    "assoc_re='^[0-9a-fA-F]{64}$'",
    "moderator_re='^[^[:space:],@]+@[^[:space:],@]+$'",
    "limite_re='^[1-9][0-9]{0,7}$'",
    shText.match(/^origem_re='[^'\n]*'$/m)[0],
    shText.match(/^limites_conta='[^'\n]*'$/m)[0],
    "media_origin=''",
    "trusted_proxies=''",
    'root=' + JSON.stringify(dir),
    SOURCE_WELL_KNOWN,
    shText.slice(shText.indexOf('\nconferir_antes() {') + 1, shText.indexOf('\n}\n', shText.indexOf('\nconferir_antes() {')) + 3),
    'conferir_antes',
    'printf "proxies=[%s]\\n" "$trusted_proxies"'
  ].join('\n')
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' })
}

// The accepted and refused values of VARANDA_TRUSTED_PROXIES, shared with update.test.js.
const PROXIES_OK = [
  '203.0.113.0/24', '10.0.0.0/8', '203.0.113.7/32', '2001:db8::/32', '2001:db8::1/128', '::1/128', '2001:0db8:0000:0000:0000:0000:0000:0000/32',
  'fe80::/16', '1:2:3:4:5:6:7::/32', '::2:3:4:5:6:7:8/32',
  '173.245.48.0/20 103.21.244.0/22 2400:cb00::/32 2606:4700::/32', '203.0.113.0/24 # os do CDN'
]
const PROXIES_BAD = [
  'private_ranges', '203.0.113.0/24 private_ranges', 'private_ranges 203.0.113.0/24', '0.0.0.0/0', '0.0.0.0/7', '1.0.0.0/7', '128.0.0.0/1', '2001::/15', '::/0',
  '203.0.113.0', '2001:db8::', '203.0.113.0/', '/24', '203.0.113.0/33', '203.0.113.0/024', '203.0.113.0/-1', '2001:db8::/129', '2001:db8::/0129',
  '203.0.113.256/24', '203.0.113/24', '203.0.113.1.1/24', '203.0.113.00/24', '203.0.113.0/24/8', 'a/16', 'dead/16', '1234/16',
  '203.0.113.0/24,10.0.0.0/8', '203.0.113.0/24;10.0.0.0/8', '203.0.113.0/24  10.0.0.0/8', '203.0.113.0/24\t10.0.0.0/8', '203.0.113.0/24}', '203.0.113.0/24 }', '{', '}',
  '"203.0.113.0/24"', "'203.0.113.0/24'", '203.0.113.0/24 {$X}', '*', 'all',
  '2001:db8:::1/32', '2001::db8::1/32', '1:2:3:4:5:6:7/32', '1:2:3:4:5:6:7:8:9/32', '1:2:3:4:5:6:7::8/32', '12345::/32', ':1::2/32', '1:/32', '1::2:/32', ':/32',
  '2001:db8::1.2.3.4/32', 'g::/32', '2001:db8:/32'
]

test('deploy.sh: conferir_antes accepts empty or CDN CIDRs in VARANDA_TRUSTED_PROXIES and refuses anything else', (t) => {
  if (!hasBash(t)) return
  const none = runConferirAntes(t, '')
  t.is(none.status, 0, 'an .env without the line passes: ' + none.stderr)
  t.ok(none.stdout.includes('proxies=[]'), 'and leaves it empty')
  t.is(runConferirAntes(t, 'VARANDA_TRUSTED_PROXIES=\n').status, 0, 'an empty value passes')
  for (const ok of PROXIES_OK) {
    const res = runConferirAntes(t, 'VARANDA_TRUSTED_PROXIES=' + ok + '\n')
    t.is(res.status, 0, 'VARANDA_TRUSTED_PROXIES=' + ok + ' passes: ' + res.stderr)
  }
  const read = runConferirAntes(t, 'VARANDA_TRUSTED_PROXIES=203.0.113.0/24 2001:db8::/32 # CDN\n')
  t.ok(read.stdout.includes('proxies=[203.0.113.0/24 2001:db8::/32]'), 'it is read without the comment')
  for (const bad of PROXIES_BAD) {
    const res = runConferirAntes(t, 'VARANDA_TRUSTED_PROXIES=' + bad + '\n')
    t.is(res.status, 1, 'VARANDA_TRUSTED_PROXIES=' + bad + ' is refused')
    t.ok(res.stderr.includes('VARANDA_TRUSTED_PROXIES inválido em deploy/seeder/.env'), 'says which variable')
  }
})

test('deploy.sh: conferir_antes refuses VARANDA_MEDIA_ORIGIN without VARANDA_TRUSTED_PROXIES', (t) => {
  if (!hasBash(t)) return
  const origin = 'VARANDA_MEDIA_ORIGIN=https://midia.exemplo.org\n'
  for (const extra of [origin, 'VARANDA_TRUSTED_PROXIES=\n' + origin, 'VARANDA_TRUSTED_PROXIES= # nada\n' + origin]) {
    const res = runConferirAntes(t, extra)
    t.is(res.status, 1, 'a CDN origin with no ranges is refused')
    t.ok(res.stderr.includes('VARANDA_MEDIA_ORIGIN exige VARANDA_TRUSTED_PROXIES em deploy/seeder/.env'), 'says what is missing')
  }
  const both = runConferirAntes(t, 'VARANDA_TRUSTED_PROXIES=203.0.113.0/24\n' + origin)
  t.is(both.status, 0, 'with both set it passes: ' + both.stderr)
  const proxiesOnly = runConferirAntes(t, 'VARANDA_TRUSTED_PROXIES=203.0.113.0/24\n')
  t.is(proxiesOnly.status, 0, 'ranges without an origin pass: ' + proxiesOnly.stderr)
  // A malformed range is reported as such, not as a missing one.
  const bad = runConferirAntes(t, 'VARANDA_TRUSTED_PROXIES=private_ranges\n' + origin)
  t.ok(bad.stderr.includes('VARANDA_TRUSTED_PROXIES inválido'), 'a malformed value is refused as malformed')
})

// docker compose reads the .env with its own parser, which also takes
// `export NAME=value` and `NAME: value`; the sed reader of the script sees
// neither, would validate nothing and Caddy would get the raw text.
test('deploy.sh: conferir_antes refuses an .env line that names the CDN variables in a form the reader does not match', (t) => {
  if (!hasBash(t)) return
  const origin = 'https://midia.exemplo.org'
  for (const [line, name] of [
    ['export VARANDA_TRUSTED_PROXIES=0.0.0.0/0', 'VARANDA_TRUSTED_PROXIES'],
    ['  export   VARANDA_TRUSTED_PROXIES=203.0.113.0/24', 'VARANDA_TRUSTED_PROXIES'],
    ['VARANDA_TRUSTED_PROXIES: 0.0.0.0/0', 'VARANDA_TRUSTED_PROXIES'],
    ['VARANDA_TRUSTED_PROXIES : 203.0.113.0/24', 'VARANDA_TRUSTED_PROXIES'],
    ['export VARANDA_MEDIA_ORIGIN=' + origin, 'VARANDA_MEDIA_ORIGIN'],
    ['VARANDA_MEDIA_ORIGIN: ' + origin, 'VARANDA_MEDIA_ORIGIN']
  ]) {
    for (const extra of [line + '\n', CDN + line + '\n']) {
      const res = runConferirAntes(t, extra)
      t.is(res.status, 1, JSON.stringify(line) + ' is refused')
      t.ok(res.stderr.includes(name + ' em deploy/seeder/.env fora do formato NOME=valor'), 'says which variable')
    }
  }
  // The plain form and unrelated names still pass.
  t.is(runConferirAntes(t, CDN + 'VARANDA_MEDIA_ORIGIN=' + origin + '\n').status, 0, 'NAME=value passes')
  t.is(runConferirAntes(t, '  VARANDA_TRUSTED_PROXIES = 203.0.113.0/24\n').status, 0, 'spaces around = pass (the reader takes them)')
  t.is(runConferirAntes(t, '# export VARANDA_TRUSTED_PROXIES=0.0.0.0/0\nVARANDA_MEDIA_ORIGIN_OUTRA: x\n').status, 0, 'a comment and another name pass')
})

// docker compose prefers a variable exported in the invoking shell to the .env,
// so an inherited VARANDA_TRUSTED_PROXIES would skip the validation above.
// Nothing in the script reads either variable from the environment (the build
// gets the checked origin explicitly), so the script drops them first thing.
test('deploy.sh: unsets VARANDA_TRUSTED_PROXIES and VARANDA_MEDIA_ORIGIN before anything can call docker compose', (t) => {
  if (!hasBash(t)) return
  const sh = fs.readFileSync(SCRIPT, 'utf8')
  const unsetLine = 'unset VARANDA_TRUSTED_PROXIES VARANDA_MEDIA_ORIGIN'
  const at = sh.split('\n').indexOf(unsetLine)
  t.ok(at !== -1, 'the unset line exists')
  const code = sh.split('\n').filter((l) => !/^\s*#/.test(l))
  t.ok(code.indexOf(unsetLine) < code.findIndex((l) => /\bdocker\b/.test(l)), 'and comes before the first docker call')
  t.ok(code.indexOf(unsetLine) < code.findIndex((l) => /^[a-z_]+\(\) \{$/.test(l)), 'and before the first function')
  t.absent(code.some((l) => /\$\{?VARANDA_(TRUSTED_PROXIES|MEDIA_ORIGIN)\b/.test(l)), 'nothing reads either variable from the environment')
  // The harness cannot run the whole script, so run the line itself with the variables inherited.
  const res = spawnSync('bash', ['-c', unsetLine + '\nenv'], { encoding: 'utf8', env: { ...process.env, VARANDA_TRUSTED_PROXIES: '0.0.0.0/0', VARANDA_MEDIA_ORIGIN: 'https://x.exemplo.org' } })
  t.is(res.status, 0)
  t.absent(/^VARANDA_(TRUSTED_PROXIES|MEDIA_ORIGIN)=/m.test(res.stdout), 'neither variable survives it')
})

// The /media/* per-address limit of the Caddyfile (480 per 10 s) is 25% of the
// global budget only from a media rate of 192 per second: below it, deploy.sh warns.
test('deploy.sh: conferir_antes warns, without refusing, when VARANDA_MEDIA_RATE leaves the /media/* per-address limit above 25%', (t) => {
  if (!hasBash(t)) return
  const warn = 'VARANDA_MEDIA_RATE='
  const aviso = (res) => res.stderr.includes('aviso: VARANDA_MEDIA_RATE=')
  const low = runConferirAntes(t, warn + '100\n')
  t.is(low.status, 0, 'a low rate is not refused: ' + low.stderr)
  t.ok(aviso(low), 'but is warned about')
  const edge = runConferirAntes(t, warn + '191 # baixo\n')
  t.is(edge.status, 0, '191 passes')
  t.ok(aviso(edge), '191 per second (1910 per 10 s, under 1920) warns')
  for (const quiet of ['', warn + '\n', warn + '192\n', warn + '256\n', warn + '100000\n']) {
    const res = runConferirAntes(t, quiet)
    t.is(res.status, 0, 'passes: ' + res.stderr)
    t.absent(aviso(res), 'no warning for ' + (quiet.trim() || 'no value'))
  }
  t.is(runConferirAntes(t, warn + 'abc\n').status, 1, 'a malformed rate is still refused')
})

// /varanda.json is the Caddyfile's own body, so the probe compares byte for
// byte with the JSON the Caddyfile serves: the media key last, only when set
// (and only when the Caddyfile at the target reads the variable).
test('deploy.sh: servido_json expects the media key exactly when VARANDA_MEDIA_ORIGIN is set', (t) => {
  if (!hasBash(t)) return
  const shText = fs.readFileSync(SCRIPT, 'utf8')
  const fn = shText.match(/^servido_json\(\) \{\n[\s\S]*?^\}\n/m)
  t.ok(fn, 'servido_json located')
  if (!fn) return
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-json-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'deploy/seeder'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'state'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  // curl writes the body in fixture/served to the -o file.
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then out=$2; fi; shift; done\ncp ' +
    JSON.stringify(path.join(dir, 'served')) + ' "$out"\n', { mode: 0o755 })
  const ASSOC = 'a'.repeat(64)
  const ORIGIN = 'https://midia.exemplo.org'
  const caddyfile = path.join(dir, 'deploy/seeder/Caddyfile')
  const probe = (served, { media, reads = true }) => {
    fs.writeFileSync(path.join(dir, 'served'), served)
    fs.writeFileSync(caddyfile, reads ? 'respond `{"v":1,"association":"{$VARANDA_ASSOCIATION}"}`\n# {$VARANDA_MEDIA_ORIGIN:}\n' : 'respond `{"v":1}`\n')
    const script = 'root=' + JSON.stringify(dir) + '\nstate=' + JSON.stringify(path.join(dir, 'state')) + '\ndomain=app.exemplo.org\nassoc=' + ASSOC +
      '\nmedia_origin=' + JSON.stringify(media) + '\n' + fn[0] + 'servido_json\n'
    return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } }).status
  }
  const without = '{"v":1,"association":"' + ASSOC + '"}'
  const withMedia = '{"v":1,"association":"' + ASSOC + '","media":"' + ORIGIN + '"}'
  t.is(probe(without, { media: '' }), 0, 'unset: the body without media passes')
  t.not(probe(withMedia, { media: '' }), 0, 'unset: a body with media fails')
  t.is(probe(withMedia, { media: ORIGIN }), 0, 'set: the body with media as the last key passes')
  t.not(probe(without, { media: ORIGIN }), 0, 'set: a body without media fails')
  t.not(probe('{"v":1,"association":"' + ASSOC + '","media":"https://outra.exemplo.org"}', { media: ORIGIN }), 0, 'set: another origin fails')
  t.not(probe('{"v":1,"media":"' + ORIGIN + '","association":"' + ASSOC + '"}', { media: ORIGIN }), 0, 'set: media before association fails')
  t.is(probe(without, { media: ORIGIN, reads: false }), 0, 'set, but a Caddyfile that does not read it (a way back): the old body passes')
  t.ok(shText.includes("printf ',\"media\":\"%s\"' \"$media_origin\""), 'the key format matches the Caddyfile body')
})

// The web build bakes the origin into the service worker CSP (finish-web.js
// reads process.env.VARANDA_MEDIA_ORIGIN and refuses a malformed value), so the
// deploy path hands it to the build only when it is set.
test('deploy.sh and build-web.sh: the build gets VARANDA_MEDIA_ORIGIN only when set', (t) => {
  if (!hasBash(t)) return
  const sh = fs.readFileSync(SCRIPT, 'utf8')
  t.ok(sh.includes('env -u VARANDA_MEDIA_ORIGIN EXPO_PUBLIC_VARANDA_COMMIT="$target" ${media_env[@]+"${media_env[@]}"} bash deploy/seeder/build-web.sh "$stage"'), // eslint-disable-line no-template-curly-in-string
    'construir_web drops an inherited value and passes the validated one only when set')
  t.ok(sh.includes('media_env=(VARANDA_MEDIA_ORIGIN="$media_origin")'), 'the value comes from the checked .env')

  const BUILD = path.join(repoRoot, 'deploy/seeder/build-web.sh')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-build-media-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'deploy/seeder'), { recursive: true })
  fs.copyFileSync(BUILD, path.join(dir, 'deploy/seeder/build-web.sh'))
  fs.copyFileSync(WELL_KNOWN, path.join(dir, 'deploy/seeder/well-known.sh'))
  const stage = path.join(dir, 'stage')
  const stageDist = path.join(stage, 'apps/app/dist')
  fs.mkdirSync(stageDist, { recursive: true })
  writeWebDist(stageDist)
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const args = path.join(dir, 'docker-args')
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$@" > ' + JSON.stringify(args) + '\n', { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'stat'), '#!/bin/sh\necho ' + process.getuid() + ':' + process.getgid() + '\n', { mode: 0o755 })
  const baseEnv = { ...process.env, PATH: bin + path.delimiter + process.env.PATH }
  delete baseEnv.EXPO_PUBLIC_VARANDA_COMMIT
  delete baseEnv.VARANDA_MEDIA_ORIGIN
  const ORIGIN = 'https://midia.exemplo.org'
  const run = (extraEnv, cliArgs = [stage]) => {
    fs.rmSync(args, { force: true })
    return spawnSync('bash', [path.join(dir, 'deploy/seeder/build-web.sh'), ...cliArgs], { encoding: 'utf8', env: { ...baseEnv, ...extraEnv } })
  }
  const passed = () => fs.readFileSync(args, 'utf8').split('\n')

  const off = run({})
  t.is(off.status, 0, 'builds with the variable unset: ' + off.stderr)
  t.absent(passed().some((a) => a.includes('VARANDA_MEDIA_ORIGIN')), 'nothing about the media origin reaches the build')
  const empty = run({ VARANDA_MEDIA_ORIGIN: '' })
  t.is(empty.status, 0, 'builds with it empty: ' + empty.stderr)
  t.absent(passed().some((a) => a.includes('VARANDA_MEDIA_ORIGIN')), 'an empty value is not passed either')
  const on = run({ VARANDA_MEDIA_ORIGIN: ORIGIN })
  t.is(on.status, 0, 'builds with a valid origin: ' + on.stderr)
  const list = passed()
  t.ok(list.includes('VARANDA_MEDIA_ORIGIN=' + ORIGIN), 'the origin is handed to the build container')
  t.is(list[list.indexOf('VARANDA_MEDIA_ORIGIN=' + ORIGIN) - 1], '-e', 'as an environment variable')
  for (const bad of ['http://midia.exemplo.org', ORIGIN + '/x', 'https://*.exemplo.org']) {
    const res = run({ VARANDA_MEDIA_ORIGIN: bad })
    t.not(res.status, 0, 'a malformed origin is refused: ' + bad)
    t.ok(res.stderr.includes('VARANDA_MEDIA_ORIGIN inválido em deploy/seeder/.env'), 'says which variable')
    t.absent(fs.existsSync(args), 'refused before the build')
  }

  // Publishing (no argument) reads deploy/seeder/.env and ignores the caller's environment.
  const www = path.join(dir, 'deploy/seeder/www')
  const envFile = path.join(dir, 'deploy/seeder/.env')
  fs.mkdirSync(path.join(dir, 'apps/app/dist'), { recursive: true })
  writeWebDist(path.join(dir, 'apps/app/dist'))
  fs.writeFileSync(envFile, 'VARANDA_MEDIA_ORIGIN=' + ORIGIN + ' # CDN\n')
  const pub = run({ VARANDA_MEDIA_ORIGIN: 'https://ignorada.exemplo.org' }, [])
  t.is(pub.status, 0, 'publishes with the origin in .env: ' + pub.stderr)
  t.ok(passed().includes('VARANDA_MEDIA_ORIGIN=' + ORIGIN), 'the .env value (comment dropped) reaches the build, not the caller\'s')
  t.ok(fs.existsSync(path.join(www, 'index.html')), 'and the app is published')
  fs.writeFileSync(envFile, 'VARANDA_MEDIA_ORIGIN=\n')
  const pubOff = run({ VARANDA_MEDIA_ORIGIN: ORIGIN }, [])
  t.is(pubOff.status, 0, 'publishes with it empty in .env: ' + pubOff.stderr)
  t.absent(passed().some((a) => a.includes('VARANDA_MEDIA_ORIGIN')), 'an empty .env line passes nothing, whatever the caller had')
  fs.writeFileSync(envFile, 'VARANDA_MEDIA_ORIGIN=ftp://x\n')
  const pubBad = run({}, [])
  t.not(pubBad.status, 0, 'a malformed .env value is refused')
  t.absent(fs.existsSync(args), 'before the build')
})
