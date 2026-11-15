'use strict'

// deploy/seeder/update.sh, the pull updater, plus its config example and
// systemd units. Static rules over the script text, then behavioural checks
// that run the script's functions under bash with docker, curl, systemctl,
// flock and chown replaced by shell functions. No Docker, no registry and no
// network.

const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '../../..')
const SEEDER = path.join(repoRoot, 'deploy/seeder')
const SCRIPT = path.join(SEEDER, 'update.sh')
const WELL_KNOWN = path.join(SEEDER, 'well-known.sh')
const OWNED = [
  'deploy/seeder/update.sh', 'deploy/seeder/update.conf.example',
  'deploy/seeder/varanda-update.service', 'deploy/seeder/varanda-update.timer',
  'apps/cli/test/update.test.js'
]

const sh = fs.readFileSync(SCRIPT, 'utf8')
const shLines = sh.split('\n')
// Comment lines are dropped so prose cannot satisfy or trip a rule.
const shCode = shLines.filter((l) => !/^\s*#/.test(l)).join('\n')

const SEEDER_LIMITS = [
  'VARANDA_MAX_EXTERNAL', 'VARANDA_MAX_SOCKETS', 'VARANDA_FRAME_MEMORY',
  'VARANDA_MEDIA_MAX_IN_FLIGHT', 'VARANDA_MEDIA_RATE', 'VARANDA_MEDIA_BURST',
  'VARANDA_INDEX_MAX_IN_FLIGHT', 'VARANDA_INDEX_RATE', 'VARANDA_INDEX_BURST'
]

const H = (c, n) => c.repeat(n)
const DIGEST = 'sha256:' + H('b', 64)
const SEEDER_REF = 'ghcr.io/varanda-org/varanda-seeder@' + DIGEST
const WEB_REF = 'ghcr.io/varanda-org/varanda-web@sha256:' + H('c', 64)
const COMMIT = H('1', 40)
const OLD_COMMIT = H('0', 40)
const OLD_SEEDER = 'ghcr.io/varanda-org/varanda-seeder@sha256:' + H('a', 64)
const OLD_WEB = 'ghcr.io/varanda-org/varanda-web@sha256:' + H('d', 64)
const COSIGN = 'ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:' + H('e', 64)
const ID_STABLE = 'https://github.com/Varanda-org/varanda/.github/workflows/promote.yml@refs/heads/main'
const ID_EDGE = 'https://github.com/Varanda-org/varanda/.github/workflows/release.yml@refs/heads/main'
const releaseLine = (seq, extra) => '{"v":1,"commit":"' + COMMIT + '","seq":' + seq + ',"web":"' + WEB_REF + '"' + (extra || '') + '}'
const FULL_ENV = 'VARANDA_DOMAIN=app.exemplo.org\nVARANDA_ASSOCIATION=' + H('a', 64) +
  '\nVARANDA_GOOGLE_CLIENT_ID=id\nVARANDA_GOOGLE_CLIENT_SECRET=segredo-ultra\n'
const record = (commit, seq, seeder, web) => 'commit=' + commit + '\nseq=' + seq + '\nseeder=' + seeder + '\nweb=' + web + '\n'

function hasBash (t) {
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    t.comment('bash not found: skipping the behavioural check')
    return false
  }
  return true
}

// Every external command the script talks to, as a shell function. Each call
// is appended to $CALLS; fixture files in $FIX steer the answers.
const STUBS = String.raw`
idof() {
  local v=''
  case $1 in sha256:*) printf '%s\n' "$1"; return 0 ;; esac
  if [ -f "$FIX/tags" ]; then
    v=$(awk -v k="$1" '$1 == k { v = $2 } END { print v }' "$FIX/tags")
  fi
  if [ -n "$v" ]; then printf '%s\n' "$v"; else printf 'sha256:id-%s\n' "$1"; fi
}
docker() {
  local a ultimo='' svc='' si wi
  for a in "$@"; do ultimo=$a; done
  case $1 in
    compose)
      si=$(printenv VARANDA_SEEDER_IMAGE || true)
      wi=$(printenv VARANDA_WEB_IMAGE || true)
      printf 'compose pwd=%s seeder=%s web=%s %s\n' "$PWD" "$si" "$wi" "$*" >>"$CALLS"
      return 0 ;;
  esac
  printf 'docker %s\n' "$*" >>"$CALLS"
  case $1 in
    pull)
      if [ -f "$FIX/pull_fail" ]; then return 1; fi
      case $2 in *:edge | *:stable) printf 'stable: Pulling\nDigest: %s\nStatus: ok\n' "$(cat "$FIX/digest")" ;; esac
      ;;
    run)
      case " $* " in
        *" verify "*)
          printf '%s\n' "$*" >>"$FIX/cosign_calls"
          if [ -f "$FIX/cosign_fail" ]; then return 1; fi ;;
        *" --entrypoint cat "*) cat "$FIX/release.json" ;;
      esac
      ;;
    create) printf 'cafe0001\n' ;;
    cp)
      case $2 in
        *:/app/deploy/seeder) cp -Rp "$FIX/bundle" "$3" ;;
        *:/srv/web/.) cp -Rp "$FIX/web/." "$3" ;;
        *) return 1 ;;
      esac
      ;;
    image)
      case $2 in
        tag) printf '%s %s\n' "$4" "$(idof "$3")" >>"$FIX/tags" ;;
        inspect) idof "$ultimo" ;;
      esac
      ;;
    inspect)
      case "$*" in
        *working_dir*) cat "$FIX/wd_$ultimo" 2>/dev/null || cat "$FIX/workdir" 2>/dev/null || true ;;
        *) cat "$FIX/img_$ultimo" ;;
      esac
      ;;
    ps)
      if [ -f "$FIX/ps_fail" ]; then return 1; fi
      # One-off (compose run) containers: $FIX/ps_oneoff_running are running,
      # $FIX/ps_oneoff_stopped are not; only ps -a lists the stopped ones.
      case " $* " in
        *" label=com.docker.compose.oneoff=True "*)
          cat "$FIX/ps_oneoff_running" 2>/dev/null || true
          case " $* " in *" -a "*) cat "$FIX/ps_oneoff_stopped" 2>/dev/null || true ;; esac
          return 0 ;;
      esac
      for a in "$@"; do
        case $a in label=com.docker.compose.service=*) svc=$` + '{a#label=com.docker.compose.service=}' + String.raw` ;; esac
      done
      if [ -n "$svc" ]; then cat "$FIX/ps_$svc" 2>/dev/null || true
      else
        cat "$FIX/ps_seeder" "$FIX/ps_web" "$FIX/ps_account" 2>/dev/null || true
        case " $* " in
          *" label=com.docker.compose.oneoff=False "*) ;;
          *) cat "$FIX/ps_oneoff_running" "$FIX/ps_oneoff_stopped" 2>/dev/null || true ;;
        esac
      fi
      ;;
  esac
  return 0
}
# The seeder health endpoint answers $FIX/health_code; https://<domain>/<path>
# serves $FIX/served/<path> (_root for /), with $FIX/served/<path>.w as the
# -w output. A missing file is a failed request.
curl() {
  local a prev='' out='' url='' key
  printf 'curl %s\n' "$*" >>"$CALLS"
  for a in "$@"; do
    if [ "$prev" = -o ]; then out=$a; fi
    prev=$a
    url=$a
  done
  case $url in
    http://127.0.0.1:8788/health)
      if [ -f "$FIX/health_code" ]; then cat "$FIX/health_code"; return 0; fi
      printf '000'
      return 7 ;;
    https://*)
      key=$` + '{url#https://*/}' + String.raw`
      key=$` + '{key:-_root}' + String.raw`
      [ -f "$FIX/served/$key" ] || return 22
      if [ -n "$out" ] && [ "$out" != /dev/null ]; then cp "$FIX/served/$key" "$out"; fi
      if [ -f "$FIX/served/$key.w" ]; then cat "$FIX/served/$key.w"; fi
      return 0 ;;
  esac
  return 1
}
systemctl() { printf 'systemctl %s\n' "$*" >>"$CALLS"; }
install() { printf 'install %s\n' "$*" >>"$CALLS"; }
flock() { return 0; }
chown() { return 0; }
# Time moves only when the script sleeps, so a gate timeout ends at once.
sleep() { SECONDS=$((SECONDS + $` + '{1%.*}' + String.raw`)); }
uname() { cat "$FIX/uname" 2>/dev/null || printf 'x86_64\n'; }
dono_modo() {
  if [ -f "$FIX/dono_bad" ] && [ "$1" = "$(cat "$FIX/dono_bad")" ]; then printf '1000 755\n'; return 0; fi
  cat "$FIX/dono_modo" 2>/dev/null || printf '0 600\n'
}
trocar_atual() { rm -f "$releases/current"; ln -s "$1" "$releases/current"; }
# The gate is replaced unless $FIX/real_gate exists. $FIX/term_at_gate_<n>
# sends SIGTERM to the script during the n-th gate.
if [ ! -f "$FIX/real_gate" ]; then
verificar_saude() {
  local n
  n=$(cat "$FIX/gate_n" 2>/dev/null || printf '0')
  n=$((n + 1))
  printf '%s\n' "$n" >"$FIX/gate_n"
  printf 'gate %s %s\n' "$alvo_dir" "$alvo_seeder" >>"$CALLS"
  if [ -f "$FIX/term_at_gate_$n" ]; then kill -TERM $$; fi
  [ ! -f "$FIX/gate_fail_$n" ]
}
fi
`

// A temporary server: state, lock, config, releases and units under one
// directory, a bundle dir beside the "running" script, and the fixtures.
function server (t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-update-')))
  t.teardown(() => fs.rmSync(d, { recursive: true, force: true }))
  const p = (...rel) => path.join(d, ...rel)
  for (const dir of ['state', 'lock', 'etc', 'releases', 'units', 'aqui', 'fix/bundle', 'fix/web', 'checkout']) {
    fs.mkdirSync(p(dir), { recursive: true })
  }
  fs.writeFileSync(p('aqui/cosign.ref'), COSIGN + '\n')
  for (const f of ['compose.yaml', 'compose.web.yaml', 'compose.release.yaml', 'compose.release.web.yaml',
    'Caddyfile', 'well-known.sh', 'cosign.ref', 'varanda-update.service', 'varanda-update.timer']) {
    fs.writeFileSync(p('fix/bundle', f), f + '\n')
  }
  fs.writeFileSync(p('fix/bundle/update.sh'), '#!/usr/bin/env bash\n', { mode: 0o755 })
  for (const f of ['index.html', 'varanda-node.js', 'sw.js']) fs.writeFileSync(p('fix/web', f), f + '\n')
  fs.writeFileSync(p('fix/digest'), DIGEST + '\n')
  fs.writeFileSync(p('fix/release.json'), releaseLine(5) + '\n')
  fs.writeFileSync(p('etc/update.conf'), 'VARANDA_UPDATE=auto\n')
  fs.writeFileSync(p('checkout/compose.yaml'), 'name: varanda-seeder\n')

  const write = (rel, text, mode) => fs.writeFileSync(p(rel), text, mode ? { mode } : undefined)
  const exists = (rel) => fs.existsSync(p(rel))
  const read = (rel) => fs.existsSync(p(rel)) ? fs.readFileSync(p(rel), 'utf8') : ''

  const run = (commands) => {
    const body = sh.replace(/\nmain "\$@"\s*$/, '\n')
    const script = body +
      'state=' + JSON.stringify(p('state')) + '\nlog_file="$state/update.log"\n' +
      'lock_dir=' + JSON.stringify(p('lock')) + '\nlock_file="$lock_dir/lock"\nmarcador="$lock_dir/modo-pull"\n' +
      'conf_file=' + JSON.stringify(p('etc/update.conf')) + '\nenv_padrao=' + JSON.stringify(p('etc/varanda.env')) + '\n' +
      'releases=' + JSON.stringify(p('releases')) + '\nunits_dir=' + JSON.stringify(p('units')) + '\n' +
      'aqui=' + JSON.stringify(p('aqui')) + '\nFIX=' + JSON.stringify(p('fix')) + '\nCALLS=' + JSON.stringify(p('calls')) + '\n' +
      '. ' + JSON.stringify(WELL_KNOWN) + '\n' + STUBS + '\n' + commands + '\n'
    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    return { status: res.status, out: res.stdout + res.stderr, log: read('state/update.log'), calls: read('calls') }
  }
  return { d, p, write, exists, read, run }
}

const MAIN = 'ler_conf\narquivo_env\n'
// A project compose call (not "docker compose version") was recorded.
const composeRan = (calls) => /^compose pwd=\S* seeder=\S* web=\S* compose -/m.test(calls)
const linkOf = (p) => { try { return fs.readlinkSync(p) } catch { return null } }

test('update.sh: executable, shebang, required strings and last line', (t) => {
  const mode = fs.statSync(SCRIPT).mode & 0o777
  t.ok((mode & 0o111) === 0o111, 'exec bit set (mode ' + mode.toString(8) + ')')
  t.is(shLines[0], '#!/usr/bin/env bash', 'shebang')
  const required = [
    'set -Eeuo pipefail',
    "trap '' HUP PIPE",
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'lock_dir=/var/lib/varanda-deploy',
    'marcador="$lock_dir/modo-pull"',
    'state=/var/lib/varanda-update',
    'releases=/opt/varanda-release',
    'flock -n 9',
    'log_max_bytes=5242880',
    "date -u '+%Y-%m-%dT%H:%M:%SZ'",
    'identidade_edge=https://github.com/Varanda-org/varanda/.github/workflows/release.yml@refs/heads/main',
    'identidade_stable=https://github.com/Varanda-org/varanda/.github/workflows/promote.yml@refs/heads/main',
    'emissor=https://token.actions.githubusercontent.com',
    '--certificate-identity "$identidade"',
    '--certificate-oidc-issuer "$emissor"',
    '"$aqui/cosign.ref"',
    '--read-only --cap-drop ALL --security-opt no-new-privileges',
    '--network none --read-only --cap-drop ALL --security-opt no-new-privileges',
    '--entrypoint cat "$cand_seeder" /app/release.json',
    'docker pull "$seeder_repo:$canal"',
    'up -d --no-build',
    'up -d --no-build --force-recreate',
    '-f compose.release.yaml',
    '-f compose.release.web.yaml',
    '--env-file "$env_file"',
    'VARANDA_SEEDER_IMAGE=$seeder VARANDA_WEB_IMAGE=$web',
    '! -type f ! -type d',
    'chown -R 0:0',
    'varanda-seeder:anterior',
    'varanda-caddy:anterior',
    'varanda-seeder:antes-do-pull',
    'varanda-caddy:antes-do-pull',
    'com.docker.compose.project.working_dir',
    'com.docker.compose.oneoff=False',
    'gravar_associacoes "$destino"',
    'gravar_versao "$destino" "$cand_commit"',
    'ler_associacoes "$env_file"',
    'versão mais antiga que a instalada',
    'instalação preparada, aguardando o primeiro apply',
    'rode update.sh apply',
    'Atualização por imagem (pull)',
    'docker image prune -f',
    '127.0.0.1:8788/health',
    '/account/health',
    '/account/mod/api/me',
    'servido_igual sw.js sw.js',
    'x86_64',
    'mv -Tf',
    ...SEEDER_LIMITS
  ]
  for (const s of required) t.ok(shCode.includes(s), 'contains ' + s)
  const nonEmpty = shLines.filter((l) => l.trim() !== '')
  t.is(nonEmpty[nonEmpty.length - 1], 'main "$@"', 'last line is main "$@"')
  // All code lives in functions: outside them only assignments and the setup.
  const outside = sh.replace(/^[a-z_]+\(\) \{\n[\s\S]*?^\}\n/mg, '').split('\n')
    .filter((l) => l.trim() !== '' && !/^\s*#/.test(l))
    .filter((l) => !/^[a-z_A-Z]+=/.test(l) && !/^(set -Eeuo pipefail|export PATH|umask 022|trap '' HUP PIPE|main "\$@")$/.test(l))
  const wsBody = sh.match(/^ws_script='\n([\s\S]*?)\n'$/m)
  t.ok(wsBody, 'ws_script located')
  const wsLines = wsBody ? wsBody[1].split('\n').concat("'") : []
  t.alike(outside.filter((l) => !wsLines.includes(l)), [], 'no top-level code outside functions')
})

test('update.sh: forbidden constructs are absent', (t) => {
  t.absent(/\beval\b/.test(shCode), 'no eval')
  t.absent(/down\s+-v/.test(shCode), 'no down -v')
  t.absent(/compose[^\n]*\bdown\b/.test(shCode), 'no compose down')
  t.absent(/volume\s+(rm|prune)/.test(shCode), 'no volume rm/prune')
  t.absent(/seed (key|cert)/.test(shCode), 'no seed key/cert')
  t.absent(/account (key|cert)/.test(shCode), 'no account key/cert')
  t.absent(/mod (init|cert|block|unblock|apply)/.test(shCode), 'no moderator commands')
  t.absent(/account\/mod\/login/.test(shCode), 'the probe never requests /account/mod/login')
  t.absent(/(^|[\s;|&(])git\s/m.test(shCode), 'no git')
  t.absent(/--remove-orphans/.test(shCode), 'never --remove-orphans')
  t.absent(/^\s*(\.|source)\s+"?\$(env_file|env_padrao|conf_file)/m.test(shCode), 'the env and conf files are never sourced')
  t.absent(/tail\b[^\n]*log_file/.test(shCode), 'no log tail forwarded to the caller')
  // deploy.sh is only ever named inside a log message, never run.
  for (const l of shCode.split('\n').filter((x) => x.includes('deploy.sh'))) {
    t.ok(/^\s*log "/.test(l), 'deploy.sh only appears in a log line: ' + l.trim())
  }
  const shellOnly = shCode.replace(/^ws_script='[\s\S]*?^'$/m, '')
  t.ok(shellOnly.length < shCode.length, 'ws_script block located')
  t.absent(/(^|[^$])\(\(/.test(shellOnly), 'no standalone (( )) arithmetic command')
  // bash 5.2 makes a bare return in a function called from a trap give the
  // status that fired the trap, so a good compose would read as a failure.
  t.absent(/(^|[\s;&|{])return\s*(;|$|\))/m.test(shellOnly), 'no bare return (always return $? or a number)')
  for (const rel of OWNED) {
    t.absent(fs.readFileSync(path.join(repoRoot, rel), 'utf8').includes(String.fromCharCode(0x2014)), 'no em dash in ' + rel)
  }
})

test('update.sh: the seeder and account limit tables match cli.js and account.js', (t) => {
  const cli = fs.readFileSync(path.join(repoRoot, 'apps/cli/lib/cli.js'), 'utf8')
  const fromCli = {}
  for (const m of cli.matchAll(/optionalEnvInteger\(env, '(VARANDA_[A-Z_]+)', (\d+), (\d+)\)/g)) fromCli[m[1]] = m[2] + ':' + m[3]
  const fromSh = {}
  for (const m of shCode.matchAll(/\b(VARANDA_[A-Z_]+):(\d+):(\d+)\b/g)) {
    if (SEEDER_LIMITS.includes(m[1])) fromSh[m[1]] = m[2] + ':' + m[3]
  }
  t.alike(fromSh, fromCli, 'same seeder min:max as cli.js')
  const accountJs = fs.readFileSync(path.join(repoRoot, 'apps/cli/lib/commands/account.js'), 'utf8')
  const block = accountJs.match(/const LIMIT_ENV = Object\.freeze\(\{([\s\S]*?)\}\)/)
  const fromJs = {}
  for (const m of block[1].matchAll(/(VARANDA_[A-Z_]+):\s*\['\w+',\s*(\d+),\s*(\d+)\]/g)) fromJs[m[1]] = m[2] + ':' + m[3]
  const line = shCode.match(/^limites_conta='([^'\n]*)'$/m)
  t.ok(line, 'limites_conta located')
  const conta = {}
  for (const e of line[1].split(/\s+/).filter(Boolean)) { const [n, a, b] = e.split(':'); conta[n] = a + ':' + b }
  t.alike(conta, fromJs, 'same account limits as account.js')
})

test('update.sh: bash -n, usage errors and refusal to run as non-root', (t) => {
  if (!hasBash(t)) return
  const syntax = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })
  t.is(syntax.status, 0, 'bash -n passes: ' + syntax.stderr)
  const usage = (args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', input: '' })
  t.is(usage([]).status, 2, 'no command is a usage error')
  t.is(usage(['deploy']).status, 2, 'an unknown command is a usage error')
  t.is(usage(['run', 'x']).status, 2, 'run takes no argument')
  t.is(usage(['install']).status, 2, 'install needs --image')
  t.is(usage(['install', '--image', 'ghcr.io/outro/varanda-seeder@' + DIGEST]).status, 2, 'install refuses another registry path')
  t.is(usage(['install', '--image', 'ghcr.io/varanda-org/varanda-seeder:stable']).status, 2, 'install refuses a tag')
  if (process.getuid && process.getuid() === 0) {
    t.comment('running as root: skipping the non-root refusal check')
    return
  }
  const res = usage(['run'])
  t.is(res.status, 1, 'exits 1 when not root')
  t.ok(res.stderr.includes('exigido root'), 'stderr says exigido root')
  t.is(res.stdout, '', 'nothing on stdout')
})

test('update.sh: update.conf values are validated, with defaults for channel and profile', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  const conf = (text) => {
    if (text === null) fs.rmSync(s.p('etc/update.conf'), { force: true })
    else s.write('etc/update.conf', text)
    return s.run('ler_conf\nprintf "%s|%s|%s|%s\\n" "$modo" "$canal" "$perfil" "$identidade"')
  }
  const ok = conf('VARANDA_UPDATE=manual\n')
  t.is(ok.status, 0, 'a manual conf passes: ' + ok.out)
  t.ok(ok.out.includes('manual|stable|seeder|' + ID_STABLE), 'stable and seeder are the defaults')
  t.ok(conf('VARANDA_UPDATE = auto # comentário\nVARANDA_CHANNEL="edge"\nVARANDA_PROFILE=full\n').out.includes('auto|edge|full|' + ID_EDGE), 'edge maps to the release.yml identity')
  for (const [text, what] of [
    [null, 'a missing file'],
    ['', 'a missing VARANDA_UPDATE'],
    ['VARANDA_UPDATE=sim\n', 'an unknown mode'],
    ['VARANDA_UPDATE=auto\nVARANDA_CHANNEL=beta\n', 'an unknown channel'],
    ['VARANDA_UPDATE=auto\nVARANDA_PROFILE=web\n', 'an unknown profile']
  ]) {
    const r = conf(text)
    t.is(r.status, 2, what + ' is a usage error')
  }
  t.ok(conf('').out.includes('defina VARANDA_UPDATE=auto ou manual em'), 'says how to fix it')
})

test('update.sh: varanda.env must be root-only, and profile full requires it', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  const env = () => s.run(MAIN + 'printf "env=%s\\n" "$env_file"')
  t.ok(env().out.includes('env=\n'), 'profile seeder runs without the file')
  s.write('etc/update.conf', 'VARANDA_UPDATE=auto\nVARANDA_PROFILE=full\n')
  const missing = env()
  t.is(missing.status, 1, 'profile full refuses a missing file')
  t.ok(missing.out.includes('o perfil full exige'), 'says why')
  s.write('etc/varanda.env', FULL_ENV)
  t.ok(env().out.includes('env=' + s.p('etc/varanda.env')), 'a root-only file is used')
  s.write('fix/dono_modo', '0 640\n')
  t.is(env().status, 1, 'group read access is refused')
  s.write('fix/dono_modo', '1000 600\n')
  t.is(env().status, 1, 'another owner is refused')
})

test('update.sh: release.json must be exactly the signed line', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  const read = (bytes) => {
    s.write('fix/release.json', bytes)
    return s.run(MAIN + 'comecar teste\ncand_seeder=' + SEEDER_REF + '\nif ler_release; then printf "ok %s %s %s\\n" "$cand_commit" "$cand_seq" "$cand_web"; else exit 1; fi')
  }
  const ok = read(releaseLine(5) + '\n')
  t.is(ok.status, 0, 'the exact line passes: ' + ok.out)
  t.ok(ok.log.includes('ok ' + COMMIT + ' 5 ' + WEB_REF), 'commit, seq and web are read')
  const bad = [
    [releaseLine(5, ',"x":1') + '\n', 'an extra key'],
    [releaseLine(5).replace(COMMIT, H('A', 40)) + '\n', 'upper-case hex in the commit'],
    [releaseLine(5).replace(WEB_REF, WEB_REF.replace(/c/g, 'C')) + '\n', 'upper-case hex in the web digest'],
    [releaseLine(5).replace('ghcr.io/varanda-org/varanda-web', 'docker.io/varanda-org/varanda-web') + '\n', 'another registry'],
    [releaseLine(5).replace('varanda-web', 'varanda-seeder') + '\n', 'another repository'],
    [releaseLine(5) + ' \n', 'trailing data on the line'],
    [releaseLine(5) + '\nextra\n', 'a second line'],
    [releaseLine(5) + '\n\n', 'a trailing blank line'],
    [releaseLine(5), 'no final LF'],
    [releaseLine('05') + '\n', 'a leading zero in seq'],
    [releaseLine(5).replace('"v":1', '"v":2') + '\n', 'another version']
  ]
  for (const [bytes, what] of bad) t.is(read(bytes).status, 1, 'refuses ' + what)
})

test('update.sh: check verifies with the channel identity and the cosign pin beside the script', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  const stable = s.run(MAIN + 'cmd_check')
  t.is(stable.status, 0, 'check passes: ' + stable.out)
  const cosign = s.read('fix/cosign_calls')
  t.ok(cosign.includes(COSIGN + ' verify --certificate-identity ' + ID_STABLE + ' --certificate-oidc-issuer https://token.actions.githubusercontent.com ' + SEEDER_REF),
    'stable verifies the digest with the promote.yml identity, using cosign.ref')
  t.ok(stable.calls.includes('docker pull ghcr.io/varanda-org/varanda-seeder:stable'), 'pulls the channel tag')
  t.is(s.read('state/disponivel'), record(COMMIT, 5, SEEDER_REF, WEB_REF), 'disponivel holds the verified release')

  fs.rmSync(s.p('fix/cosign_calls'))
  s.write('etc/update.conf', 'VARANDA_UPDATE=auto\nVARANDA_CHANNEL=edge\n')
  t.is(s.run(MAIN + 'cmd_check').status, 0, 'edge check passes')
  t.ok(s.read('fix/cosign_calls').includes('--certificate-identity ' + ID_EDGE + ' '), 'edge uses the release.yml identity')

  // A cosign reference outside the pinned shape is refused before any run.
  fs.rmSync(s.p('fix/cosign_calls'))
  fs.rmSync(s.p('state/disponivel'))
  s.write('aqui/cosign.ref', 'ghcr.io/sigstore/cosign/cosign:latest\n')
  const unpinned = s.run(MAIN + 'cmd_check')
  t.is(unpinned.status, 1, 'an unpinned cosign.ref fails')
  t.absent(s.exists('fix/cosign_calls'), 'cosign never ran')
  t.absent(s.exists('state/disponivel'), 'nothing recorded')
})

test('update.sh: a signature failure changes nothing', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('state/atual', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  s.write('fix/cosign_fail', '')
  const r = s.run(MAIN + 'cmd_apply')
  t.is(r.status, 1, 'apply fails')
  t.ok(r.log.includes('não confere'), 'the log says the signature does not match')
  t.absent(r.calls.includes('--entrypoint cat'), 'release.json is never read from an unverified image')
  t.absent(r.calls.includes('docker create'), 'nothing is extracted')
  t.absent(composeRan(r.calls), 'compose never runs')
  t.absent(s.exists('state/disponivel'), 'no disponivel')
  t.is(s.read('state/atual'), record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB), 'atual unchanged')
  t.alike(fs.readdirSync(s.p('releases')), [], 'no release directory')
})

test('update.sh: a release not newer than the installed one is refused', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('state/atual', record(OLD_COMMIT, 7, OLD_SEEDER, OLD_WEB))
  const older = s.run(MAIN + 'cmd_check')
  t.is(older.status, 1, 'an older seq is refused')
  t.ok(older.log.includes('versão mais antiga que a instalada'), 'says why')
  t.absent(s.exists('state/disponivel'), 'nothing recorded')
  s.write('state/atual', record(OLD_COMMIT, 5, OLD_SEEDER, OLD_WEB))
  t.is(s.run(MAIN + 'cmd_check').status, 1, 'an equal seq is refused')
  s.write('state/atual', record(OLD_COMMIT, 4, OLD_SEEDER, OLD_WEB))
  t.is(s.run(MAIN + 'cmd_check').status, 0, 'a newer seq passes')
  // Already installed: no signature run at all.
  fs.rmSync(s.p('fix/cosign_calls'))
  s.write('state/atual', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  const same = s.run(MAIN + 'cmd_check')
  t.is(same.status, 0, 'em dia passes')
  t.ok(same.log.includes('em dia'), 'logs em dia')
  t.absent(s.exists('fix/cosign_calls'), 'no verification when nothing changed')
})

test('update.sh: run stops on intervencao and waits while only preparada exists', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('state/preparada', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  const waiting = s.run(MAIN + 'cmd_run')
  t.is(waiting.status, 0, 'exits 0')
  t.ok(waiting.log.includes('instalação preparada, aguardando o primeiro apply'), 'says it waits for the first apply')
  t.is(waiting.calls, '', 'no docker call at all')

  s.write('state/atual', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  s.write('state/intervencao', '2026-11-15T00:00:00Z a volta falhou\n')
  const stopped = s.run(MAIN + 'cmd_run')
  t.is(stopped.status, 1, 'exits 1 with intervencao')
  t.ok(stopped.log.includes('intervenção pendente: 2026-11-15T00:00:00Z a volta falhou'), 'logs the pending intervention')
  t.is(stopped.calls, '', 'no docker call at all')
})

test('update.sh: manual mode only announces, auto skips recusadas, explicit apply does not', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('state/atual', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  fs.mkdirSync(s.p('releases', OLD_COMMIT))
  s.write('etc/update.conf', 'VARANDA_UPDATE=manual\n')
  const manual = s.run(MAIN + 'cmd_run')
  t.is(manual.status, 0, 'manual run exits 0: ' + manual.out)
  t.ok(manual.log.includes('nova versão disponível: ' + COMMIT + '; rode update.sh apply'), 'announces the version')
  t.absent(composeRan(manual.calls), 'manual mode never calls compose')
  t.absent(manual.calls.includes('docker create'), 'manual mode extracts nothing')

  s.write('etc/update.conf', 'VARANDA_UPDATE=auto\n')
  s.write('state/recusadas', DIGEST + '\n')
  fs.rmSync(s.p('calls'))
  const skipped = s.run(MAIN + 'cmd_run')
  t.is(skipped.status, 0, 'auto run with a refused digest exits 0')
  t.ok(skipped.log.includes('não é aplicada de novo sozinha'), 'says it was refused before')
  t.absent(composeRan(skipped.calls), 'auto mode skips a refused digest')

  fs.rmSync(s.p('calls'))
  const forced = s.run(MAIN + 'cmd_apply')
  t.is(forced.status, 0, 'explicit apply passes: ' + forced.out)
  t.ok(/compose pwd=\S+ seeder=\S+ web=\S+ compose -p varanda-seeder -f compose.yaml -f compose.release.yaml up -d --no-build\n/.test(forced.calls), 'explicit apply runs compose up')
  t.is(s.read('state/atual'), record(COMMIT, 5, SEEDER_REF, WEB_REF), 'atual is the new release')
})

test('update.sh: apply prepares, swaps and records a full-profile release', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('etc/update.conf', 'VARANDA_UPDATE=manual\nVARANDA_PROFILE=full\n')
  s.write('etc/varanda.env', FULL_ENV)
  s.write('state/atual', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  fs.mkdirSync(s.p('releases', OLD_COMMIT))
  fs.mkdirSync(s.p('releases', H('9', 40)))
  s.write('state/disponivel', 'velho\n')
  s.write('fix/ps_seeder', 'aaa111\n')
  s.write('fix/ps_web', 'bbb222\n')
  s.write('fix/img_aaa111', 'sha256:running-seeder\n')
  s.write('fix/img_bbb222', 'sha256:running-caddy\n')
  const r = s.run(MAIN + 'cmd_apply')
  t.is(r.status, 0, 'apply passes: ' + r.out)
  const dir = s.p('releases', COMMIT)
  const up = 'compose pwd=' + dir + ' seeder=' + SEEDER_REF + ' web=' + WEB_REF +
    ' compose -p varanda-seeder --env-file ' + s.p('etc/varanda.env') +
    ' -f compose.yaml -f compose.web.yaml -f compose.release.yaml -f compose.release.web.yaml up -d --no-build\n'
  t.ok(r.calls.includes(up), 'compose up from the release directory with the pinned images and the env file')
  t.ok(composeRan(r.calls), 'the compose helper sees a project call')
  t.ok(r.calls.includes('config -q'), 'compose config ran before the swap')
  t.ok(r.calls.indexOf('config -q') < r.calls.indexOf('up -d --no-build'), 'config before up')
  t.ok(r.calls.includes('docker pull ' + WEB_REF), 'the web image is pulled by its pinned digest')
  t.ok(s.read('fix/tags').includes('varanda-seeder:anterior sha256:running-seeder'), 'the running seeder image is kept as :anterior')
  t.ok(s.read('fix/tags').includes('varanda-caddy:anterior sha256:running-caddy'), 'the running Caddy image is kept as :anterior')
  t.ok(s.read('fix/tags').includes('varanda-seeder:atual'), 'the new seeder image is tagged :atual')
  t.is(s.read('state/atual'), record(COMMIT, 5, SEEDER_REF, WEB_REF), 'atual updated')
  t.is(s.read('state/anterior'), record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB), 'anterior is the old atual')
  t.absent(s.exists('state/disponivel'), 'disponivel removed')
  t.is(linkOf(s.p('releases/current')), dir, 'current points to the new release')
  t.alike(fs.readdirSync(s.p('releases')).sort(), [OLD_COMMIT, COMMIT, 'current'].sort(), 'only the current and previous releases are kept')
  t.ok(fs.existsSync(path.join(dir, 'www/index.html')), 'www copied from the web image')
  t.is(fs.readFileSync(path.join(dir, 'www/version.json'), 'utf8'), '{"v":1,"commit":"' + COMMIT + '"}\n', 'version.json written by root')
  t.ok(r.log.includes('atualizado para ' + COMMIT), 'logs the update')
  t.ok(r.calls.includes('docker image prune -f'), 'prunes dangling images')
})

test('update.sh: extracted trees are normalised and links refused', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  fs.mkdirSync(s.p('fix/bundle/sub'))
  s.write('fix/bundle/sub/suid', 'x\n')
  fs.chmodSync(s.p('fix/bundle/sub/suid'), 0o4755)
  s.write('fix/bundle/group-writable', 'x\n')
  fs.chmodSync(s.p('fix/bundle/group-writable'), 0o666)
  fs.chmodSync(s.p('fix/bundle/sub'), 0o1777)
  fs.mkdirSync(s.p('fix/bundle/sgid'))
  fs.chmodSync(s.p('fix/bundle/sgid'), 0o2755)
  if ((fs.statSync(s.p('fix/bundle/sgid')).mode & 0o2000) === 0) t.comment('setgid not kept on this filesystem: the 2755 case checks less')
  fs.chmodSync(s.p('fix/bundle/update.sh'), 0o775)
  const prep = s.run(MAIN + 'comecar teste\ncand_seeder=' + SEEDER_REF + '\ncand_web=' + WEB_REF +
    '\ncand_commit=' + COMMIT + '\ncand_seq=5\npreparar_versao')
  t.is(prep.status, 0, 'preparation passes: ' + prep.out)
  const dir = s.p('releases', COMMIT)
  const mode = (rel) => fs.statSync(path.join(dir, rel)).mode & 0o7777
  t.is(mode('sub/suid'), 0o644, 'a setuid file comes out 0644')
  t.is(mode('group-writable'), 0o644, 'a group-writable file comes out 0644')
  t.is(mode('update.sh'), 0o755, 'update.sh stays executable, 0755')
  t.is(mode('sub'), 0o755, 'a sticky world-writable directory comes out 0755')
  t.is(mode('sgid'), 0o755, 'a setgid 2755 directory comes out 0755')
  t.ok(/chmod 00755 \{\} \+/.test(shCode) && /chmod 00644 \{\} \+/.test(shCode), 'five-digit modes, which GNU chmod applies to setgid directories too')
  t.is(mode('.'), 0o755, 'the release directory is 0755')

  const s2 = server(t)
  fs.symlinkSync('/etc/passwd', s2.p('fix/bundle/Caddyfile.link'))
  const link = s2.run(MAIN + 'comecar teste\ncand_seeder=' + SEEDER_REF + '\ncand_web=' + WEB_REF +
    '\ncand_commit=' + COMMIT + '\ncand_seq=5\npreparar_versao')
  t.is(link.status, 1, 'a symlink in the extracted bundle is refused')
  t.ok(link.log.includes('links simbólicos ou arquivos especiais'), 'says why')
  t.alike(fs.readdirSync(s2.p('releases')), [], 'nothing left in the releases directory')
  t.absent(link.calls.includes('config -q'), 'stops before compose config')

  // The web tree gets the same treatment.
  const s3 = server(t)
  s3.write('etc/update.conf', 'VARANDA_UPDATE=auto\nVARANDA_PROFILE=full\n')
  s3.write('etc/varanda.env', FULL_ENV)
  fs.symlinkSync('/etc/passwd', s3.p('fix/web/leak'))
  const web = s3.run(MAIN + 'comecar teste\ncand_seeder=' + SEEDER_REF + '\ncand_web=' + WEB_REF +
    '\ncand_commit=' + COMMIT + '\ncand_seq=5\npreparar_versao')
  t.is(web.status, 1, 'a symlink in the web tree is refused')
  t.alike(fs.readdirSync(s3.p('releases')), [], 'nothing left behind')
})

test('update.sh: the env pre-flight refuses a bad limit before anything runs', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('etc/update.conf', 'VARANDA_UPDATE=auto\nVARANDA_PROFILE=full\n')
  s.write('etc/varanda.env', FULL_ENV + 'VARANDA_MAX_EXTERNAL=4097\n')
  const bad = s.run(MAIN + 'cmd_apply')
  t.is(bad.status, 1, 'apply fails')
  t.ok(bad.log.includes('VARANDA_MAX_EXTERNAL inválido em ' + s.p('etc/varanda.env')), 'names the variable')
  t.absent(bad.out.includes('4097') || bad.log.includes('4097'), 'the value is never printed')
  t.absent(bad.log.includes('segredo-ultra') || bad.out.includes('segredo-ultra'), 'no secret in the log')
  t.absent(bad.calls.includes('docker create'), 'nothing extracted')
  t.absent(composeRan(bad.calls), 'compose never runs')
  const check = (extra, profile) => {
    s.write('etc/update.conf', 'VARANDA_UPDATE=auto\nVARANDA_PROFILE=' + profile + '\n')
    s.write('etc/varanda.env', extra)
    return s.run(MAIN + 'comecar teste\nconferir_env').status
  }
  t.is(check(FULL_ENV + 'VARANDA_MAX_EXTERNAL=4096\nVARANDA_FRAME_MEMORY=8454144\n', 'full'), 0, 'a valid full file passes')
  t.is(check(FULL_ENV + 'VARANDA_MAX_MEMBERS=5000\n', 'full'), 1, 'an account limit out of range is refused')
  t.is(check(FULL_ENV + 'VARANDA_INVITE_DROPS=1\n', 'full'), 1, 'invite drops without the weekly number are refused')
  t.is(check('VARANDA_DOMAIN=Exemplo.org\n', 'full'), 1, 'a bad domain is refused for profile full')
  t.is(check('VARANDA_MEDIA_RATE=0\n', 'seeder'), 1, 'profile seeder still checks the seeder limits')
  t.is(check('VARANDA_DOMAIN=\n', 'seeder'), 0, 'profile seeder does not need the web variables')
})

test('update.sh: a failed gate goes back to the previous release and refuses the digest', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('state/atual', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  s.write('state/anterior', record(H('2', 40), 0 + 1, OLD_SEEDER, OLD_WEB))
  fs.mkdirSync(s.p('releases', OLD_COMMIT))
  s.write('fix/gate_fail_1', '')
  const r = s.run(MAIN + 'cmd_apply')
  t.is(r.status, 1, 'apply exits 1')
  const back = 'compose pwd=' + s.p('releases', OLD_COMMIT) + ' seeder=' + OLD_SEEDER + ' web=' + OLD_WEB +
    ' compose -p varanda-seeder -f compose.yaml -f compose.release.yaml up -d --no-build --force-recreate\n'
  t.ok(r.calls.includes(back), 'compose recreates the previous release with its pinned images')
  t.ok(r.calls.includes('gate ' + s.p('releases', OLD_COMMIT) + ' ' + OLD_SEEDER), 'the gate runs again on the way back')
  t.is(s.read('state/recusadas'), DIGEST + '\n', 'the digest is refused')
  t.is(s.read('state/atual'), record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB), 'atual unchanged')
  t.is(s.read('state/anterior'), record(H('2', 40), 1, OLD_SEEDER, OLD_WEB), 'the older anterior is restored')
  t.absent(s.exists('state/intervencao'), 'no intervention after a good way back')
  t.ok(r.log.includes('voltou para ' + OLD_COMMIT), 'logs the way back')

  // Without any previous version the server needs a person.
  const n = server(t)
  n.write('state/preparada', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  n.write('fix/gate_fail_1', '')
  const none = n.run(MAIN + 'cmd_apply')
  t.is(none.status, 1, 'exits 1')
  t.ok(n.read('state/intervencao').includes('sem versão anterior'), 'intervencao written')
  t.ok(none.log.includes('intervenção manual'), 'logs intervenção manual')
})

test('update.sh: install on a server from the checkout path records it and goes back to it', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('etc/update.conf', 'VARANDA_UPDATE=manual\nVARANDA_PROFILE=full\n')
  s.write('etc/varanda.env', FULL_ENV)
  s.write('fix/ps_seeder', 'aaa111\n')
  s.write('fix/ps_web', 'bbb222\n')
  s.write('fix/img_aaa111', 'sha256:old-seeder\n')
  s.write('fix/img_bbb222', 'sha256:old-caddy\n')
  s.write('fix/workdir', s.p('checkout') + '\n')
  s.write('fix/gate_fail_1', '')
  const r = s.run(MAIN + 'ref_install=' + SEEDER_REF + '\ncmd_install')
  t.is(r.status, 1, 'the failed first apply exits 1: ' + r.out)
  t.ok(r.calls.includes('com.docker.compose.project.working_dir'), 'reads the working_dir label of the seeder container')
  t.ok(s.read('fix/cosign_calls').includes(' ' + SEEDER_REF), 'install verifies the given digest')
  t.absent(r.calls.includes('docker pull ghcr.io/varanda-org/varanda-seeder:stable'), 'install never pulls the channel tag')
  const tags = s.read('fix/tags')
  t.ok(tags.includes('varanda-seeder:antes-do-pull sha256:old-seeder'), 'the running seeder image is tagged antes-do-pull')
  t.ok(tags.includes('varanda-caddy:antes-do-pull sha256:old-caddy'), 'the running Caddy image is tagged antes-do-pull')
  t.ok(r.calls.includes('docker image tag varanda-seeder:antes-do-pull varanda-seeder:local'), 'the way back restores varanda-seeder:local')
  t.ok(r.calls.includes('docker image tag varanda-caddy:antes-do-pull varanda-caddy:local'), 'the way back restores varanda-caddy:local')
  t.ok(r.calls.includes('compose pwd=' + s.p('checkout') + ' seeder= web= compose -f compose.yaml -f compose.web.yaml up -d --no-build --force-recreate\n'),
    'the way back runs compose in the old checkout with --no-build --force-recreate')
  t.ok(r.calls.includes('gate ' + s.p('checkout') + ' varanda-seeder:antes-do-pull'), 'the gate runs against the checkout')
  t.is(s.read('state/anterior'), 'origem=checkout\ncheckout=' + s.p('checkout') + '\n', 'anterior records the checkout')
  t.ok(s.read('state/intervencao').includes('voltou ao checkout'), 'intervencao says the server is back on the checkout')
  t.ok(s.exists('lock/modo-pull'), 'the modo-pull marker stays')
  t.is(s.read('state/recusadas'), DIGEST + '\n', 'the digest is refused')
  t.absent(r.calls.includes('deploy.sh'), 'deploy.sh is never run')
  t.ok(r.calls.includes('install -m 0644 -o 0 -g 0 ' + s.p('aqui/varanda-update.service')), 'the service unit is installed')
  t.ok(r.calls.includes('systemctl enable --now varanda-update.timer'), 'the timer is enabled and started even though the first apply failed')
  t.ok(r.calls.indexOf('systemctl enable --now') < r.calls.indexOf('up -d --no-build'), 'the timer runs before the first apply')
  t.is(linkOf(s.p('releases/current')), s.p('releases', COMMIT), 'current points at the candidate, so the timer can exec update.sh')
  fs.rmSync(s.p('calls'))
  const stopped = s.run(MAIN + 'cmd_run')
  t.is(stopped.status, 1, 'the next timer run stops')
  t.ok(stopped.log.includes('intervenção pendente: '), 'on the pending intervention')
  t.absent(composeRan(stopped.calls), 'without touching the checkout')
  t.is(s.run(MAIN + 'cmd_compose ps').status, 1, 'update.sh compose does not treat the failed candidate as the running release')

  // rollback with origem=checkout takes the same way back.
  const rb = server(t)
  rb.write('state/atual', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  rb.write('state/anterior', 'origem=checkout\ncheckout=' + rb.p('checkout') + '\n')
  const back = rb.run(MAIN + 'cmd_rollback')
  t.is(back.status, 0, 'rollback to a healthy checkout exits 0: ' + back.out)
  t.ok(back.calls.includes('compose pwd=' + rb.p('checkout') + ' seeder= web= compose -f compose.yaml up -d --no-build --force-recreate\n'), 'rollback uses the checkout too')
  t.absent(rb.exists('state/atual'), 'atual is dropped: the checkout runs')
  t.is(rb.read('state/recusadas'), DIGEST + '\n', 'the rolled-back digest is refused')
  t.ok(rb.exists('state/intervencao'), 'intervencao says how to continue')
})

test('update.sh: install refuses a missing working_dir label and changes nothing', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('fix/ps_seeder', 'aaa111\n')
  s.write('fix/img_aaa111', 'sha256:old-seeder\n')
  s.write('fix/workdir', '\n')
  const r = s.run(MAIN + 'ref_install=' + SEEDER_REF + '\ncmd_install')
  t.is(r.status, 1, 'exits 1')
  t.ok(r.log.includes('com.docker.compose.project.working_dir'), 'names the label')
  t.absent(s.exists('lock/modo-pull'), 'no marker')
  t.absent(composeRan(r.calls), 'no compose')
  t.absent(r.calls.includes('systemctl'), 'no units')
  s.write('fix/workdir', s.p('nada') + '\n')
  t.is(s.run(MAIN + 'ref_install=' + SEEDER_REF + '\ncmd_install').status, 1, 'a directory without compose.yaml is refused')
})

test('update.sh: install on a new server prepares and starts nothing', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  const r = s.run(MAIN + 'ref_install=' + SEEDER_REF + '\ncmd_install')
  t.is(r.status, 0, 'exits 0: ' + r.out)
  t.is(s.read('state/preparada'), record(COMMIT, 5, SEEDER_REF, WEB_REF), 'preparada written')
  t.absent(s.exists('state/atual'), 'nothing installed yet')
  t.is(linkOf(s.p('releases/current')), s.p('releases', COMMIT), 'current points to the prepared release')
  t.absent(/compose pwd=\S+ [^\n]* up /.test(r.calls), 'compose up never runs')
  t.ok(r.log.includes("seção 'Atualização por imagem (pull)' do README"), 'points to the README section')
  t.ok(r.log.includes('update.sh apply'), 'says to run apply next')
  t.ok(s.exists('lock/modo-pull'), 'the modo-pull marker is written')

  const arm = server(t)
  arm.write('fix/uname', 'aarch64\n')
  const refused = arm.run(MAIN + 'ref_install=' + SEEDER_REF + '\ncmd_install')
  t.is(refused.status, 1, 'another architecture is refused')
  t.ok(refused.out.includes('só amd64'), 'says the images are amd64 only')
  t.is(refused.calls, '', 'no docker call')
})

test('update.sh: units and config example', (t) => {
  const service = fs.readFileSync(path.join(SEEDER, 'varanda-update.service'), 'utf8').split('\n')
  for (const l of ['Type=oneshot', 'ExecStart=/opt/varanda-release/current/update.sh run', 'TimeoutStartSec=30min',
    'TimeoutStopSec=15min', 'KillMode=mixed']) {
    t.ok(service.includes(l), 'service has ' + l)
  }
  t.ok(service.some((l) => /^After=.*docker\.service/.test(l) && /network-online\.target/.test(l)), 'After docker and network-online')
  t.ok(service.some((l) => /^Wants=.*docker\.service/.test(l) && /network-online\.target/.test(l)), 'Wants docker and network-online')
  const timer = fs.readFileSync(path.join(SEEDER, 'varanda-update.timer'), 'utf8').split('\n')
  for (const l of ['OnBootSec=3min', 'OnUnitActiveSec=15min', 'RandomizedDelaySec=15min', 'WantedBy=timers.target']) {
    t.ok(timer.includes(l), 'timer has ' + l)
  }
  const example = fs.readFileSync(path.join(SEEDER, 'update.conf.example'), 'utf8').split('\n')
  t.absent(example.some((l) => /^VARANDA_UPDATE=/.test(l)), 'VARANDA_UPDATE is never set by default')
  t.ok(example.includes('#VARANDA_UPDATE=manual') && example.includes('#VARANDA_UPDATE=auto'), 'both modes documented')
  t.ok(example.includes('#VARANDA_CHANNEL=stable') && example.includes('#VARANDA_PROFILE=seeder'), 'channel and profile documented')
})

// A release directory as preparar_versao leaves it: the bundle files and,
// for profile full, a www with the app.
function installRelease (s, commit, { www = true } = {}) {
  const dir = s.p('releases', commit)
  fs.cpSync(s.p('fix/bundle'), dir, { recursive: true })
  if (www) {
    fs.mkdirSync(path.join(dir, 'www'))
    for (const f of ['index.html', 'varanda-node.js', 'sw.js']) fs.writeFileSync(path.join(dir, 'www', f), f + '\n')
  }
  return dir
}

const ASSOC = H('a', 64)
const OLDER_SEEDER = 'ghcr.io/varanda-org/varanda-seeder@sha256:' + H('7', 64)
const OLDER_WEB = 'ghcr.io/varanda-org/varanda-web@sha256:' + H('8', 64)

// Everything the real gate looks at, healthy: the seeder health endpoint, the
// served app, /varanda.json, the account service, the moderation probe and
// one container per service on the target images.
function healthyGate (s, dir) {
  s.write('fix/real_gate', '')
  s.write('fix/health_code', '200')
  fs.writeFileSync(path.join(dir, 'Caddyfile'), 'handle /varanda.json {\n}\nhandle /account/* {\n}\n')
  fs.writeFileSync(path.join(dir, 'www/version.json'), '{"v":1,"commit":"' + COMMIT + '"}\n')
  fs.mkdirSync(s.p('fix/served/account/mod/api'), { recursive: true })
  for (const f of ['varanda-node.js', 'sw.js', 'version.json']) fs.copyFileSync(path.join(dir, 'www', f), s.p('fix/served', f))
  fs.copyFileSync(path.join(dir, 'www/index.html'), s.p('fix/served/_root'))
  s.write('fix/served/varanda.json', '{"v":1,"association":"' + ASSOC + '"}')
  s.write('fix/served/account/health', '{"status":"ok"}\n')
  s.write('fix/served/account/health.w', 'application/json')
  s.write('fix/served/account/mod/api/me', '{"error":"nao-autorizado"}\n')
  s.write('fix/served/account/mod/api/me.w', '401 application/json; charset=utf-8')
  for (const [svc, cid, ref] of [['seeder', 'aaa111', SEEDER_REF], ['account', 'ccc333', SEEDER_REF], ['web', 'bbb222', WEB_REF]]) {
    s.write('fix/ps_' + svc, cid + '\n')
    s.write('fix/img_' + cid, 'sha256:id-' + ref + '\n')
  }
}

test('update.sh: the real health gate passes a healthy full server and fails each broken part', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('etc/update.conf', 'VARANDA_UPDATE=auto\nVARANDA_PROFILE=full\n')
  s.write('etc/varanda.env', FULL_ENV)
  const dir = installRelease(s, COMMIT)
  healthyGate(s, dir)
  const gate = () => s.run(MAIN + 'comecar teste\nconferir_env\nalvo_versao ' + JSON.stringify(dir) + ' ' + SEEDER_REF + ' ' + WEB_REF + '\nverificar_saude')
  const ok = gate()
  t.is(ok.status, 0, 'a healthy server passes: ' + ok.log)
  t.ok(ok.log.includes('saúde: health 200, imagens conferidas'), 'logs the passed gate')
  t.ok(ok.calls.includes('curl -s -o /dev/null -w %{http_code} --connect-timeout 5 --max-time 10 http://127.0.0.1:8788/health'), 'asks the local health endpoint')
  t.ok(ok.calls.includes('https://app.exemplo.org/account/mod/api/me'), 'probes the moderation API')
  t.ok(ok.calls.includes('https://app.exemplo.org/varanda.json'), 'probes /varanda.json')
  t.ok(/compose pwd=\S+ seeder=\S+ web=\S+ compose -p varanda-seeder [^\n]* exec -T seeder node -e /.test(ok.calls), 'opens the WebSocket through the seeder container')
  t.absent(ok.calls.includes('/account/mod/login'), 'never asks the OAuth login')

  s.write('fix/img_ccc333', 'sha256:outra\n')
  const image = gate()
  t.is(image.status, 1, 'a container on another image fails')
  t.ok(image.log.includes('o serviço account roda a imagem sha256:outra'), 'names the service and the image')
  s.write('fix/img_ccc333', 'sha256:id-' + SEEDER_REF + '\n')

  s.write('fix/served/sw.js', 'outro\n')
  const web = gate()
  t.is(web.status, 1, 'a web probe serving other bytes fails in profile full')
  t.ok(web.log.includes('não serve o app de ' + dir + '/www'), 'says the app is not served')
  fs.copyFileSync(path.join(dir, 'www/sw.js'), s.p('fix/served/sw.js'))

  s.write('fix/served/account/mod/api/me.w', '200 application/json')
  t.is(gate().status, 1, 'a moderation API answering 200 fails')
  s.write('fix/served/account/mod/api/me.w', '401 application/json; charset=utf-8')
  t.is(gate().status, 0, 'healthy again once restored')

  fs.rmSync(s.p('fix/health_code'))
  fs.rmSync(s.p('calls'))
  const sick = gate()
  t.is(sick.status, 1, 'an unhealthy seeder fails')
  t.ok(sick.log.includes('o semeador não respondeu 200 em 127.0.0.1:8788/health em 180 s'), 'says the seeder never answered 200')
  t.absent(sick.calls.includes('https://'), 'stops before the web probes')
  t.ok(sick.calls.split('\n').filter((l) => l.includes('8788/health')).length > 1, 'retried before giving up')

  // Profile seeder checks only the seeder: no web probe, no account service.
  const s2 = server(t)
  const dir2 = installRelease(s2, COMMIT, { www: false })
  s2.write('fix/real_gate', '')
  s2.write('fix/health_code', '200')
  s2.write('fix/ps_seeder', 'aaa111\n')
  s2.write('fix/img_aaa111', 'sha256:id-' + SEEDER_REF + '\n')
  const seeder = s2.run(MAIN + 'comecar teste\nalvo_versao ' + JSON.stringify(dir2) + ' ' + SEEDER_REF + ' ' + WEB_REF + '\nverificar_saude')
  t.is(seeder.status, 0, 'profile seeder passes with the seeder alone: ' + seeder.log)
  t.absent(seeder.calls.includes('https://'), 'no web probe in profile seeder')
  s2.write('fix/img_aaa111', 'sha256:velha\n')
  t.is(s2.run(MAIN + 'comecar teste\nalvo_versao ' + JSON.stringify(dir2) + ' ' + SEEDER_REF + ' ' + WEB_REF + '\nverificar_saude').status, 1,
    'a seeder container left on the old image fails')
})

test('update.sh: SIGTERM during the gate runs the way back', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('state/atual', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  installRelease(s, OLD_COMMIT, { www: false })
  s.write('fix/term_at_gate_1', '')
  const r = s.run(MAIN + 'cmd_apply')
  t.is(r.status, 1, 'exits 1')
  t.ok(r.log.includes('atualização para ' + COMMIT + ': interrompida por sinal; voltando'), 'logs the signal')
  t.ok(r.calls.includes('compose pwd=' + s.p('releases', OLD_COMMIT) + ' seeder=' + OLD_SEEDER + ' web=' + OLD_WEB +
    ' compose -p varanda-seeder -f compose.yaml -f compose.release.yaml up -d --no-build --force-recreate\n'), 'recreates the previous release')
  t.is(s.read('fix/gate_n'), '2\n', 'the gate ran again on the way back')
  t.is(s.read('state/recusadas'), DIGEST + '\n', 'the digest is refused')
  t.is(s.read('state/atual'), record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB), 'atual unchanged')
  t.ok(r.log.includes('voltou para ' + OLD_COMMIT), 'logs the way back')
})

test('update.sh: status, compose and reconfigure', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  const dir = installRelease(s, COMMIT, { www: false })
  fs.symlinkSync(dir, s.p('releases/current'))
  s.write('state/atual', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  s.write('state/disponivel', record(H('3', 40), 6, SEEDER_REF, WEB_REF))
  s.write('state/anterior', 'origem=checkout\ncheckout=' + s.p('checkout') + '\n')
  s.write('state/intervencao', '2026-11-15T00:00:00Z olhe\n')
  fs.copyFileSync(path.join(dir, 'varanda-update.timer'), s.p('units/varanda-update.timer'))
  s.write('units/varanda-update.service', 'velha\n')
  const st = s.run(MAIN + 'cmd_status')
  t.is(st.status, 0, 'status exits 0')
  for (const l of ['modo: auto', 'canal: stable', 'perfil: seeder', 'instalada: ' + COMMIT + ' (seq 5)',
    'disponível: ' + H('3', 40) + ' (seq 6)', 'anterior: checkout em ' + s.p('checkout'), 'intervenção: 2026-11-15T00:00:00Z olhe']) {
    t.ok(st.out.split('\n').includes(l), 'status shows ' + l)
  }
  t.ok(st.out.includes('aviso: ' + s.p('units/varanda-update.service') + ' difere'), 'warns about a stale unit')
  t.absent(st.out.includes('aviso: ' + s.p('units/varanda-update.timer')), 'no warning for an up-to-date unit')
  t.is(st.calls, '', 'status calls nothing')

  const c = s.run(MAIN + 'cmd_compose ps -a')
  t.is(c.status, 0, 'compose exits 0')
  t.ok(c.calls.includes('compose pwd=' + dir + ' seeder=' + SEEDER_REF + ' web=' + WEB_REF + ' compose -p varanda-seeder -f compose.yaml -f compose.release.yaml ps -a\n'),
    'runs compose in the current release with the installed images')

  fs.rmSync(s.p('calls'))
  s.write('fix/ps_seeder', 'aaa111\n')
  const re = s.run(MAIN + 'cmd_reconfigure')
  t.is(re.status, 0, 'reconfigure exits 0: ' + re.log)
  t.ok(re.calls.includes('compose pwd=' + dir + ' seeder=' + SEEDER_REF + ' web=' + WEB_REF + ' compose -p varanda-seeder -f compose.yaml -f compose.release.yaml up -d --no-build\n'),
    'compose up of the installed release, without --force-recreate')
  t.ok(re.calls.includes('gate ' + dir + ' ' + SEEDER_REF), 'the gate runs')
  t.ok(re.log.includes('reconfigurado em ' + COMMIT), 'logs the reconfiguration')
  s.write('fix/gate_fail_2', '')
  const bad = s.run(MAIN + 'cmd_reconfigure')
  t.is(bad.status, 1, 'a failed gate fails reconfigure')
  t.ok(bad.log.includes('reconfiguração não concluída'), 'says so')

  const none = server(t)
  const nc = none.run(MAIN + 'cmd_compose ps')
  t.is(nc.status, 1, 'compose without an installed or prepared release fails')
  t.ok(nc.out.includes('nenhuma versão instalada ou preparada'), 'says why')
  t.is(none.run(MAIN + 'cmd_reconfigure').status, 1, 'reconfigure without an installed release fails')
})

test('update.sh: reconfigure to profile full refuses a release prepared without www', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  installRelease(s, COMMIT, { www: false })
  s.write('state/atual', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  s.write('etc/update.conf', 'VARANDA_UPDATE=auto\nVARANDA_PROFILE=full\n')
  s.write('etc/varanda.env', FULL_ENV)
  const r = s.run(MAIN + 'cmd_reconfigure')
  t.is(r.status, 1, 'exits 1')
  t.ok(r.log.includes('foi preparada sem o app web (perfil seeder) e o perfil agora é full'), 'says the release has no web app')
  t.absent(composeRan(r.calls), 'Caddy is never started')
  installRelease(s, H('4', 40))
  s.write('state/atual', record(H('4', 40), 5, SEEDER_REF, WEB_REF))
  const ok = s.run(MAIN + 'cmd_reconfigure')
  t.is(ok.status, 0, 'a release with www reconfigures in profile full: ' + ok.log)
})

test('update.sh: apply when up to date with an intervention re-ups the installed release', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  const dir = installRelease(s, COMMIT, { www: false })
  s.write('state/atual', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  s.write('state/intervencao', 'x\n')
  s.write('fix/gate_fail_1', '')
  const bad = s.run(MAIN + 'cmd_apply')
  t.is(bad.status, 1, 'a failed gate keeps the intervention')
  t.ok(s.exists('state/intervencao'), 'intervencao stays')
  t.ok(bad.log.includes('a intervenção continua'), 'says so')
  const ok = s.run(MAIN + 'cmd_apply')
  t.is(ok.status, 0, 'a healthy re-up passes: ' + ok.log)
  t.ok(ok.calls.includes('compose pwd=' + dir + ' seeder=' + SEEDER_REF + ' web=' + WEB_REF + ' compose -p varanda-seeder -f compose.yaml -f compose.release.yaml up -d --no-build --force-recreate\n'),
    'recreates the installed release')
  t.absent(s.exists('state/intervencao'), 'intervencao removed')
  t.ok(ok.log.includes('intervenção encerrada'), 'logs the end of the intervention')
  t.absent(s.exists('fix/cosign_calls'), 'no signature check for the installed digest')
})

test('update.sh: install with profile seeder refuses a server running Caddy or the account service', (t) => {
  if (!hasBash(t)) return
  for (const svc of ['web', 'account']) {
    const s = server(t)
    s.write('fix/ps_seeder', 'aaa111\n')
    s.write('fix/ps_' + svc, 'bbb222\n')
    s.write('fix/img_aaa111', 'sha256:old-seeder\n')
    s.write('fix/workdir', s.p('checkout') + '\n')
    const r = s.run(MAIN + 'ref_install=' + SEEDER_REF + '\ncmd_install')
    t.is(r.status, 1, 'refused with a ' + svc + ' container')
    t.ok(r.log.includes('defina VARANDA_PROFILE=full em ' + s.p('etc/update.conf')), 'says to set VARANDA_PROFILE=full')
    t.absent(s.exists('lock/modo-pull'), 'no marker')
    t.absent(r.calls.includes('docker create'), 'nothing extracted')
    t.absent(r.calls.includes('systemctl'), 'no units')
    t.absent(r.calls.includes('docker image tag'), 'no image tagged')
    t.absent(s.exists('state/anterior'), 'no anterior')
  }
})

test('update.sh: a release directory a container mounts is never replaced', (t) => {
  if (!hasBash(t)) return
  const prep = MAIN + 'comecar teste\ncand_seeder=' + SEEDER_REF + '\ncand_web=' + WEB_REF + '\ncand_commit=' + COMMIT + '\ncand_seq=5\n'
  // Killed between compose up and the record: the containers run from the
  // new directory while atual still names the old release.
  const s = server(t)
  s.write('state/atual', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  const dir = installRelease(s, COMMIT, { www: false })
  s.write(path.join('releases', COMMIT, 'stale'), 'x\n')
  s.write('fix/ps_seeder', 'aaa111\n')
  s.write('fix/wd_aaa111', dir + '\n')
  const r = s.run(prep + 'preparar_versao')
  t.is(r.status, 1, 'a mounted directory with other files is refused')
  t.ok(r.log.includes('já está em uso com outros arquivos'), 'says it is in use')
  t.ok(r.log.includes("remova-os com 'update.sh compose rm -sf' e rode update.sh apply de novo"), 'says how to clear leftover containers')
  t.ok(s.exists(path.join('releases', COMMIT, 'stale')), 'the mounted directory is untouched')

  // The same files: the directory stays (same inode) and is reused.
  const same = server(t)
  same.write('state/atual', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  t.is(same.run(prep + 'preparar_versao').status, 0, 'first preparation')
  const ino = fs.statSync(same.p('releases', COMMIT)).ino
  same.write('fix/ps_seeder', 'aaa111\n')
  same.write('fix/wd_aaa111', same.p('releases', COMMIT) + '\n')
  const again = same.run(prep + 'preparar_versao\nprintf "dir=%s recriar=%s\\n" "$cand_dir" "$recriar" >&3')
  t.is(again.status, 0, 'the same files are reused: ' + again.out)
  t.is(fs.statSync(same.p('releases', COMMIT)).ino, ino, 'the directory was not replaced')
  t.ok(again.out.includes('dir=' + same.p('releases', COMMIT) + ' recriar=0'), 'no recreation needed')

  // current names it while an older release is installed (killed in concluir).
  const cur = server(t)
  cur.write('state/atual', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  const cdir = installRelease(cur, COMMIT, { www: false })
  cur.write(path.join('releases', COMMIT, 'stale'), 'x\n')
  fs.symlinkSync(cdir, cur.p('releases/current'))
  t.is(cur.run(prep + 'preparar_versao').status, 1, 'the directory current points to is refused')
  t.ok(cur.exists(path.join('releases', COMMIT, 'stale')), 'and left alone')
})

test('update.sh: a replaced release directory is applied with --force-recreate', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('state/atual', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  installRelease(s, OLD_COMMIT, { www: false })
  installRelease(s, COMMIT, { www: false })
  s.write(path.join('releases', COMMIT, 'stale'), 'x\n')
  const r = s.run(MAIN + 'cmd_apply')
  t.is(r.status, 0, 'apply passes: ' + r.log)
  t.absent(s.exists(path.join('releases', COMMIT, 'stale')), 'the unused directory was replaced')
  t.ok(r.calls.includes('compose pwd=' + s.p('releases', COMMIT) + ' seeder=' + SEEDER_REF + ' web=' + WEB_REF +
    ' compose -p varanda-seeder -f compose.yaml -f compose.release.yaml up -d --no-build --force-recreate\n'), 'compose up recreates the containers')
})

test('update.sh: concluir removes the images of the release that left, never the kept ones', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('state/atual', record(OLD_COMMIT, 2, OLD_SEEDER, OLD_WEB))
  s.write('state/anterior', record(H('2', 40), 1, OLDER_SEEDER, OLDER_WEB))
  installRelease(s, OLD_COMMIT, { www: false })
  installRelease(s, H('2', 40), { www: false })
  const r = s.run(MAIN + 'cmd_apply')
  t.is(r.status, 0, 'apply passes: ' + r.log)
  t.ok(r.calls.includes('docker image rm ' + OLDER_SEEDER + '\n'), 'the dropped seeder image is removed')
  t.ok(r.calls.includes('docker image rm ' + OLDER_WEB + '\n'), 'the dropped web image is removed')
  for (const keep of [OLD_SEEDER, OLD_WEB, SEEDER_REF, WEB_REF]) {
    t.absent(r.calls.includes('docker image rm ' + keep), 'keeps ' + keep.slice(0, 50))
  }
  t.absent(s.exists(path.join('releases', H('2', 40))), 'the dropped release directory is removed')

  // A dropped release sharing an image with the new anterior keeps it.
  const s2 = server(t)
  s2.write('state/atual', record(OLD_COMMIT, 2, OLD_SEEDER, OLD_WEB))
  s2.write('state/anterior', record(H('2', 40), 1, OLD_SEEDER, OLDER_WEB))
  installRelease(s2, OLD_COMMIT, { www: false })
  const r2 = s2.run(MAIN + 'cmd_apply')
  t.is(r2.status, 0, 'apply passes')
  t.absent(r2.calls.includes('docker image rm ' + OLD_SEEDER), 'an image still used by anterior stays')
  t.ok(r2.calls.includes('docker image rm ' + OLDER_WEB + '\n'), 'the unused one goes')
})

test('update.sh: without an installed release the prepared or previous seq is the floor', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('state/preparada', record(H('6', 40), 7, OLD_SEEDER, OLD_WEB))
  const older = s.run(MAIN + 'cmd_check')
  t.is(older.status, 1, 'a release older than preparada is refused')
  t.ok(older.log.includes('versão mais antiga que a registrada em ' + s.p('state/preparada')), 'says why')
  t.absent(s.exists('state/disponivel'), 'nothing recorded')
  s.write('state/preparada', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  t.is(s.run(MAIN + 'cmd_check').status, 0, 'the prepared release itself passes (the first apply)')
  fs.rmSync(s.p('state/preparada'))
  s.write('state/anterior', record(H('6', 40), 9, OLD_SEEDER, OLD_WEB))
  t.is(s.run(MAIN + 'cmd_check').status, 1, 'a release older than anterior is refused')
  s.write('state/anterior', 'origem=checkout\ncheckout=' + s.p('checkout') + '\n')
  t.is(s.run(MAIN + 'cmd_check').status, 0, 'a checkout anterior has no seq and sets no floor')
})

test('update.sh: the checkout must be root-only before root runs its compose', (t) => {
  if (!hasBash(t)) return
  for (const bad of ['checkout', 'checkout/compose.yaml', '']) {
    const s = server(t)
    s.write('etc/update.conf', 'VARANDA_UPDATE=manual\nVARANDA_PROFILE=full\n')
    s.write('etc/varanda.env', FULL_ENV)
    s.write('fix/ps_seeder', 'aaa111\n')
    s.write('fix/img_aaa111', 'sha256:old-seeder\n')
    s.write('fix/workdir', s.p('checkout') + '\n')
    const target = bad ? s.p(bad) : s.d
    s.write('fix/dono_bad', target)
    const r = s.run(MAIN + 'ref_install=' + SEEDER_REF + '\ncmd_install')
    t.is(r.status, 1, 'refused when ' + (bad || 'an ancestor') + ' is not root-only')
    t.ok(r.log.includes(target + ' precisa ser de root e sem escrita para grupo ou outros'), 'names the path')
    t.absent(s.exists('lock/modo-pull'), 'no marker')
    t.absent(s.exists('state/anterior'), 'no anterior')
    t.absent(r.calls.includes('docker create'), 'nothing extracted')
  }
  // The way back checks it again before using it.
  const rb = server(t)
  rb.write('state/atual', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  rb.write('state/anterior', 'origem=checkout\ncheckout=' + rb.p('checkout') + '\n')
  rb.write('fix/dono_bad', rb.p('checkout/compose.yaml'))
  const back = rb.run(MAIN + 'cmd_rollback')
  t.is(back.status, 1, 'rollback refuses a checkout that is not root-only')
  t.ok(rb.read('state/intervencao').includes('não passou na conferência de dono e modo'), 'intervencao says why')
  t.absent(back.calls.includes('compose pwd=' + rb.p('checkout')), 'no compose in the checkout')
  t.absent(back.calls.includes('varanda-seeder:local'), 'no image retagged')
})

test('update.sh: a failed migration can be applied again once fixed', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('etc/update.conf', 'VARANDA_UPDATE=manual\nVARANDA_PROFILE=full\n')
  s.write('etc/varanda.env', FULL_ENV)
  s.write('fix/ps_seeder', 'aaa111\n')
  s.write('fix/ps_web', 'bbb222\n')
  s.write('fix/img_aaa111', 'sha256:old-seeder\n')
  s.write('fix/img_bbb222', 'sha256:old-caddy\n')
  s.write('fix/workdir', s.p('checkout') + '\n')
  s.write('fix/gate_fail_1', '')
  t.is(s.run(MAIN + 'ref_install=' + SEEDER_REF + '\ncmd_install').status, 1, 'the first apply fails and goes back to the checkout')
  const again = s.run(MAIN + 'cmd_apply')
  t.is(again.status, 0, 'apply after the fix passes: ' + again.log)
  t.ok(again.log.includes('já preparada em ' + s.p('releases', COMMIT)), 'reuses the prepared directory current points at')
  t.is(s.read('state/atual'), record(COMMIT, 5, SEEDER_REF, WEB_REF), 'atual written')
  t.absent(s.exists('state/intervencao'), 'intervention cleared')
})

test('update.sh: a new server whose first apply failed takes new app associations', (t) => {
  if (!hasBash(t)) return
  const prep = MAIN + 'comecar teste\ncand_seeder=' + SEEDER_REF + '\ncand_web=' + WEB_REF + '\ncand_commit=' + COMMIT + '\ncand_seq=5\n'
  const s = server(t)
  s.write('etc/update.conf', 'VARANDA_UPDATE=manual\nVARANDA_PROFILE=full\n')
  s.write('etc/varanda.env', FULL_ENV)
  t.is(s.run(prep + 'preparar_versao').status, 0, 'prepared without the iOS app id')
  const dir = s.p('releases', COMMIT)
  const ino = fs.statSync(dir).ino
  s.write('state/preparada', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  s.write('state/intervencao', 'sem versão anterior para voltar\n')
  s.write('fix/ps_seeder', 'aaa111\n')
  s.write('fix/img_aaa111', 'sha256:id-' + SEEDER_REF + '\n')
  s.write('fix/wd_aaa111', dir + '\n')
  s.write('etc/varanda.env', FULL_ENV + 'VARANDA_IOS_APP_ID=ABCDEFGHIJ.app.varanda\n')
  const r = s.run(MAIN + 'cmd_apply')
  t.is(r.status, 0, 'apply passes: ' + r.log)
  t.ok(r.log.includes('associações do app nativo regravadas'), 'logs the rewrite')
  t.is(fs.statSync(dir).ino, ino, 'the mounted directory stays in place')
  const aasa = path.join(dir, 'www/.well-known/apple-app-site-association')
  t.ok(fs.existsSync(aasa) && fs.readFileSync(aasa, 'utf8').includes('ABCDEFGHIJ.app.varanda'), 'the association file now names the app')
  t.ok(r.calls.includes(' up -d --no-build --force-recreate\n'), 'the containers are recreated')

  // Any other difference still refuses.
  const o = server(t)
  o.write('etc/update.conf', 'VARANDA_UPDATE=manual\nVARANDA_PROFILE=full\n')
  o.write('etc/varanda.env', FULL_ENV)
  t.is(o.run(prep + 'preparar_versao').status, 0, 'prepared')
  o.write(path.join('releases', COMMIT, 'www/extra'), 'x\n')
  o.write('fix/ps_seeder', 'aaa111\n')
  o.write('fix/wd_aaa111', o.p('releases', COMMIT) + '\n')
  o.write('etc/varanda.env', FULL_ENV + 'VARANDA_IOS_APP_ID=ABCDEFGHIJ.app.varanda\n')
  const other = o.run(prep + 'preparar_versao')
  t.is(other.status, 1, 'another difference is refused')
  t.ok(other.log.includes("'update.sh compose rm -sf'"), 'with the hint to remove leftover containers')
  t.absent(o.exists(path.join('releases', COMMIT, 'www/.well-known/apple-app-site-association')), 'nothing rewritten')

  // The installed release is never rewritten this way.
  const a = server(t)
  a.write('etc/update.conf', 'VARANDA_UPDATE=manual\nVARANDA_PROFILE=full\n')
  a.write('etc/varanda.env', FULL_ENV)
  t.is(a.run(prep + 'preparar_versao').status, 0, 'prepared')
  a.write('state/atual', record(COMMIT, 4, OLD_SEEDER, OLD_WEB))
  a.write('fix/ps_seeder', 'aaa111\n')
  a.write('fix/wd_aaa111', a.p('releases', COMMIT) + '\n')
  a.write('etc/varanda.env', FULL_ENV + 'VARANDA_IOS_APP_ID=ABCDEFGHIJ.app.varanda\n')
  t.is(a.run(prep + 'preparar_versao').status, 1, 'the installed commit is refused')
  t.absent(a.exists(path.join('releases', COMMIT, 'www/.well-known/apple-app-site-association')), 'and left alone')
})

test('update.sh: stopped one-off containers do not hold a release directory, running ones do', (t) => {
  if (!hasBash(t)) return
  const prep = MAIN + 'comecar teste\ncand_seeder=' + SEEDER_REF + '\ncand_web=' + WEB_REF + '\ncand_commit=' + COMMIT + '\ncand_seq=5\n'
  for (const state of ['stopped', 'running']) {
    const s = server(t)
    s.write('state/atual', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
    const dir = installRelease(s, COMMIT, { www: false })
    s.write(path.join('releases', COMMIT, 'stale'), 'x\n')
    s.write('fix/ps_oneoff_' + state, 'ddd444\n')
    s.write('fix/wd_ddd444', dir + '\n')
    const r = s.run(prep + 'preparar_versao')
    if (state === 'stopped') {
      t.is(r.status, 0, 'a stopped compose run container does not block: ' + r.log)
      t.absent(s.exists(path.join('releases', COMMIT, 'stale')), 'the directory was replaced')
    } else {
      t.is(r.status, 1, 'a running compose run container blocks the replacement')
      t.ok(s.exists(path.join('releases', COMMIT, 'stale')), 'the directory is untouched')
    }
  }
})

test('update.sh: docker ps failing counts as mounted', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('state/atual', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  installRelease(s, COMMIT, { www: false })
  s.write(path.join('releases', COMMIT, 'stale'), 'x\n')
  s.write('fix/ps_fail', '')
  const r = s.run(MAIN + 'cmd_apply')
  t.is(r.status, 1, 'refused')
  t.ok(r.log.includes('já está em uso com outros arquivos'), 'as in use')
  t.ok(s.exists(path.join('releases', COMMIT, 'stale')), 'the directory is untouched')
  t.absent(composeRan(r.calls.replace(/^compose [^\n]* config -q\n/mg, '')), 'no compose up')
})

test('update.sh: install --image of an older verified release ignores the preparada floor, not the atual one', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('state/preparada', record(H('6', 40), 7, OLD_SEEDER, OLD_WEB))
  const r = s.run(MAIN + 'ref_install=' + SEEDER_REF + '\ncmd_install')
  t.is(r.status, 0, 'install of seq 5 over a preparada of seq 7 passes: ' + r.log)
  t.is(s.read('state/preparada'), record(COMMIT, 5, SEEDER_REF, WEB_REF), 'preparada is the chosen release')

  s.write('state/preparada', record(H('6', 40), 7, OLD_SEEDER, OLD_WEB))
  const run = s.run(MAIN + 'cmd_apply')
  t.is(run.status, 1, 'apply still keeps the floor')
  t.ok(run.log.includes('apague ' + s.p('state/preparada') + ' e rode de novo'), 'and names the file to delete')

  const a = server(t)
  a.write('state/atual', record(OLD_COMMIT, 7, OLD_SEEDER, OLD_WEB))
  const old = a.run(MAIN + 'ref_install=' + SEEDER_REF + '\ncmd_install')
  t.is(old.status, 1, 'install of an older release than atual is refused')
  t.ok(old.log.includes('versão mais antiga que a instalada'), 'by the atual floor')
})

test('update.sh: a reused release directory is checked and normalised again; $releases must be root-only', (t) => {
  if (!hasBash(t)) return
  const prep = MAIN + 'comecar teste\ncand_seeder=' + SEEDER_REF + '\ncand_web=' + WEB_REF + '\ncand_commit=' + COMMIT + '\ncand_seq=5\n'
  const s = server(t)
  t.is(s.run(prep + 'preparar_versao').status, 0, 'prepared')
  const dir = s.p('releases', COMMIT)
  fs.chmodSync(path.join(dir, 'compose.yaml'), 0o666)
  fs.chmodSync(dir, 0o777)
  const r = s.run(prep + 'preparar_versao')
  t.is(r.status, 0, 'reused: ' + r.log)
  t.ok(r.log.includes('com os mesmos arquivos'), 'by the same-files path')
  t.is(fs.statSync(path.join(dir, 'compose.yaml')).mode & 0o7777, 0o644, 'a group-writable file is normalised on reuse')
  t.is(fs.statSync(dir).mode & 0o7777, 0o755, 'the directory too')

  // diff follows links: a link to identical bytes is caught by the re-check.
  fs.rmSync(path.join(dir, 'Caddyfile'))
  fs.symlinkSync(s.p('fix/bundle/Caddyfile'), path.join(dir, 'Caddyfile'))
  const link = s.run(prep + 'preparar_versao')
  t.is(link.status, 1, 'a symlink in the reused directory is refused')
  t.ok(link.log.includes('não passou na conferência'), 'says why')

  const w = server(t)
  w.write('fix/dono_bad', w.p('releases'))
  const bad = w.run(prep + 'preparar_versao')
  t.is(bad.status, 1, 'a $releases not root-only is refused')
  t.ok(bad.log.includes(w.p('releases') + ' precisa ser de root e sem escrita para grupo ou outros'), 'says why')
  t.alike(fs.readdirSync(w.p('releases')), [], 'nothing created under it')
})

test('update.sh: owner and mode rules with writable and readable modes', (t) => {
  if (!hasBash(t)) return
  // Root writes only: checkout, its ancestors and files, and $releases.
  const s = server(t)
  const check = (mode) => {
    s.write('fix/dono_modo', '0 ' + mode + '\n')
    return s.run('comecar teste\nconferir_checkout ' + JSON.stringify(s.p('checkout'))).status
  }
  for (const m of ['775', '664', '660', '1777']) t.is(check(m), 1, 'conferir_checkout refuses 0 ' + m)
  for (const m of ['755', '640', '2755']) t.is(check(m), 0, 'conferir_checkout accepts 0 ' + m)
  // varanda.env holds secrets: no access at all for group or others.
  const e = server(t)
  e.write('etc/update.conf', 'VARANDA_UPDATE=auto\nVARANDA_PROFILE=full\n')
  e.write('etc/varanda.env', FULL_ENV)
  const env = (mode) => {
    e.write('fix/dono_modo', '0 ' + mode + '\n')
    return e.run(MAIN).status
  }
  for (const m of ['775', '664', '660', '1777', '755', '640', '2755', '604']) t.is(env(m), 1, 'varanda.env refuses 0 ' + m)
  for (const m of ['600', '400', '0']) t.is(env(m), 0, 'varanda.env accepts 0 ' + m)
})

test('update.sh: a real gate failure in apply fires the way back, which passes the real gate', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('state/atual', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  installRelease(s, OLD_COMMIT, { www: false })
  s.write('fix/real_gate', '')
  s.write('fix/health_code', '200')
  // compose up "did not recreate" the seeder: it still runs the old image,
  // which is exactly what the way back expects.
  s.write('fix/ps_seeder', 'aaa111\n')
  s.write('fix/img_aaa111', 'sha256:id-' + OLD_SEEDER + '\n')
  const r = s.run(MAIN + 'cmd_apply')
  t.is(r.status, 1, 'apply exits 1')
  t.ok(r.log.includes('o serviço seeder roda a imagem sha256:id-' + OLD_SEEDER + ', não sha256:id-' + SEEDER_REF), 'the real image check failed')
  t.ok(r.log.includes('atualização para ' + COMMIT + ': falha na linha'), 'the ERR trap fired')
  t.ok(r.calls.includes('compose pwd=' + s.p('releases', OLD_COMMIT) + ' seeder=' + OLD_SEEDER + ' web=' + OLD_WEB +
    ' compose -p varanda-seeder -f compose.yaml -f compose.release.yaml up -d --no-build --force-recreate\n'), 'the previous release is recreated')
  t.is(r.log.split('saúde: health 200, imagens conferidas').length - 1, 1, 'the real gate passed once, on the way back')
  t.ok(r.log.includes('voltou para ' + OLD_COMMIT), 'logs the way back')
  t.absent(s.exists('state/intervencao'), 'no intervention')
  t.is(s.read('state/recusadas'), DIGEST + '\n', 'the digest is refused')
})
