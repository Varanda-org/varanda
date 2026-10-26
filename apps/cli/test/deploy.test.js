const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '../../..')
const WORKFLOW = path.join(repoRoot, '.github/workflows/deploy.yml')
const SCRIPT = path.join(repoRoot, 'deploy/seeder/deploy.sh')

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
  t.ok(check && deploy, 'both jobs found')

  t.ok(/^ {4}permissions:\s*\{\}\s*$/m.test(deploy), 'deploy job has permissions: {}')
  t.ok(/^ {4}needs:\s*check\s*$/m.test(deploy), 'deploy needs check')
  t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(deploy), 'deploy runs-on ubuntu-24.04')
  t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(check), 'check runs-on ubuntu-24.04')
  t.ok(/^ {6}name:\s*producao\s*$/m.test(deploy), 'deploy uses the producao environment')
  t.absent(/\buses:/.test(deploy), 'deploy job has no uses: (no third-party action)')
  t.absent(/^ {4}environment:/m.test(check), 'check job has no environment')

  const on = block(/^on:/, /^\S/)
  t.ok(/^ {2}push:\s*$/m.test(on) && /branches:\s*\[main\]/.test(on), 'push trigger on main only')
  t.ok(/^ {2}workflow_dispatch:/m.test(on), 'workflow_dispatch trigger')
  t.is((on.match(/^ {2}\S+:/gm) || []).length, 2, 'exactly two triggers')

  t.ok(/cancel-in-progress:\s*false/.test(code), 'cancel-in-progress is false')
  t.ok(/^ {2}group:\s*deploy-\$\{\{ github\.ref \}\}\s*$/m.test(code), 'concurrency group is per ref (deploy-<ref>)')
})

test('deploy.yml: both jobs carry the repository, branch and variable guards', (t) => {
  const guard = /^\s+if:\s*github\.repository == 'Varanda-org\/varanda' && github\.ref == 'refs\/heads\/main' && vars\.VARANDA_DEPLOY == 'true'\s*$/m
  t.ok(guard.test(check), 'check job is guarded')
  t.ok(guard.test(deploy), 'deploy job is guarded')
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

test('deploy.yml: check job order and ssh hardening', (t) => {
  const order = ['npm ci', 'npm run lint', 'npm test', 'npm run demo']
  const idx = order.map((cmd) => check.split('\n').findIndex((l) => new RegExp('^\\s+- run:\\s*' + cmd + '\\s*$').test(l)))
  t.ok(idx.every((i) => i !== -1), 'all four check commands present')
  t.alike([...idx].sort((a, b) => a - b), idx, 'npm ci, lint, test, demo in that order')

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
    '/account/mod/api/me'
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

test('Caddyfile: no handle /mod, and the CSP is unchanged', (t) => {
  const caddy = fs.readFileSync(CADDYFILE, 'utf8')
  t.absent(caddy.includes('handle /mod'), 'no handle /mod')
  const csp = caddy.split('\n').filter((l) => /^\s*Content-Security-Policy /.test(l))
  t.is(csp.length, 1, 'one CSP line')
  // Byte-identical to the B2 tree (Caddyfile:20): the panel is written for it.
  t.is(csp[0].trim(), 'Content-Security-Policy "default-src \'self\'; script-src \'self\' \'wasm-unsafe-eval\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; font-src \'self\' data:; connect-src \'self\' wss://{$VARANDA_DOMAIN}; manifest-src \'self\'; worker-src \'self\'; frame-ancestors \'none\'; base-uri \'none\'; form-action \'none\'; object-src \'none\'"', 'CSP line unchanged')
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
