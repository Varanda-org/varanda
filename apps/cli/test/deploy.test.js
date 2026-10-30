const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '../../..')
const WORKFLOW = path.join(repoRoot, '.github/workflows/deploy.yml')
const SCRIPT = path.join(repoRoot, 'deploy/seeder/deploy.sh')

// Optional seeder limits passed through compose.web.yaml (read by apps/cli/lib/cli.js).
const SEEDER_LIMITS = [
  'VARANDA_MAX_EXTERNAL', 'VARANDA_MAX_SOCKETS', 'VARANDA_FRAME_MEMORY',
  'VARANDA_MEDIA_MAX_IN_FLIGHT', 'VARANDA_MEDIA_RATE', 'VARANDA_MEDIA_BURST',
  'VARANDA_INDEX_MAX_IN_FLIGHT', 'VARANDA_INDEX_RATE', 'VARANDA_INDEX_BURST'
]

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
// The six test legs, each its own job (no matrix), gated by check.
const WORKERS = ['core-1', 'core-2', 'cli-1', 'cli-2', 'web-member', 'others']
const workers = Object.fromEntries(WORKERS.map((id) => [id, block(new RegExp('^ {2}' + id + ':\\s*$'), /^ {2}\S/)]))
const GUARD = "github\\.repository == 'Varanda-org\\/varanda' && github\\.ref == 'refs\\/heads\\/main' && vars\\.VARANDA_DEPLOY == 'true'"

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
  t.alike(jobs.sort(), [...WORKERS, 'check', 'deploy'].sort(), 'jobs are the six legs, check and deploy')
  t.absent(/^\s+strategy:/m.test(code), 'no matrix strategy')
  t.absent(/<<:/.test(code), 'no YAML merge keys')
  t.absent(yml.includes(String.fromCharCode(0x2014)), 'no em dash')

  t.ok(/^ {4}permissions:\s*\{\}\s*$/m.test(deploy), 'deploy job has permissions: {}')
  t.ok(/^ {4}needs:\s*check\s*$/m.test(deploy), 'deploy needs check')
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

  t.ok(/cancel-in-progress:\s*false/.test(code), 'cancel-in-progress is false')
  t.ok(/^ {2}group:\s*deploy-\$\{\{ github\.ref \}\}\s*$/m.test(code), 'concurrency group is per ref (deploy-<ref>)')
})

test('deploy.yml: every job carries the repository, branch and variable guards', (t) => {
  const guard = new RegExp('^ {4}if:\\s*' + GUARD + '\\s*$', 'm')
  for (const id of WORKERS) t.ok(guard.test(workers[id]), id + ' job is guarded')
  t.ok(guard.test(deploy), 'deploy job is guarded')
  // The gate runs even when a leg failed, was cancelled or was skipped, and
  // fails closed: a skipped check would read as passing.
  t.ok(new RegExp('^\\s+if:\\s*always\\(\\) && ' + GUARD + '\\s*$', 'm').test(check), 'check gate runs always() under the guard')
  t.ok(/^ {4}needs:\s*\[\s*core-1,\s*core-2,\s*cli-1,\s*cli-2,\s*web-member,\s*others\s*\]\s*$/m.test(check), 'check needs exactly the six legs')
  t.ok(/^\s+RESULTS:\s*\$\{\{ join\(needs\.\*\.result, ' '\) \}\}\s*$/m.test(check), 'check reads every leg result')
  t.ok(/^\s+\[ "\$#" -eq 6 \] \|\| exit 1\s*$/m.test(check), 'check requires exactly six results')
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
  t.absent(/workflow_run/.test(code), 'no workflow_run')
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
    '/account/mod/api/me',
    // The optional seeder limits are validated by shape before anything changes.
    ...SEEDER_LIMITS
  ]
  for (const s of required) t.ok(shCode.includes(s), 'contains ' + s)
  const nonEmpty = shLines.filter((l) => l.trim() !== '')
  t.is(nonEmpty[nonEmpty.length - 1], 'main "$@"', 'last line is main "$@"')
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

  for (const name of ['VARANDA_DIDIT_API_KEY', 'VARANDA_DIDIT_WORKFLOW_ID', 'VARANDA_HODLE_API_KEY']) {
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

for (const name of ['VARANDA_MAX_MEMBERS', 'VARANDA_ACCOUNT_MAX_CONNECTIONS', 'VARANDA_ACCOUNT_RATE', 'VARANDA_ACCOUNT_BURST', 'VARANDA_ACCOUNT_MAX_PENDING', 'VARANDA_INVITES_PER_WEEK', 'VARANDA_DIDIT_API_KEY', 'VARANDA_DIDIT_WORKFLOW_ID', 'VARANDA_DIDIT_DAILY_LIMIT', 'VARANDA_HODLE_API_KEY', 'VARANDA_HODLE_NETWORK', 'VARANDA_HODLE_MODE', 'VARANDA_HODLE_DAILY_LIMIT', 'VARANDA_HODLE_MAX_CENTS', 'VARANDA_HODLE_WEBHOOK_SECRETS', 'VARANDA_FEE_TRANSFER_CENTS', 'VARANDA_FEE_TRANSFER_BPS', 'VARANDA_FEE_PAYOUT_CENTS', 'VARANDA_FEE_PAYOUT_BPS', 'VARANDA_FEE_CRYPTO_CENTS', 'VARANDA_FEE_CRYPTO_BPS', 'VARANDA_FEE_DEPOSIT_CENTS', 'VARANDA_FEE_DEPOSIT_BPS', 'VARANDA_FEE_SWAP_BPS', 'VARANDA_FEE_TREASURY']) {
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
    t.is(hits[0][0].trim(), name + ': "${' + name + ':-}"', 'optional (:-), never :?')
  })
}

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
      'log() { printf "%s\\n" "$*" >&2; }\ngit() { return 0; }\n' + fn[0] + 'conferir_antes\n'
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
      'log() { printf "%s\\n" "$*" >&2; }\ngit() { return 0; }\n' + fn[0] + 'conferir_antes\n'
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
  const csp = caddy.split('\n').filter((l) => /^\s*Content-Security-Policy /.test(l))
  t.is(csp.length, 1, 'one CSP line')
  // Byte-identical to the B2 tree (Caddyfile:20): the panel is written for it.
  t.is(csp[0].trim(), 'Content-Security-Policy "default-src \'self\'; script-src \'self\' \'wasm-unsafe-eval\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; font-src \'self\' data:; connect-src \'self\' wss://{$VARANDA_DOMAIN} https://uploads.hodle.com.br; manifest-src \'self\'; worker-src \'self\'; frame-ancestors \'none\'; base-uri \'none\'; form-action \'none\'; object-src \'none\'"', 'CSP line unchanged')
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
  t.absent(caddy.includes('immutable'), 'the Caddyfile never sets immutable (it comes from the seeder)')
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
      shText.match(/^limites_conta='[^'\n]*'$/m)[0],
      'root=' + JSON.stringify(dir),
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
  t.is(Object.keys(fromJs).length, 6, 'six limits in account.js')
  t.alike(fromSh, fromJs, 'same names and ranges')
  // The shape check allows at most 8 digits, so every max must fit in it.
  for (const [name, [, max]] of Object.entries(fromSh)) t.ok(max < 1e8, name + ' max fits limite_re')
})
