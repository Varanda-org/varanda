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
const crypto = require('node:crypto')
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
  'VARANDA_MAX_EXTERNAL', 'VARANDA_MAX_SOCKETS', 'VARANDA_FRAME_MEMORY', 'VARANDA_STORAGE_BYTES',
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
# The host path bound at container path $1 by a --mount of the docker run.
mount_source() {
  local alvo=$1 a src
  shift
  for a in "$@"; do
    case $a in
      type=bind,source=*",target=$alvo"*)
        src=$` + '{a#type=bind,source=}' + String.raw`
        printf '%s\n' "$` + '{src%%,target=*}' + String.raw`"
        return 0 ;;
    esac
  done
  return 1
}
# The last non-empty-or-empty assignment of $1 in env file $2, quotes dropped.
env_valor() { sed -n "s/^$1=//p" "$2" | tail -n 1 | tr -d "'\""; }
docker() {
  local a ultimo='' svc='' si wi prev='' ef=''
  for a in "$@"; do ultimo=$a; done
  case $1 in
    compose)
      si=$(printenv VARANDA_SEEDER_IMAGE || true)
      wi=$(printenv VARANDA_WEB_IMAGE || true)
      printf 'compose pwd=%s seeder=%s web=%s %s\n' "$PWD" "$si" "$wi" "$*" >>"$CALLS"
      # Like real Compose with \${VAR:?}: up refuses an env file whose
      # Google client is absent or empty.
      if [ -f "$FIX/up_needs_google" ]; then
        case " $* " in
          *" up "*)
            for a in "$@"; do
              if [ "$prev" = --env-file ]; then ef=$a; fi
              prev=$a
            done
            if [ -z "$ef" ] || [ -z "$(env_valor VARANDA_GOOGLE_CLIENT_ID "$ef")" ] ||
              [ -z "$(env_valor VARANDA_GOOGLE_CLIENT_SECRET "$ef")" ]; then
              printf 'compose up refused %s\n' "$ef" >>"$CALLS"
              return 1
            fi ;;
        esac
      fi
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
        *" secrets open "*)
          printf '%s\n' "$*" >>"$FIX/open_calls"
          si=$(cat "$FIX/open_rc" 2>/dev/null || printf '0')
          # A careless CLI echoing the key file: update.sh must never log it.
          cat "$(mount_source /segredos/chave.json "$@")" >&2
          if [ -f "$FIX/open_exit" ]; then exit 1; fi
          if [ -f "$FIX/open_err" ]; then cat "$FIX/open_err" >&2; fi
          if [ "$si" = 0 ]; then
            wi=$(mount_source /segredos/saida "$@")
            cp "$FIX/aberto.env" "$wi/aberto.env"
            if [ -f "$FIX/aberto_link" ]; then rm -f "$wi/aberto.env"; ln -s "$FIX/aberto.env" "$wi/aberto.env"; fi
            printf '1 nome gravado\n'
          fi
          return "$si" ;;
        *" secrets verify "*)
          printf '%s\n' "$*" >>"$FIX/verify_calls"
          # Only the locked-down flags and the two read-only mounts: never
          # the key, never a writable mount.
          case "$*" in
            *chave* | *secrets-key* | */segredos/saida*)
              printf 'key or writable mount: %s\n' "$*" >>"$FIX/verify_bad"
              return 98 ;;
            "run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 --mount type=bind,source="*",target=/segredos/selado.json,readonly --mount type=bind,source="*",target=/segredos/assinantes.txt,readonly ghcr.io/varanda-org/varanda-seeder@sha256:"*" secrets verify --file /segredos/selado.json --signers /segredos/assinantes.txt --json") ;;
            *)
              printf 'flags: %s\n' "$*" >>"$FIX/verify_bad"
              return 98 ;;
          esac
          # A careless CLI writing to stderr: update.sh drops it.
          printf 'VERIFY-STDERR-CANARY\n' >&2
          if [ -f "$FIX/verify_exit" ]; then printf 'x\n'; exit 1; fi
          if [ -f "$FIX/verify_err" ]; then cat "$FIX/verify_err" >&2; fi
          if [ -f "$FIX/verify_out" ]; then
            cat "$FIX/verify_out"
          else
            printf '{"signer":"%s","recipients":2,"seq":%s}\n' "$(cat "$FIX/signer" 2>/dev/null || printf '5555555555555555555555555555555555555555555555555555555555555555')" "$(cat "$FIX/seq" 2>/dev/null || printf '1')"
          fi
          return "$(cat "$FIX/verify_rc" 2>/dev/null || printf '0')" ;;
        *" secrets key "*)
          printf '%s\n' "$*" >>"$FIX/key_calls"
          if [ -f "$FIX/key_fail" ]; then return 1; fi
          wi=$(mount_source /saida "$@")
          if [ -f "$FIX/key_pretty" ]; then
            printf '{\n  "v": 1,\n  "publicKey" : "%s",\n  "secretKey": "%s"\n}\n' "$(cat "$FIX/pub")" "$(cat "$FIX/sec")" >"$wi/secrets-key.json"
          elif [ -f "$FIX/key_two" ]; then
            printf '{"v":1,"publicKey":"%s","publicKey":"%s","secretKey":"%s"}\n' "$(cat "$FIX/pub")" "$(cat "$FIX/key_two")" "$(cat "$FIX/sec")" >"$wi/secrets-key.json"
          else
            printf '{"v":1,"publicKey":"%s","secretKey":"%s"}\n' "$(cat "$FIX/pub")" "$(cat "$FIX/sec")" >"$wi/secrets-key.json"
          fi
          chmod 600 "$wi/secrets-key.json"
          cat "$FIX/pub"
          return 0 ;;
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
        tag)
          if [ -f "$FIX/tag_fail" ]; then return 1; fi
          if [ -f "$FIX/term_at_tag" ]; then kill -TERM $$; fi
          printf '%s %s\n' "$4" "$(idof "$3")" >>"$FIX/tags" ;;
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
  if [ -f "$FIX/dm_$` + '{1##*/}' + String.raw`" ]; then cat "$FIX/dm_$` + '{1##*/}' + String.raw`"; return 0; fi
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
      'chave_segredos=' + JSON.stringify(p('etc/secrets-key.json')) + '\nsegredos="$state/segredos"\n' +
      '. ' + JSON.stringify(WELL_KNOWN) + '\n' + STUBS + '\n' + commands + '\n'
    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    return { status: res.status, out: res.stdout + res.stderr, stdout: res.stdout, log: read('state/update.log'), calls: read('calls') }
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
    '[ -z "$versao" ] || servido_igual "varanda-node-$versao.js" "varanda-node-$versao.js"',
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
  t.is(check('VARANDA_STORAGE_BYTES=1073741823\n', 'seeder'), 1, 'VARANDA_STORAGE_BYTES below 1 GiB is refused')
  t.is(check('VARANDA_STORAGE_BYTES=1073741824\n', 'seeder'), 0, 'VARANDA_STORAGE_BYTES=1073741824 passes')
  t.is(check('VARANDA_STORAGE_BYTES=1125899906842624\n', 'seeder'), 0, 'VARANDA_STORAGE_BYTES at 1 PiB (16 digits) passes')
  t.is(check('VARANDA_STORAGE_BYTES=1125899906842625\n', 'seeder'), 1, 'VARANDA_STORAGE_BYTES above 1 PiB is refused')
  t.is(check('VARANDA_STORAGE_BYTES=11258999068426240\n', 'seeder'), 1, '17 digits are refused')
  t.is(check('VARANDA_STORAGE_BYTES=01073741824\n', 'seeder'), 1, 'a leading zero is refused')
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

  // A page marked with its release loads varanda-node-<release>.js: that copy
  // is probed too, and a page without the mark skips it (an older release).
  const releaseNode = 'varanda-node-0123456789abcdef.js'
  fs.writeFileSync(path.join(dir, 'www/index.html'), '<html><head><meta name="varanda-release" content="0123456789abcdef"></head></html>\n')
  fs.copyFileSync(path.join(dir, 'www/index.html'), s.p('fix/served/_root'))
  fs.writeFileSync(path.join(dir, 'www', releaseNode), 'node copy\n')
  const noCopy = gate()
  t.is(noCopy.status, 1, 'a marked page whose node copy is not served fails')
  t.ok(noCopy.calls.includes('https://app.exemplo.org/' + releaseNode), 'probes the node copy')
  fs.copyFileSync(path.join(dir, 'www', releaseNode), s.p('fix/served', releaseNode))
  const marked = gate()
  t.is(marked.status, 0, 'passes once the node copy is served: ' + marked.log)

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

// Shared secrets (secrets.sealed.json in the bundle, opened by the new image).
// Every value and key is a fresh sentinel, so a leak into the log or the
// output is caught by a plain search.
const sentinel = (tag) => tag + crypto.randomBytes(8).toString('hex')
const MARK = '# segredos compartilhados (update.sh)'
const leaks = (r, values) => values.filter((x) => (r.out + r.log).includes(x))
const modeOf = (p) => { try { return fs.statSync(p).mode & 0o777 } catch { return null } }

// A server running OLD_COMMIT whose next bundle carries secrets.sealed.json,
// with a key file and the lines `secrets open` writes.
function secretsServer (t, { profile = 'seeder', localEnv = null } = {}) {
  const s = server(t)
  const v = { gif: sentinel('gif'), id: sentinel('id'), secret: sentinel('sec'), key: sentinel('key') }
  s.write('etc/update.conf', 'VARANDA_UPDATE=manual\nVARANDA_PROFILE=' + profile + '\n')
  if (localEnv !== null) s.write('etc/varanda.env', localEnv)
  s.write('fix/bundle/secrets.sealed.json', '{"v":1}\n')
  s.write('fix/bundle/secrets-signers.txt', H('5', 64) + '\n')
  s.write('etc/secrets-key.json', '{"v":1,"publicKey":"' + H('f', 64) + '","secretKey":"' + v.key + '"}\n')
  s.write('fix/aberto.env', "VARANDA_GIF_API_KEY='" + v.gif + "'\nVARANDA_GOOGLE_CLIENT_ID='" + v.id +
    "'\nVARANDA_GOOGLE_CLIENT_SECRET='" + v.secret + "'\n")
  s.write('state/atual', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  installRelease(s, OLD_COMMIT, { www: profile === 'full' })
  fs.mkdirSync(s.p('state/segredos'), { recursive: true })
  return { s, v }
}

test('update.sh: shared secrets fill only what varanda.env leaves absent or empty', (t) => {
  if (!hasBash(t)) return
  const localId = sentinel('localid')
  // No final LF, a non-empty local Google id and an empty local secret.
  const localEnv = 'VARANDA_DOMAIN=app.exemplo.org\nVARANDA_ASSOCIATION=' + H('a', 64) +
    '\nVARANDA_GOOGLE_CLIENT_ID=' + localId + '\nVARANDA_GOOGLE_CLIENT_SECRET='
  const { s, v } = secretsServer(t, { profile: 'full', localEnv })
  // The running release already took its Google secret from a sealed file.
  const oldSecret = sentinel('oldsec')
  const oldEfetivo = localEnv + '\n' + MARK + "\nVARANDA_GOOGLE_CLIENT_SECRET='" + oldSecret + "'\n"
  s.write('state/segredos/efetivo.env', oldEfetivo, 0o600)
  const r = s.run(MAIN + 'cmd_apply')
  t.is(r.status, 0, 'a full apply whose Google secret comes only from the sealed file passes: ' + r.log)
  const efetivo = s.p('state/segredos/efetivo.env')
  t.is(s.read('state/segredos/efetivo.env'), localEnv + '\n' + MARK + '\n' + "VARANDA_GIF_API_KEY='" + v.gif + "'\n" +
    "VARANDA_GOOGLE_CLIENT_SECRET='" + v.secret + "'\n",
  'varanda.env bytes, a LF, then the absent name and the empty one; the non-empty local id wins')
  t.is(modeOf(efetivo), 0o600, 'efetivo.env is 0600')
  t.is(modeOf(s.p('state/segredos')), 0o700, 'the segredos directory is 0700')
  t.ok(r.log.includes('segredos compartilhados: 2 variáveis aplicadas'), 'logs the number of names applied')
  const open = s.read('fix/open_calls')
  t.ok(open.includes('run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 '),
    'secrets open runs without network, read-only, without capabilities or new privileges')
  t.ok(open.includes('type=bind,source=' + s.p('etc/secrets-key.json') + ',target=/segredos/chave.json,readonly'), 'the key file is mounted read-only')
  t.ok(open.includes('type=bind,source=' + s.p('releases', COMMIT + '.tmp', 'secrets.sealed.json') + ',target=/segredos/selado.json,readonly'),
    'the sealed file of the new, verified bundle is mounted read-only')
  t.ok(open.includes('type=bind,source=' + s.p('releases', COMMIT + '.tmp', 'secrets-signers.txt') + ',target=/segredos/assinantes.txt,readonly'),
    'the signers list of the same bundle is mounted read-only')
  t.ok(open.includes(' ' + SEEDER_REF + ' secrets open --key-file /segredos/chave.json --file /segredos/selado.json --signers /segredos/assinantes.txt --out /segredos/saida/aberto.env'),
    'the new image runs by digest, with the pinned signers')
  t.ok(r.calls.indexOf(' secrets open ') < r.calls.indexOf('config -q'), 'opened before compose config')
  t.ok(r.calls.includes('--env-file ' + s.p('state/segredos/efetivo.env.novo') + ' -f compose.yaml -f compose.web.yaml -f compose.release.yaml -f compose.release.web.yaml config -q\n'),
    'compose config checks the candidate')
  t.ok(r.calls.includes('compose -p varanda-seeder --env-file ' + efetivo + ' -f compose.yaml -f compose.web.yaml -f compose.release.yaml -f compose.release.web.yaml up -d --no-build\n'),
    'compose up reads efetivo.env')
  t.absent(s.exists('state/segredos/abrir'), 'no aberto.env or work directory left')
  t.absent(s.exists('state/segredos/efetivo.env.novo'), 'the candidate became efetivo.env')
  t.is(s.read('state/segredos/efetivo.env.anterior'), oldEfetivo, 'the running release efetivo.env follows the previous record')
  t.alike(leaks(r, [...Object.values(v), localId, oldSecret]), [], 'no value or key in the log or the output')
  const st = s.run(MAIN + 'cmd_status')
  t.ok(st.out.split('\n').includes('segredos compartilhados: VARANDA_GIF_API_KEY VARANDA_GOOGLE_CLIENT_SECRET'), 'status names the shared names')
  t.alike(leaks(st, [...Object.values(v), localId]), [], 'status shows no value')
  const c = s.run(MAIN + 'cmd_compose ps')
  t.ok(c.calls.includes('compose -p varanda-seeder --env-file ' + efetivo + ' '), 'update.sh compose reads efetivo.env')

  // The last local assignment wins, as in compose; a file ending in LF gets
  // no blank line.
  const local2 = 'VARANDA_GIF_API_KEY=antes\nVARANDA_GIF_API_KEY= # vazia\nVARANDA_GOOGLE_CLIENT_ID=""\nVARANDA_GOOGLE_CLIENT_SECRET=' + localId + '\n'
  const b = secretsServer(t, { localEnv: local2 })
  const r2 = b.s.run(MAIN + 'cmd_apply')
  t.is(r2.status, 0, 'profile seeder apply passes: ' + r2.log)
  t.is(b.s.read('state/segredos/efetivo.env'), local2 + MARK + '\n' + "VARANDA_GIF_API_KEY='" + b.v.gif + "'\n" +
    "VARANDA_GOOGLE_CLIENT_ID='" + b.v.id + "'\n", 'an emptied last assignment and a quoted empty value take the shared value')
  t.alike(leaks(r2, [...Object.values(b.v), localId]), [], 'no value in the log or the output')

  // Without varanda.env (profile seeder), the opened lines alone.
  const n = secretsServer(t)
  const r3 = n.s.run(MAIN + 'cmd_apply')
  t.is(r3.status, 0, 'apply without varanda.env passes: ' + r3.log)
  t.is(n.s.read('state/segredos/efetivo.env'), MARK + '\n' + n.s.read('fix/aberto.env'), 'every opened name is added')
  t.ok(r3.log.includes('segredos compartilhados: 3 variáveis aplicadas'), 'all three counted')
})

test('update.sh: secrets open exit 3, no sealed file or no key file mean no shared secrets; another exit changes nothing', (t) => {
  if (!hasBash(t)) return
  const old = (s) => {
    const val = sentinel('velho')
    s.write('state/segredos/efetivo.env', 'VARANDA_GIF_API_KEY=' + val + '\n', 0o600)
    return val
  }
  const plain = 'VARANDA_MAX_SOCKETS=10\n'
  const back = (s) => 'compose -p varanda-seeder --env-file ' + s.p('etc/varanda.env') + ' -f compose.yaml -f compose.release.yaml up -d --no-build\n'

  // Exit 3, with an aberto.env left by an earlier run in the work directory.
  const a = secretsServer(t, { localEnv: plain })
  const val = old(a.s)
  fs.mkdirSync(a.s.p('state/segredos/abrir'))
  const stale = sentinel('stale')
  a.s.write('state/segredos/abrir/aberto.env', "VARANDA_GIF_API_KEY='" + stale + "'\n")
  a.s.write('fix/open_rc', '3')
  const r = a.s.run(MAIN + 'cmd_apply')
  t.is(r.status, 0, 'exit 3 still applies: ' + r.log)
  t.ok(r.log.includes('segredos compartilhados: este servidor não é destinatário'), 'logs that this server is not a recipient')
  t.absent(a.s.exists('state/segredos/efetivo.env'), 'efetivo.env is removed at the switch')
  t.ok(r.calls.includes(back(a.s)), 'compose reads varanda.env, as without shared secrets')
  t.ok(a.s.read('state/segredos/efetivo.env.anterior').includes(val), 'the previous efetivo.env follows the previous release')
  t.absent(a.s.exists('state/segredos/abrir'), 'the stale aberto.env is never used and is gone')
  t.alike(leaks(r, [...Object.values(a.v), val, stale]), [], 'no value in the log or the output')

  // No sealed file in the bundle: secrets open never runs.
  const b = secretsServer(t, { localEnv: plain })
  old(b.s)
  fs.rmSync(b.s.p('fix/bundle/secrets.sealed.json'))
  const rb = b.s.run(MAIN + 'cmd_apply')
  t.is(rb.status, 0, 'a bundle without secrets.sealed.json applies: ' + rb.log)
  t.absent(b.s.exists('fix/open_calls'), 'secrets open never runs')
  t.absent(b.s.exists('state/segredos/efetivo.env'), 'no efetivo.env')
  t.ok(rb.calls.includes(back(b.s)), 'compose reads varanda.env')

  // No key file: the same.
  const c = secretsServer(t, { localEnv: plain })
  old(c.s)
  fs.rmSync(c.s.p('etc/secrets-key.json'))
  const rc = c.s.run(MAIN + 'cmd_apply')
  t.is(rc.status, 0, 'a server without the key file applies: ' + rc.log)
  t.absent(c.s.exists('fix/open_calls'), 'secrets open never runs without the key')
  t.absent(c.s.exists('state/segredos/efetivo.env'), 'no efetivo.env')

  // Any other exit aborts before anything running changes.
  for (const code of ['1', '2']) {
    const d = secretsServer(t, { localEnv: plain })
    const keep = old(d.s)
    d.s.write('fix/open_rc', code)
    const rd = d.s.run(MAIN + 'cmd_apply')
    t.is(rd.status, 1, 'exit ' + code + ' fails the apply')
    t.ok(rd.log.includes('não foi possível abrir os segredos compartilhados (saída ' + code + '); nada mudou'), 'says so, without a value')
    t.absent(composeRan(rd.calls), 'no compose at all, not even config')
    t.is(d.s.read('state/atual'), record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB), 'atual unchanged')
    t.is(d.s.read('state/segredos/efetivo.env'), 'VARANDA_GIF_API_KEY=' + keep + '\n', 'efetivo.env unchanged')
    t.absent(d.s.exists('state/segredos/abrir'), 'no aberto.env left')
    t.absent(d.s.exists('state/segredos/efetivo.env.novo'), 'no candidate left')
    t.alike(fs.readdirSync(d.s.p('releases')), [OLD_COMMIT], 'no new release directory')
    t.alike(leaks(rd, [...Object.values(d.v), keep]), [], 'no value in the log or the output')
  }

  // A symlink where aberto.env should be is refused.
  const e = secretsServer(t, { localEnv: plain })
  e.s.write('fix/aberto_link', '')
  const re = e.s.run(MAIN + 'cmd_apply')
  t.is(re.status, 1, 'an opened file that is a link is refused')
  t.absent(composeRan(re.calls), 'no compose')
})

test('update.sh: the key file must be a regular root file with mode 0600', (t) => {
  if (!hasBash(t)) return
  const plain = 'VARANDA_MAX_SOCKETS=10\n'
  const refused = (s, what) => {
    const r = s.run(MAIN + 'cmd_apply')
    t.is(r.status, 1, what + ' is refused')
    t.absent(s.exists('fix/open_calls'), 'secrets open never runs (' + what + ')')
    t.absent(composeRan(r.calls), 'no compose (' + what + ')')
    t.is(s.read('state/atual'), record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB), 'atual unchanged (' + what + ')')
    return r
  }
  const l = secretsServer(t, { localEnv: plain })
  l.s.write('fix/real-key.json', l.s.read('etc/secrets-key.json'))
  fs.rmSync(l.s.p('etc/secrets-key.json'))
  fs.symlinkSync(l.s.p('fix/real-key.json'), l.s.p('etc/secrets-key.json'))
  t.ok(refused(l.s, 'a symlink').log.includes('precisa ser um arquivo comum'), 'says it must be a regular file')
  for (const [dm, what] of [['1000 600\n', 'another owner'], ['0 640\n', 'mode 0640'], ['0 400\n', 'mode 0400']]) {
    const k = secretsServer(t, { localEnv: plain })
    k.s.write('fix/dm_secrets-key.json', dm)
    t.ok(refused(k.s, what).log.includes('precisa ser de root, modo 0600'), 'names the rule for ' + what)
  }
})

test('update.sh: the way back and rollback restore efetivo.env.anterior', (t) => {
  if (!hasBash(t)) return
  const plain = 'VARANDA_MAX_SOCKETS=10\n'
  const { s, v } = secretsServer(t, { localEnv: plain })
  const older = H('2', 40)
  s.write('state/anterior', record(older, 1, OLDER_SEEDER, OLDER_WEB))
  installRelease(s, older, { www: false })
  const cur = 'VARANDA_GIF_API_KEY=' + sentinel('atual') + '\n'
  const prev = 'VARANDA_GIF_API_KEY=' + sentinel('anterior') + '\n'
  s.write('state/segredos/efetivo.env', cur, 0o600)
  s.write('state/segredos/efetivo.env.anterior', prev, 0o600)
  s.write('fix/gate_fail_1', '')
  const r = s.run(MAIN + 'cmd_apply')
  t.is(r.status, 1, 'the failed apply exits 1')
  const e = s.p('state/segredos/efetivo.env')
  t.ok(r.calls.includes('compose pwd=' + s.p('releases', OLD_COMMIT) + ' seeder=' + OLD_SEEDER + ' web=' + OLD_WEB +
    ' compose -p varanda-seeder --env-file ' + e + ' -f compose.yaml -f compose.release.yaml up -d --no-build --force-recreate\n'),
  'the way back recreates the previous release with efetivo.env')
  t.is(s.read('state/segredos/efetivo.env'), cur, 'efetivo.env is the running release one again')
  t.is(modeOf(e), 0o600, 'and 0600')
  t.is(s.read('state/segredos/efetivo.env.anterior'), prev, 'efetivo.env.anterior follows the restored anterior')
  t.absent(s.exists('state/segredos/efetivo.env.anterior.velho'), 'no .velho left')
  t.is(s.read('state/anterior'), record(older, 1, OLDER_SEEDER, OLDER_WEB), 'anterior restored')
  t.alike(leaks(r, [...Object.values(v), cur.slice(20, -1), prev.slice(20, -1)]), [], 'no value in the log or the output')

  // A successful apply keeps the old efetivo.env as the anterior one.
  const ok = secretsServer(t, { localEnv: plain })
  ok.s.write('state/segredos/efetivo.env', cur, 0o600)
  t.is(ok.s.run(MAIN + 'cmd_apply').status, 0, 'apply passes')
  t.is(ok.s.read('state/segredos/efetivo.env.anterior'), cur, 'the previous efetivo.env became efetivo.env.anterior')

  // rollback restores it together with the release directory.
  const rb = server(t)
  rb.write('etc/varanda.env', plain)
  installRelease(rb, OLD_COMMIT, { www: false })
  rb.write('state/atual', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  rb.write('state/anterior', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  fs.mkdirSync(rb.p('state/segredos'))
  rb.write('state/segredos/efetivo.env', cur, 0o600)
  rb.write('state/segredos/efetivo.env.anterior', prev, 0o600)
  const back = rb.run(MAIN + 'cmd_rollback')
  t.is(back.status, 0, 'rollback passes: ' + back.log)
  t.ok(back.calls.includes('compose pwd=' + rb.p('releases', OLD_COMMIT) + ' seeder=' + OLD_SEEDER + ' web=' + OLD_WEB +
    ' compose -p varanda-seeder --env-file ' + rb.p('state/segredos/efetivo.env') + ' '), 'rollback runs compose with the restored efetivo.env')
  t.is(rb.read('state/segredos/efetivo.env'), prev, 'efetivo.env is the anterior one')
  t.absent(rb.exists('state/segredos/efetivo.env.anterior'), 'nothing is left as anterior')

  // A previous release without shared secrets: efetivo.env goes away.
  const nb = server(t)
  nb.write('etc/varanda.env', plain)
  installRelease(nb, OLD_COMMIT, { www: false })
  nb.write('state/atual', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  nb.write('state/anterior', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  fs.mkdirSync(nb.p('state/segredos'))
  nb.write('state/segredos/efetivo.env', cur, 0o600)
  const nback = nb.run(MAIN + 'cmd_rollback')
  t.is(nback.status, 0, 'rollback passes')
  t.absent(nb.exists('state/segredos/efetivo.env'), 'efetivo.env is removed')
  t.ok(nback.calls.includes('compose -p varanda-seeder --env-file ' + nb.p('etc/varanda.env') + ' '), 'compose reads varanda.env again')
})

test('update.sh: reconfigure rebuilds efetivo.env with the installed image, with the same abort rule', (t) => {
  if (!hasBash(t)) return
  const { s, v } = secretsServer(t, { localEnv: 'VARANDA_MAX_SOCKETS=10\n' })
  const dir = installRelease(s, COMMIT, { www: false })
  s.write('state/atual', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  const r = s.run(MAIN + 'cmd_reconfigure')
  t.is(r.status, 0, 'reconfigure passes: ' + r.log)
  t.ok(s.read('fix/open_calls').includes(' ' + SEEDER_REF + ' secrets open ') &&
    s.read('fix/open_calls').includes('source=' + path.join(dir, 'secrets.sealed.json') + ','), 'opens the installed bundle with the installed image')
  t.ok(s.read('state/segredos/efetivo.env').includes("VARANDA_GOOGLE_CLIENT_ID='" + v.id + "'"), 'efetivo.env rebuilt')
  t.ok(r.calls.includes('compose -p varanda-seeder --env-file ' + s.p('state/segredos/efetivo.env') + ' -f compose.yaml -f compose.release.yaml up -d --no-build\n'), 'compose up reads it')
  const before = s.read('state/segredos/efetivo.env')
  s.write('fix/open_rc', '1')
  fs.rmSync(s.p('calls'))
  const bad = s.run(MAIN + 'cmd_reconfigure')
  t.is(bad.status, 1, 'a failed open fails reconfigure')
  t.absent(composeRan(bad.calls), 'no compose up')
  t.is(s.read('state/segredos/efetivo.env'), before, 'efetivo.env unchanged')
  t.alike(leaks(r, Object.values(v)).concat(leaks(bad, Object.values(v))), [], 'no value in the log or the output')
})

test('update.sh: secrets-key creates the key once, verifies the image before install and prints only the public key', (t) => {
  if (!hasBash(t)) return
  const usage = (args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', input: '' }).status
  t.is(usage(['secrets-key', 'x']), 2, 'secrets-key takes no positional argument')
  t.is(usage(['secrets-key', '--image', 'ghcr.io/varanda-org/varanda-seeder:stable']), 2, 'secrets-key refuses a tag')
  t.ok(sh.includes('| secrets-key [--image'), 'the usage line names secrets-key')

  const keyed = () => {
    const s = server(t)
    const pub = H('9', 64)
    const sec = sentinel('secret')
    s.write('fix/pub', pub + '\n')
    s.write('fix/sec', sec)
    return { s, pub, sec }
  }
  // Before install: --image is required, verified, and only then run.
  const { s, pub, sec } = keyed()
  const none = s.run(MAIN + 'cmd_secrets_key')
  t.is(none.status, 2, 'without an installed release --image is required')
  t.absent(s.exists('fix/key_calls'), 'nothing ran')
  const r = s.run(MAIN + 'ref_chave=' + SEEDER_REF + '\ncmd_secrets_key')
  t.is(r.status, 0, 'secrets-key passes: ' + r.out)
  t.is(r.stdout, pub + '\n', 'stdout is exactly the public key')
  t.ok(s.read('fix/cosign_calls').includes('--certificate-identity ' + ID_STABLE + ' --certificate-oidc-issuer https://token.actions.githubusercontent.com ' + SEEDER_REF),
    'the image is verified with the channel identity')
  t.absent(r.calls.includes('docker pull ghcr.io/varanda-org/varanda-seeder:'), 'no tag is pulled')
  const call = s.read('fix/key_calls')
  t.ok(call.includes('run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 '), 'no network, read-only, no capabilities')
  t.ok(call.includes(' ' + SEEDER_REF + ' secrets key --out /saida/secrets-key.json'), 'the verified image runs by digest')
  t.ok(r.calls.indexOf('verify') < r.calls.indexOf('secrets key'), 'verified before it runs')
  t.ok(s.read('etc/secrets-key.json').includes(sec), 'the key file holds the secret key')
  t.absent(s.exists('etc/.secrets-key.tmp'), 'the temporary directory is gone')
  t.alike(leaks(r, [sec]), [], 'the secret key is never in the log or the output')
  t.absent(r.log.includes(pub), 'the log does not repeat the key')

  // An existing file or symlink is never replaced.
  const again = s.run(MAIN + 'ref_chave=' + SEEDER_REF + '\ncmd_secrets_key')
  t.is(again.status, 1, 'an existing key file is refused')
  t.is(s.read('fix/key_calls'), call, 'secrets key did not run again')
  t.ok(s.read('etc/secrets-key.json').includes(sec), 'the key file is unchanged')
  const ln = keyed()
  fs.symlinkSync(ln.s.p('nada'), ln.s.p('etc/secrets-key.json'))
  t.is(ln.s.run(MAIN + 'ref_chave=' + SEEDER_REF + '\ncmd_secrets_key').status, 1, 'a dangling symlink is refused too')
  t.absent(ln.s.exists('fix/key_calls'), 'nothing ran')

  // A failed verification runs nothing of the image.
  const bad = keyed()
  bad.s.write('fix/cosign_fail', '')
  const rb = bad.s.run(MAIN + 'ref_chave=' + SEEDER_REF + '\ncmd_secrets_key')
  t.is(rb.status, 1, 'a failed verification fails')
  t.absent(bad.s.exists('fix/key_calls'), 'secrets key never ran')
  t.absent(bad.s.exists('etc/secrets-key.json'), 'no key file')
  t.is(rb.stdout, '', 'nothing on stdout')

  // With an installed release: its image, without --image or a new check.
  const inst = keyed()
  inst.s.write('state/atual', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  t.is(inst.s.run(MAIN + 'ref_chave=' + SEEDER_REF + '\ncmd_secrets_key').status, 2, '--image is refused once a release is installed')
  const ri = inst.s.run(MAIN + 'cmd_secrets_key')
  t.is(ri.status, 0, 'secrets-key uses the installed image: ' + ri.out)
  t.ok(inst.s.read('fix/key_calls').includes(' ' + SEEDER_REF + ' secrets key '), 'the installed image by digest')
  t.absent(inst.s.exists('fix/cosign_calls'), 'no new signature check')
  t.is(ri.stdout, inst.pub + '\n', 'stdout is the public key')
  t.alike(leaks(ri, [inst.sec]), [], 'no secret key in the log or the output')
})

// A running efetivo.env with a sentinel value, and the checks that a refused
// secrets step changed nothing at all.
const PLAIN = 'VARANDA_MAX_SOCKETS=10\n'
function keepEfetivo (s) {
  const val = sentinel('velho')
  const text = PLAIN + MARK + "\nVARANDA_GIF_API_KEY='" + val + "'\n"
  s.write('state/segredos/efetivo.env', text, 0o600)
  return { val, text }
}
function nothingChanged (t, s, r, text, what) {
  t.is(r.status, 1, what + ' fails the apply')
  t.absent(/ up -d/.test(r.calls), 'no compose up (' + what + ')')
  t.is(s.read('state/atual'), record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB), 'atual unchanged (' + what + ')')
  t.is(s.read('state/segredos/efetivo.env'), text, 'efetivo.env unchanged (' + what + ')')
  t.absent(s.exists('state/segredos/efetivo.env.novo'), 'no candidate left (' + what + ')')
  t.absent(s.exists('state/segredos/abrir'), 'no opened file left (' + what + ')')
}

test('update.sh: install on a new server keeps the opened secrets for compose until the first apply', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  const v = { id: sentinel('id'), secret: sentinel('sec'), key: sentinel('key') }
  s.write('etc/update.conf', 'VARANDA_UPDATE=manual\nVARANDA_PROFILE=full\n')
  s.write('etc/varanda.env', 'VARANDA_DOMAIN=app.exemplo.org\nVARANDA_ASSOCIATION=' + H('a', 64) + '\n')
  s.write('fix/bundle/secrets.sealed.json', '{"v":1}\n')
  s.write('fix/bundle/secrets-signers.txt', H('5', 64) + '\n')
  s.write('etc/secrets-key.json', '{"v":1,"publicKey":"' + H('f', 64) + '","secretKey":"' + v.key + '"}\n')
  s.write('fix/aberto.env', "VARANDA_GOOGLE_CLIENT_ID='" + v.id + "'\nVARANDA_GOOGLE_CLIENT_SECRET='" + v.secret + "'\n")
  s.write('fix/up_needs_google', '')
  const r = s.run(MAIN + 'ref_install=' + SEEDER_REF + '\ncmd_install')
  t.is(r.status, 0, 'install with the Google client only in the sealed file passes: ' + r.log)
  t.absent(s.exists('state/atual'), 'nothing installed yet')
  t.ok(s.read('state/segredos/efetivo.env').includes("VARANDA_GOOGLE_CLIENT_SECRET='" + v.secret + "'"), 'the candidate became efetivo.env')
  t.is(modeOf(s.p('state/segredos/efetivo.env')), 0o600, 'and it is 0600')
  t.absent(s.exists('state/segredos/efetivo.env.novo'), 'no candidate left')
  t.absent(s.exists('state/segredos/abrir'), 'no opened file left')
  t.ok(r.log.includes('update.sh secrets-key'), 'the final message points to secrets-key')
  const c = s.run(MAIN + 'cmd_compose ps')
  t.ok(c.calls.includes('compose -p varanda-seeder --env-file ' + s.p('state/segredos/efetivo.env') + ' '),
    'update.sh compose before the first apply reads efetivo.env')
  t.alike(leaks(r, Object.values(v)).concat(leaks(c, Object.values(v))), [], 'no value or key in the log or the output')
})

test('update.sh: apply is refused before the switch when the way back would not start with its env', (t) => {
  if (!hasBash(t)) return
  const localEnv = 'VARANDA_DOMAIN=app.exemplo.org\nVARANDA_ASSOCIATION=' + H('a', 64) + '\n'
  // The installed release runs without efetivo.env, and varanda.env has no
  // Google client: real Compose would refuse the way back.
  const { s, v } = secretsServer(t, { profile: 'full', localEnv })
  s.write('fix/up_needs_google', '')
  s.write('fix/gate_fail_1', '')
  const r = s.run(MAIN + 'cmd_apply')
  t.is(r.status, 1, 'the apply is refused')
  t.ok(r.log.includes('a volta automática para a versão instalada não subiria com ' + s.p('etc/varanda.env') + '; nada mudou'),
    'says the way back would not start with varanda.env')
  t.ok(r.log.includes('update.sh reconfigure'), 'and what to do')
  t.absent(/ up -d/.test(r.calls), 'no compose up at all')
  t.absent(r.calls.includes('docker image tag'), 'no image tagged')
  t.is(s.read('state/atual'), record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB), 'atual unchanged')
  t.absent(s.exists('state/anterior'), 'no anterior written')
  t.absent(s.exists('state/intervencao'), 'no intervention')
  t.absent(s.exists('state/recusadas'), 'the digest is not refused')
  t.absent(s.exists('state/segredos/efetivo.env'), 'no efetivo.env')
  t.absent(s.exists('state/segredos/efetivo.env.novo'), 'no candidate left')
  t.alike(leaks(r, Object.values(v)), [], 'no value in the log or the output')

  // With an efetivo.env that carries the client, the way back can start: a
  // failed gate goes back with it.
  const ok = secretsServer(t, { profile: 'full', localEnv })
  const running = localEnv + MARK + "\nVARANDA_GOOGLE_CLIENT_ID='" + sentinel('rid') + "'\nVARANDA_GOOGLE_CLIENT_SECRET='" + sentinel('rsec') + "'\n"
  ok.s.write('state/segredos/efetivo.env', running, 0o600)
  ok.s.write('fix/up_needs_google', '')
  ok.s.write('fix/gate_fail_1', '')
  const back = ok.s.run(MAIN + 'cmd_apply')
  t.is(back.status, 1, 'the failed gate exits 1')
  t.ok(back.log.includes('voltou para a versão anterior'), 'the way back worked: ' + back.log)
  t.absent(back.calls.includes('compose up refused'), 'no compose up was refused')
  t.is(ok.s.read('state/segredos/efetivo.env'), running, 'efetivo.env is the running one again')
})

test('update.sh: a sealed name spelled with export or a colon in varanda.env is refused', (t) => {
  if (!hasBash(t)) return
  for (const line of ['export VARANDA_GIF_API_KEY=local', 'VARANDA_GIF_API_KEY: local', '  export\tVARANDA_GOOGLE_CLIENT_ID', 'VARANDA_GOOGLE_CLIENT_SECRET :local']) {
    const { s, v } = secretsServer(t, { localEnv: PLAIN + line + '\n' })
    const { val, text } = keepEfetivo(s)
    const r = s.run(MAIN + 'cmd_apply')
    nothingChanged(t, s, r, text, JSON.stringify(line))
    t.ok(r.log.includes(' em ' + s.p('etc/varanda.env') + " usa export ou ':'; escreva NOME=valor; nada mudou"), 'asks for NOME=valor: ' + line)
    t.alike(leaks(r, [...Object.values(v), val]), [], 'no value in the log or the output')
  }
  const { s } = secretsServer(t, { localEnv: 'export VARANDA_MAX_SOCKETS=10\n' })
  t.is(s.run(MAIN + 'cmd_apply').status, 0, 'export of a name that is never shared is left alone')
})

test('update.sh: an opened file fora do formato, with another name, a repeated name or other bytes changes nothing', (t) => {
  if (!hasBash(t)) return
  const cases = [
    ...['VARANDA_PHONE_KEY', 'VARANDA_PUSH_TOKEN', 'COMPOSE_REMOVE_ORPHANS', 'DOCKER_HOST', 'VARANDA_DOMAIN']
      .map((n) => [(x) => n + "='" + x + "'\n", 'traz ' + n + ', que não é um nome compartilhado']),
    [(x) => "VARANDA_GIF_API_KEY='" + x + "'\nVARANDA_GIF_API_KEY='" + x + "'\n", 'repete VARANDA_GIF_API_KEY'],
    [(x) => "VARANDA_GIF_API_KEY='a\t" + x + "'\n", 'bytes fora do ASCII imprimível'],
    [(x) => "VARANDA_GIF_API_KEY='a\x01" + x + "'\n", 'bytes fora do ASCII imprimível'],
    [(x) => "VARANDA_GIF_API_KEY='" + x + "'\r\n", 'bytes fora do ASCII imprimível'],
    [(x) => "VARANDA_GIF_API_KEY='é" + x + "'\n", 'bytes fora do ASCII imprimível'],
    [(x) => 'VARANDA_GIF_API_KEY=' + x + '\n', 'fora do formato NOME=valor'],
    [(x) => "varanda_gif_api_key='" + x + "'\n", 'fora do formato NOME=valor'],
    [(x) => "VARANDA_GIF_API_KEY='a'" + x + "'\n", 'fora do formato NOME=valor'],
    [(x) => "VARANDA_GIF_API_KEY='a\\" + x + "'\n", 'fora do formato NOME=valor']
  ]
  for (const [content, says] of cases) {
    const { s, v } = secretsServer(t, { localEnv: PLAIN })
    const x = sentinel('opened')
    s.write('fix/aberto.env', content(x))
    const { val, text } = keepEfetivo(s)
    const r = s.run(MAIN + 'cmd_apply')
    nothingChanged(t, s, r, text, says)
    t.ok(r.log.includes('segredos compartilhados: ') && r.log.includes(says), 'says ' + says)
    t.ok(r.log.includes('não foi possível montar o ambiente com os segredos compartilhados; nada mudou'), 'and that nothing changed')
    t.alike(fs.readdirSync(s.p('releases')), [OLD_COMMIT], 'no new release directory (' + says + ')')
    t.alike(leaks(r, [...Object.values(v), val, x]), [], 'no value in the log or the output (' + says + ')')
  }
})

test('update.sh: opened plaintext never outlives the run that created it, and other commands never delete it', (t) => {
  if (!hasBash(t)) return
  const { s, v } = secretsServer(t, { localEnv: PLAIN })
  // The prepare succeeds, then tagging fails: an early exit 1 in aplicar.
  s.write('fix/tag_fail', '')
  const r = s.run(MAIN + 'cmd_apply')
  t.is(r.status, 1, 'the apply exits early')
  t.ok(r.log.includes('segredos compartilhados: 3 variáveis aplicadas'), 'after a successful prepare')
  t.ok(r.log.includes('não foi possível etiquetar as imagens'), 'at the tagging step')
  t.absent(s.exists('state/segredos/efetivo.env.novo'), 'the candidate is gone')
  t.absent(s.exists('state/segredos/abrir'), 'the work directory is gone')
  t.alike(leaks(r, Object.values(v)), [], 'no value in the log or the output')

  // SIGTERM at the same point, before the INT/TERM trap of the switch.
  const k = secretsServer(t, { localEnv: PLAIN })
  k.s.write('fix/term_at_tag', '')
  const rk = k.s.run(MAIN + 'cmd_apply')
  t.not(rk.status, 0, 'the terminated apply does not exit 0')
  t.ok(rk.log.includes('segredos compartilhados: 3 variáveis aplicadas'), 'it was terminated after a successful prepare')
  t.absent(k.s.exists('state/segredos/efetivo.env.novo'), 'SIGTERM leaves no candidate')
  t.absent(k.s.exists('state/segredos/abrir'), 'and no work directory')
  t.is(k.s.read('state/atual'), record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB), 'atual unchanged')

  // status and check never touch a candidate a locked run is writing.
  s.write('state/segredos/efetivo.env.novo', 'X=1\n', 0o600)
  fs.mkdirSync(s.p('state/segredos/abrir'))
  s.write('state/segredos/abrir/aberto.env', 'X=1\n')
  t.is(s.run(MAIN + 'cmd_status').status, 0, 'status passes')
  t.is(s.run(MAIN + 'cmd_check').status, 0, 'check passes')
  t.ok(s.exists('state/segredos/efetivo.env.novo'), 'status and check leave the candidate')
  t.ok(s.exists('state/segredos/abrir/aberto.env'), 'and the work directory')
})

test('update.sh: the timer never drops shared names on its own; apply and reconfigure go on and say so', (t) => {
  if (!hasBash(t)) return
  const pair = () => ({ api: sentinel('didit'), wf: sentinel('wf') })
  const withPair = (s, p) => {
    const text = PLAIN + MARK + "\nVARANDA_DIDIT_API_KEY='" + p.api + "'\nVARANDA_DIDIT_WORKFLOW_ID='" + p.wf + "'\n"
    s.write('state/segredos/efetivo.env', text, 0o600)
    return text
  }
  const names = 'VARANDA_DIDIT_API_KEY VARANDA_DIDIT_WORKFLOW_ID'

  // Not a recipient any more: the timer refuses, with the names only.
  const { s, v } = secretsServer(t, { localEnv: PLAIN })
  s.write('etc/update.conf', 'VARANDA_UPDATE=auto\n')
  const p = pair()
  const text = withPair(s, p)
  s.write('fix/open_rc', '3')
  const r = s.run(MAIN + 'cmd_run')
  t.is(r.status, 1, 'run exits 1')
  t.ok(r.log.includes('segredos compartilhados: a nova versão deixaria sem valor ' + names + '; nada mudou. Para subir sem eles, rode update.sh apply'),
    'names the lost names and the way to accept it: ' + r.log)
  t.absent(/ up -d/.test(r.calls), 'no compose up')
  t.is(s.read('state/atual'), record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB), 'atual unchanged')
  t.is(s.read('state/segredos/efetivo.env'), text, 'efetivo.env unchanged')
  t.absent(s.exists('state/segredos/efetivo.env.novo'), 'no candidate left')
  t.absent(s.exists('state/recusadas'), 'the digest is not refused')
  t.absent(s.exists('state/intervencao'), 'no intervention')
  t.alike(leaks(r, [...Object.values(v), p.api, p.wf]), [], 'no value in the log or the output')

  // An explicit apply goes on and logs the loss.
  const a = s.run(MAIN + 'cmd_apply')
  t.is(a.status, 0, 'explicit apply passes: ' + a.log)
  t.ok(a.log.includes('segredos compartilhados: seguindo sem ' + names + ', que a versão em uso tinha'), 'logs the names it goes on without')
  t.absent(s.exists('state/segredos/efetivo.env'), 'efetivo.env is gone')
  t.alike(leaks(a, [...Object.values(v), p.api, p.wf]), [], 'no value in the log or the output')

  // A candidate that keeps the names, or varanda.env setting them, passes.
  const k = secretsServer(t, { localEnv: PLAIN })
  k.s.write('etc/update.conf', 'VARANDA_UPDATE=auto\n')
  const kp = pair()
  withPair(k.s, kp)
  k.s.write('fix/aberto.env', "VARANDA_DIDIT_API_KEY='" + kp.api + "'\nVARANDA_DIDIT_WORKFLOW_ID='" + kp.wf + "'\n")
  const kr = k.s.run(MAIN + 'cmd_run')
  t.is(kr.status, 0, 'run passes when the candidate keeps the names: ' + kr.log)
  t.ok(k.s.read('state/segredos/efetivo.env').includes("VARANDA_DIDIT_API_KEY='" + kp.api + "'"), 'the names are still there')
  const l = secretsServer(t, { localEnv: PLAIN + 'VARANDA_DIDIT_API_KEY=local\nVARANDA_DIDIT_WORKFLOW_ID=local\n' })
  l.s.write('etc/update.conf', 'VARANDA_UPDATE=auto\n')
  withPair(l.s, pair())
  l.s.write('fix/open_rc', '3')
  t.is(l.s.run(MAIN + 'cmd_run').status, 0, 'run passes when varanda.env sets the names')

  // reconfigure goes on and logs it too.
  const c = secretsServer(t, { localEnv: PLAIN })
  installRelease(c.s, COMMIT, { www: false })
  c.s.write('state/atual', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  withPair(c.s, pair())
  c.s.write('fix/open_rc', '3')
  const cr = c.s.run(MAIN + 'cmd_reconfigure')
  t.is(cr.status, 0, 'reconfigure passes: ' + cr.log)
  t.ok(cr.log.includes('seguindo sem ' + names), 'and logs the names')
})

test('update.sh: a sealed file needs the signers list of the same bundle', (t) => {
  if (!hasBash(t)) return
  const { s, v } = secretsServer(t, { localEnv: PLAIN })
  fs.rmSync(s.p('fix/bundle/secrets-signers.txt'))
  const { val, text } = keepEfetivo(s)
  const r = s.run(MAIN + 'cmd_apply')
  nothingChanged(t, s, r, text, 'no secrets-signers.txt')
  t.ok(r.log.includes('segredos compartilhados: o pacote traz secrets.sealed.json sem secrets-signers.txt; nada mudou'), 'says the signers list is missing')
  t.absent(s.exists('fix/open_calls'), 'secrets open never runs')
  t.alike(leaks(r, [...Object.values(v), val]), [], 'no value in the log or the output')

  const l = secretsServer(t, { localEnv: PLAIN })
  fs.rmSync(l.s.p('fix/bundle/secrets-signers.txt'))
  fs.mkdirSync(l.s.p('fix/bundle/secrets-signers.txt'))
  const rl = l.s.run(MAIN + 'cmd_apply')
  t.is(rl.status, 1, 'a signers path that is not a regular file is refused')
  t.absent(l.s.exists('fix/open_calls'), 'secrets open never runs')

  // Without a sealed file the signers list is optional.
  const n = secretsServer(t, { localEnv: PLAIN })
  fs.rmSync(n.s.p('fix/bundle/secrets-signers.txt'))
  fs.rmSync(n.s.p('fix/bundle/secrets.sealed.json'))
  t.is(n.s.run(MAIN + 'cmd_apply').status, 0, 'a bundle with neither file applies')

  // A bad signature (exit 1 of secrets open) aborts like any other failure.
  const b = secretsServer(t, { localEnv: PLAIN })
  const kept = keepEfetivo(b.s)
  b.s.write('fix/open_rc', '1')
  nothingChanged(t, b.s, b.s.run(MAIN + 'cmd_apply'), kept.text, 'exit 1 of secrets open')
})

test('update.sh: rollback pre-flights efetivo.env.anterior, not the running env', (t) => {
  if (!hasBash(t)) return
  const rb = server(t)
  rb.write('etc/varanda.env', PLAIN)
  installRelease(rb, OLD_COMMIT, { www: false })
  rb.write('state/atual', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  rb.write('state/anterior', record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB))
  fs.mkdirSync(rb.p('state/segredos'))
  rb.write('state/segredos/efetivo.env', PLAIN, 0o600)
  rb.write('state/segredos/efetivo.env.anterior', 'VARANDA_MAX_SOCKETS=abc\n', 0o600)
  const r = rb.run(MAIN + 'cmd_rollback')
  t.is(r.status, 1, 'a bad efetivo.env.anterior refuses the rollback')
  t.ok(r.log.includes('VARANDA_MAX_SOCKETS inválido em ' + rb.p('state/segredos/efetivo.env.anterior')), 'the pre-flight read efetivo.env.anterior')
  t.absent(composeRan(r.calls), 'no compose')
  t.is(rb.read('state/atual'), record(COMMIT, 5, SEEDER_REF, WEB_REF), 'atual unchanged')
})

test('update.sh: secrets-key accepts a pretty-printed key file and refuses two public keys', (t) => {
  if (!hasBash(t)) return
  const keyed = () => {
    const s = server(t)
    const pub = H('9', 64)
    const sec = sentinel('secret')
    s.write('fix/pub', pub + '\n')
    s.write('fix/sec', sec)
    return { s, pub, sec }
  }
  const p = keyed()
  p.s.write('fix/key_pretty', '')
  const r = p.s.run(MAIN + 'ref_chave=' + SEEDER_REF + '\ncmd_secrets_key')
  t.is(r.status, 0, 'a pretty-printed key file passes: ' + r.out)
  t.is(r.stdout, p.pub + '\n', 'stdout is exactly the public key')
  t.alike(leaks(r, [p.sec]), [], 'no secret key in the log or the output')

  const two = keyed()
  two.s.write('fix/key_two', H('8', 64))
  const rt = two.s.run(MAIN + 'ref_chave=' + SEEDER_REF + '\ncmd_secrets_key')
  t.is(rt.status, 1, 'a key file with two public keys is refused')
  t.absent(two.s.exists('etc/secrets-key.json'), 'no key file')
  t.is(rt.stdout, '', 'nothing on stdout')
})

// The seq of the sealed file (secrets verify --json) and the floor in
// state/segredos/seq.
const SEQ_FILE = 'state/segredos/seq'
// The floor is exactly "<seq> <sha256 of the applied sealed file>\n".
const SEALED = '{"v":1}\n'
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const floorOf = (seq, hash = sha256(SEALED)) => seq + ' ' + hash + '\n'
const seqServer = (t, { mode = 'manual', seq = null, floor = null } = {}) => {
  const x = secretsServer(t, { localEnv: PLAIN })
  x.s.write('etc/update.conf', 'VARANDA_UPDATE=' + mode + '\n')
  if (seq !== null) x.s.write('fix/seq', String(seq))
  if (floor !== null) x.s.write(SEQ_FILE, floor, 0o600)
  return x
}
// The refused-on-the-timer checks: like a name drop, nothing at all changed.
function seqRefused (t, s, r, text, floor, what) {
  nothingChanged(t, s, r, text, what)
  t.is(s.read(SEQ_FILE), floor, 'the floor is unchanged (' + what + ')')
  t.absent(s.exists('state/recusadas'), 'the digest is not refused (' + what + ')')
  t.absent(s.exists('state/intervencao'), 'no intervention (' + what + ')')
}

test('update.sh: secrets verify runs locked down without the key, and its seq becomes the floor after a healthy switch', (t) => {
  if (!hasBash(t)) return
  const { s, v } = seqServer(t, { seq: 7 })
  const r = s.run(MAIN + 'cmd_apply')
  t.is(r.status, 0, 'apply without a floor accepts any seq: ' + r.log)
  t.absent(s.exists('fix/verify_bad'), 'secrets verify got exactly the locked-down flags, two read-only mounts and no key: ' + s.read('fix/verify_bad'))
  const calls = s.read('fix/verify_calls').split('\n').filter(Boolean)
  t.is(calls.length, 1, 'secrets verify runs once')
  const tmp = s.p('releases', COMMIT + '.tmp')
  t.is(calls[0], 'run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0' +
    ' --mount type=bind,source=' + path.join(tmp, 'secrets.sealed.json') + ',target=/segredos/selado.json,readonly' +
    ' --mount type=bind,source=' + path.join(tmp, 'secrets-signers.txt') + ',target=/segredos/assinantes.txt,readonly' +
    ' ' + SEEDER_REF + ' secrets verify --file /segredos/selado.json --signers /segredos/assinantes.txt --json',
  'the verified image by digest, the sealed file and signers of the same bundle, nothing else')
  t.ok(r.calls.indexOf(' secrets verify ') < r.calls.indexOf(' secrets open '), 'verified before it is opened')
  t.ok(/--signers \/segredos\/assinantes\.txt --json \\\n\s*>"\$segredos\/conferir\.out" 2>"\$segredos\/conferir\.err" \|\| rc=\$\?\n\s*saida=\$\(head -c 4096 "\$segredos\/conferir\.out" 2>\/dev\/null\) \|\| saida=''\n/.test(shCode),
    'stdout goes to a file, outside $(...), and is read up to 4 KB')
  t.absent(s.exists('state/segredos/conferir.err'), 'the stderr file of secrets verify is gone')
  t.absent(s.exists('state/segredos/conferir.out'), 'the stdout file of secrets verify is gone')
  t.absent(s.exists('state/segredos/abrir.err'), 'the stderr file of secrets open is gone')
  t.is(s.read(SEQ_FILE), floorOf(7), 'the floor is the applied seq')
  t.is(modeOf(s.p(SEQ_FILE)), 0o600, 'the floor is 0600')
  t.absent(s.exists(SEQ_FILE + '.tmp'), 'no temporary file left')
  t.ok(r.log.includes('segredos compartilhados: seq 7 (sha256 ' + sha256(SEALED) + ') anotado em ' + s.p(SEQ_FILE)), 'logs the new floor')
  t.ok(shCode.includes('if ! saida=$(sha256sum <"$selado") || ! [[ $' + '{saida%% *} =~ $hash_re ]]; then'), 'the hash is the sha256 of the sealed file verify and open read')
  t.absent((r.out + r.log).includes('VERIFY-STDERR-CANARY'), 'the stderr of secrets verify never reaches the log')
  t.alike(leaks(r, Object.values(v)), [], 'no value or key in the log or the output')
  // The way back after a failed gate, and the gate itself, run before the
  // floor moves: a failed apply of seq 9 leaves 7.
  const g = seqServer(t, { seq: 9, floor: floorOf(7) })
  g.s.write('fix/gate_fail_1', '')
  const rg = g.s.run(MAIN + 'cmd_apply')
  t.is(rg.status, 1, 'the failed gate fails the apply')
  t.ok(rg.log.includes('voltando'), 'the way back ran')
  t.is(g.s.read(SEQ_FILE), floorOf(7), 'a failed switch and the way back leave the floor')
})

test('update.sh: the timer refuses a lower seq and changes nothing; equal and higher pass and the floor follows', (t) => {
  if (!hasBash(t)) return
  const { s, v } = seqServer(t, { mode: 'auto', seq: 4, floor: floorOf(5) })
  const { val, text } = keepEfetivo(s)
  const r = s.run(MAIN + 'cmd_run')
  seqRefused(t, s, r, text, floorOf(5), 'a lower seq on the timer')
  t.ok(r.log.includes('segredos compartilhados: o arquivo selado da nova versão tem seq 4, menor que o último aplicado 5; nada mudou. Para aplicar mesmo assim, rode update.sh apply'),
    'names both seqs and the way to accept it: ' + r.log)
  t.alike(leaks(r, [...Object.values(v), val]), [], 'no value in the log or the output')

  const e = seqServer(t, { mode: 'auto', seq: 5, floor: floorOf(5) })
  const re = e.s.run(MAIN + 'cmd_run')
  t.is(re.status, 0, 'an equal seq passes (every release ships the same file): ' + re.log)
  t.is(e.s.read(SEQ_FILE), floorOf(5), 'the floor stays')
  t.is(e.s.read('state/atual'), record(COMMIT, 5, SEEDER_REF, WEB_REF), 'the release is applied')

  const h = seqServer(t, { mode: 'auto', seq: 9, floor: floorOf(5, H('a', 64)) })
  const rh = h.s.run(MAIN + 'cmd_run')
  t.is(rh.status, 0, 'a higher seq passes whatever the hash of the floor: ' + rh.log)
  t.is(h.s.read(SEQ_FILE), floorOf(9), 'the floor follows the applied seq')

  // The largest seq the format allows.
  const m = seqServer(t, { mode: 'auto', seq: 4294967295, floor: floorOf(4294967294) })
  t.is(m.s.run(MAIN + 'cmd_run').status, 0, 'seq 4294967295 passes')
  t.is(m.s.read(SEQ_FILE), floorOf(4294967295), 'and becomes the floor')
})

test('update.sh: an equal seq with other content is refused on the timer and taken by apply, which records the new hash', (t) => {
  if (!hasBash(t)) return
  const msg = 'segredos compartilhados: o arquivo selado da nova versão tem o mesmo seq 5 do último aplicado, com conteúdo diferente; nada mudou. Sele de novo com seq maior, ou rode update.sh apply'
  // The release ships another sealed file under the seq already applied.
  const other = '{"v":1,"outro":true}\n'
  const { s, v } = seqServer(t, { mode: 'auto', seq: 5, floor: floorOf(5) })
  s.write('fix/bundle/secrets.sealed.json', other)
  const { val, text } = keepEfetivo(s)
  const r = s.run(MAIN + 'cmd_run')
  seqRefused(t, s, r, text, floorOf(5), 'an equal seq with other content on the timer')
  t.ok(r.log.includes(msg), 'names the seq and the two ways out: ' + r.log)
  t.alike(leaks(r, [...Object.values(v), val]), [], 'no value in the log or the output')
  const a = s.run(MAIN + 'cmd_apply')
  t.is(a.status, 0, 'apply takes it: ' + a.log)
  t.ok(a.log.includes('segredos compartilhados: aplicando o arquivo selado com o mesmo seq 5 do último aplicado, com conteúdo diferente'), 'and says so')
  t.is(s.read(SEQ_FILE), floorOf(5, sha256(other)), 'the floor holds the hash of the file now in use')
  // Same seq, a floor whose hash is not this file: refused the same way.
  const d = seqServer(t, { mode: 'auto', seq: 5, floor: floorOf(5, H('a', 64)) })
  const kd = keepEfetivo(d.s)
  const rd = d.s.run(MAIN + 'cmd_run')
  seqRefused(t, d.s, rd, kd.text, floorOf(5, H('a', 64)), 'an equal seq with another floor hash')
  t.ok(rd.log.includes(msg), 'with the same message')
})

test('update.sh: a sha256 that fails or is not 64 lower hex changes nothing', (t) => {
  if (!hasBash(t)) return
  const cases = [
    ['sha256sum fails', 'sha256sum() { return 1; }\n'],
    ['an empty hash', "sha256sum() { printf '  -\\n'; }\n"],
    ['an uppercase hash', "sha256sum() { printf '%s  -\\n' " + H('A', 64) + '; }\n'],
    ['a short hash', "sha256sum() { printf '%s  -\\n' " + H('a', 63) + '; }\n']
  ]
  for (const [what, stub] of cases) {
    for (const cmd of ['cmd_run', 'cmd_apply']) {
      const { s } = seqServer(t, { mode: 'auto', seq: 9, floor: floorOf(5) })
      const { text } = keepEfetivo(s)
      const r = s.run(stub + MAIN + cmd)
      const label = what + ', ' + cmd
      nothingChanged(t, s, r, text, label)
      t.ok(r.log.includes('não foi possível calcular o sha256 do arquivo selado; nada mudou'), 'says so (' + label + '): ' + r.log)
      t.absent(s.exists('fix/open_calls'), 'secrets open never runs (' + label + ')')
      t.is(s.read(SEQ_FILE), floorOf(5), 'the floor is unchanged (' + label + ')')
    }
  }
})

test('update.sh: apply and reconfigure take a lower seq, say so and lower the floor; rollback raises it back', (t) => {
  if (!hasBash(t)) return
  const { s } = seqServer(t, { seq: 3, floor: floorOf(5) })
  const r = s.run(MAIN + 'cmd_apply')
  t.is(r.status, 0, 'an explicit apply goes on with a lower seq: ' + r.log)
  t.ok(r.log.includes('segredos compartilhados: aplicando o arquivo selado com seq 3, menor que o último aplicado 5'), 'logs both seqs')
  t.is(s.read(SEQ_FILE), floorOf(3), 'the floor is the applied seq, even if lower')

  // rollback goes back to the previous release and its floor (never lower).
  const rb = s.run(MAIN + 'cmd_rollback')
  t.is(rb.status, 0, 'rollback passes: ' + rb.log)
  t.is(s.read('state/atual'), record(OLD_COMMIT, 1, OLD_SEEDER, OLD_WEB), 'the previous release is back')
  t.is(s.read(SEQ_FILE), floorOf(5), 'rollback puts back the floor of the env it restores')

  // reconfigure reopens the installed bundle with the same rule.
  const c = seqServer(t, { seq: 4, floor: floorOf(9) })
  installRelease(c.s, COMMIT, { www: false })
  c.s.write('state/atual', record(COMMIT, 5, SEEDER_REF, WEB_REF))
  const rc = c.s.run(MAIN + 'cmd_reconfigure')
  t.is(rc.status, 0, 'reconfigure goes on with a lower seq: ' + rc.log)
  t.ok(rc.log.includes('aplicando o arquivo selado com seq 4, menor que o último aplicado 9'), 'and says so')
  t.is(c.s.read(SEQ_FILE), floorOf(4), 'the floor follows after the healthy reconfigure')
  // A reconfigure whose gate fails leaves the floor.
  c.s.write(SEQ_FILE, floorOf(9), 0o600)
  c.s.write('fix/gate_fail_' + (Number(c.s.read('fix/gate_n')) + 1), '')
  const bad = c.s.run(MAIN + 'cmd_reconfigure')
  t.is(bad.status, 1, 'the failed gate fails reconfigure')
  t.is(c.s.read(SEQ_FILE), floorOf(9), 'the floor is unchanged')
})

test('update.sh: a secrets verify that fails or prints anything but the one expected line changes nothing', (t) => {
  if (!hasBash(t)) return
  const canary = sentinel('saida')
  const line = (seq) => '{"signer":"' + H('5', 64) + '","recipients":2,"seq":' + seq + '}\n'
  const cases = [
    ['exit 1 with a valid line', { rc: '1' }, 1],
    ['exit 3 with a valid line', { rc: '3' }, 3],
    ['empty output', { out: '' }, 0],
    ['a signer that is not 64 hex', { out: '{"signer":"' + canary + '","recipients":2,"seq":5}\n' }, 0],
    ['an extra key', { out: '{"signer":"' + H('5', 64) + '","recipients":2,"seq":5,"x":"' + canary + '"}\n' }, 0],
    ['seq 0', { out: line(0) }, 0],
    ['seq with a leading zero', { out: line('05') }, 0],
    ['seq above 4294967295', { out: line(4294967296) }, 0],
    ['seq as a string', { out: '{"signer":"' + H('5', 64) + '","recipients":2,"seq":"5"}\n' }, 0],
    ['no recipients', { out: '{"signer":"' + H('5', 64) + '","recipients":0,"seq":5}\n' }, 0],
    ['a second line', { out: line(5) + canary + '\n' }, 0],
    ['a line before', { out: canary + '\n' + line(5) }, 0],
    ['a leading space', { out: ' ' + line(5) }, 0],
    ['a valid line past 4 KB', { out: ' '.repeat(5000) + line(5) }, 0]
  ]
  for (const [what, { rc, out }, code] of cases) {
    const { s, v } = seqServer(t, { floor: floorOf(5) })
    const { val, text } = keepEfetivo(s)
    if (rc) s.write('fix/verify_rc', rc)
    if (out !== undefined) s.write('fix/verify_out', out)
    const r = s.run(MAIN + 'cmd_apply')
    nothingChanged(t, s, r, text, what)
    t.ok(r.log.includes('não foi possível conferir o arquivo selado (saída ' + code + '); nada mudou'), 'only the exit code is logged (' + what + '): ' + r.log)
    t.absent(s.exists('fix/open_calls'), 'secrets open never runs (' + what + ')')
    t.is(s.read(SEQ_FILE), floorOf(5), 'the floor is unchanged (' + what + ')')
    t.absent((r.out + r.log).includes(canary), 'the output of secrets verify is never logged (' + what + ')')
    t.alike(leaks(r, [...Object.values(v), val]), [], 'no value in the log or the output (' + what + ')')
  }
})

test('update.sh: a corrupt floor refuses on the timer and on apply until it is deleted', (t) => {
  if (!hasBash(t)) return
  const hash = sha256(SEALED)
  const variants = [
    ['letters', 'abc ' + hash + '\n'], ['zero', floorOf(0)], ['a leading zero', floorOf('05')], ['above 4294967295', floorOf(4294967296)],
    ['the seq alone', '5\n'], ['no LF', floorOf(5).slice(0, -1)], ['two LFs', floorOf(5) + '\n'], ['a trailing space', '5 ' + hash + ' \n'],
    ['CRLF', '5 ' + hash + '\r\n'], ['empty', ''], ['a NUL byte', '5 ' + hash + '\0'], ['eleven digits', floorOf('12345678901')],
    ['an uppercase hash', floorOf(5, hash.toUpperCase())], ['a 63-hex hash', floorOf(5, hash.slice(1))], ['a 65-hex hash', floorOf(5, hash + 'a')],
    ['a non-hex hash', floorOf(5, 'g' + hash.slice(1))], ['two spaces', '5  ' + hash + '\n'], ['a tab', '5\t' + hash + '\n'],
    ['a leading space', ' ' + floorOf(5)], ['a third field', '5 ' + hash + ' x\n'], ['a symlink', null], ['a directory', null]
  ]
  for (const [what, body] of variants) {
    for (const cmd of ['cmd_run', 'cmd_apply']) {
      const { s } = seqServer(t, { mode: 'auto', seq: 9 })
      const { text } = keepEfetivo(s)
      const f = s.p(SEQ_FILE)
      if (what === 'a symlink') {
        s.write('fix/real_floor', floorOf(1))
        fs.symlinkSync(s.p('fix/real_floor'), f)
      } else if (what === 'a directory') {
        fs.mkdirSync(f)
      } else {
        s.write(SEQ_FILE, body, 0o600)
      }
      const r = s.run(MAIN + cmd)
      const label = what + ', ' + cmd
      nothingChanged(t, s, r, text, label)
      t.ok(r.log.includes(f + ' não é uma linha "<seq> <sha256>" (seq de 1 a 4294967295, sha256 em 64 hexadecimais minúsculos) num arquivo comum; nada mudou. Para aceitar o seq do próximo arquivo selado, apague ' + f),
        'names the file and the fix (' + label + '): ' + r.log)
      t.absent(s.exists('state/recusadas'), 'the digest is not refused (' + label + ')')
      t.absent(s.exists('state/intervencao'), 'no intervention (' + label + ')')
      if (what === 'a symlink') t.is(fs.readlinkSync(f), s.p('fix/real_floor'), 'the link is left alone')
      else if (what !== 'a directory') t.is(s.read(SEQ_FILE), body, 'the floor file is left alone (' + label + ')')
    }
  }
  // Deleting it, as the message says, accepts the next seq.
  const { s } = seqServer(t, { mode: 'auto', seq: 2, floor: 'x\n' })
  fs.rmSync(s.p(SEQ_FILE))
  t.is(s.run(MAIN + 'cmd_run').status, 0, 'with the floor deleted the timer applies')
  t.is(s.read(SEQ_FILE), floorOf(2), 'and records the new floor')
  // The switch notes the floor in effect next to the previous env, so a
  // corrupt floor refuses even a release without a sealed file.
  const ns = seqServer(t, { mode: 'auto', seq: 2, floor: 'x\n' })
  fs.rmSync(ns.s.p('fix/bundle/secrets.sealed.json'))
  const kept = keepEfetivo(ns.s)
  const anterior = (s) => s.exists('state/anterior') ? s.read('state/anterior') : null
  const antBefore = anterior(ns.s)
  const rn = ns.s.run(MAIN + 'cmd_apply')
  nothingChanged(t, ns.s, rn, kept.text, 'a corrupt floor and no sealed file')
  t.ok(rn.log.includes(ns.s.p(SEQ_FILE) + ' não é uma linha "<seq> <sha256>"'), 'names the floor file: ' + rn.log)
  t.is(anterior(ns.s), antBefore, 'state/anterior is left as it was')
  t.absent(ns.s.exists('state/segredos/seq.anterior'), 'no previous floor line')
})

test('update.sh: a release without a sealed file, without the key or not for this server leaves the floor', (t) => {
  if (!hasBash(t)) return
  const a = seqServer(t, { mode: 'auto', seq: 2, floor: floorOf(5) })
  fs.rmSync(a.s.p('fix/bundle/secrets.sealed.json'))
  t.is(a.s.run(MAIN + 'cmd_run').status, 0, 'a release without a sealed file applies')
  t.absent(a.s.exists('fix/verify_calls'), 'secrets verify never runs')
  t.is(a.s.read(SEQ_FILE), floorOf(5), 'the floor is unchanged')

  const b = seqServer(t, { mode: 'auto', seq: 2, floor: floorOf(5) })
  fs.rmSync(b.s.p('etc/secrets-key.json'))
  t.is(b.s.run(MAIN + 'cmd_run').status, 0, 'a server without the key applies')
  t.absent(b.s.exists('fix/verify_calls'), 'secrets verify never runs without the key')
  t.is(b.s.read(SEQ_FILE), floorOf(5), 'the floor is unchanged')

  // Not a recipient: no sealed values applied, so neither the floor check
  // nor the floor write applies.
  const c = seqServer(t, { mode: 'auto', seq: 2, floor: floorOf(5) })
  c.s.write('fix/open_rc', '3')
  t.is(c.s.run(MAIN + 'cmd_run').status, 0, 'a server that is not a recipient applies')
  t.is(c.s.read(SEQ_FILE), floorOf(5), 'the floor is unchanged')
  const d = seqServer(t, { mode: 'auto', seq: 9 })
  d.s.write('fix/open_rc', '3')
  t.is(d.s.run(MAIN + 'cmd_run').status, 0, 'applies')
  t.absent(d.s.exists(SEQ_FILE), 'no floor is created')
})

const FAIL_FLOOR = 'chmod() { case $2 in *segredos/seq.tmp) return 1 ;; esac; command chmod "$@"; }\n'

test('update.sh: a floor that cannot be written records the release with an intervention, and apply then writes it', (t) => {
  if (!hasBash(t)) return
  const { s } = seqServer(t, { mode: 'auto', seq: 8, floor: floorOf(5) })
  const { text } = keepEfetivo(s)
  const before = s.read('state/atual')
  const r = s.run(FAIL_FLOOR + MAIN + 'cmd_run')
  t.is(r.status, 1, 'the run fails: ' + r.log)
  t.is(s.read('state/atual'), record(COMMIT, 5, SEEDER_REF, WEB_REF), 'the healthy release is recorded as installed')
  t.is(s.read('state/anterior'), before, 'the old release is the previous one')
  t.is(s.read('state/segredos/efetivo.env.anterior'), text, 'and its env is the previous env')
  t.is(s.read('state/segredos/seq.anterior'), floorOf(5), 'with the floor it ran under')
  t.is(s.read(SEQ_FILE), floorOf(5), 'the floor is unchanged')
  t.absent(s.exists(SEQ_FILE + '.tmp'), 'no temporary file left')
  t.ok(s.read('state/intervencao').includes('seq 8, mas ' + s.p(SEQ_FILE) + ' não foi gravado: rode update.sh apply, ou grave nele a linha "8 ' + sha256(SEALED) + '" (root, 0600)'),
    'an intervention names the file, the line and the fix')
  t.ok(r.log.includes('atualizado para ' + COMMIT + ', mas o piso dos segredos compartilhados não foi gravado; a intervenção continua: rode update.sh apply'), 'says what is left')
  // The next timer run neither goes on nor reports the release as current.
  const again = s.run(MAIN + 'cmd_run')
  t.is(again.status, 1, 'the timer stops on the intervention')
  t.absent(again.log.includes('em dia'), 'it never reports em dia with the stale floor: ' + again.log)
  t.is(s.read(SEQ_FILE), floorOf(5), 'the floor is still the old one')
  // apply takes the up-to-date path: the floor, without moving the previous slot.
  const fix = s.run(MAIN + 'cmd_apply')
  t.is(fix.status, 0, 'apply writes the floor: ' + fix.log)
  t.ok(fix.log.includes('intervenção encerrada'), 'through the up-to-date path')
  t.is(s.read(SEQ_FILE), floorOf(8), 'the floor is the applied file')
  t.absent(s.exists('state/intervencao'), 'the intervention is over')
  t.is(s.read('state/anterior'), before, 'the previous release is still the old one')
  t.is(s.read('state/segredos/efetivo.env.anterior'), text, 'and so is its env')
  // rollback brings the old env back, and the floor never goes down.
  const rb = s.run(MAIN + 'cmd_rollback')
  t.is(rb.status, 0, 'rollback passes: ' + rb.log)
  t.is(s.read('state/atual'), before, 'the old release is back')
  t.is(s.read('state/segredos/efetivo.env'), text, 'with its own env')
  t.is(s.read(SEQ_FILE), floorOf(8), 'the floor stays at the higher seq')
  t.absent(s.exists('state/segredos/seq.anterior'), 'the previous floor line is gone with the previous slot')
})

test('update.sh: a floor and an intervention that both cannot be written stop before state/atual', (t) => {
  if (!hasBash(t)) return
  const { s } = seqServer(t, { mode: 'auto', seq: 8, floor: floorOf(5) })
  const before = s.read('state/atual')
  // A directory where the intervention file goes: it cannot be written.
  fs.mkdirSync(s.p('state/intervencao'))
  const r = s.run(FAIL_FLOOR + MAIN + 'cmd_run')
  t.is(r.status, 1, 'the run fails: ' + r.log)
  t.is(s.read('state/atual'), before, 'state/atual still names the old release')
  t.absent(r.log.includes('atualizado para ' + COMMIT), 'no success is logged')
  t.is(s.read(SEQ_FILE), floorOf(5), 'the floor is unchanged')
})

test('update.sh: up to date with an intervention, a floor that cannot be written does not blame the health gate', (t) => {
  if (!hasBash(t)) return
  const { s } = seqServer(t, { seq: 8 })
  t.is(s.run(MAIN + 'cmd_apply').status, 0, 'the first apply passes')
  fs.rmSync(s.p(SEQ_FILE))
  s.write('state/intervencao', 'x\n')
  const em = s.run(FAIL_FLOOR + MAIN + 'cmd_apply')
  t.is(em.status, 1, 'apply fails: ' + em.log)
  t.ok(em.log.includes('a versão instalada está saudável, mas o piso dos segredos compartilhados não foi gravado; a intervenção continua'), 'names the floor')
  t.absent(em.log.includes('não passou na verificação'), 'never blames the health gate')
  t.ok(s.read('state/intervencao').includes('seq 8, mas ' + s.p(SEQ_FILE) + ' não foi gravado'), 'the intervention stays, about the floor')
  t.absent(s.exists(SEQ_FILE), 'no floor')
})

test('update.sh: rollback after a lower-seq apply brings the floor back up, and the timer refuses what is older than the running file', (t) => {
  if (!hasBash(t)) return
  const { s } = seqServer(t, { mode: 'auto', seq: 5, floor: floorOf(10) })
  const { text } = keepEfetivo(s)
  const a = s.run(MAIN + 'cmd_apply')
  t.is(a.status, 0, 'an explicit apply of seq 5: ' + a.log)
  t.is(s.read(SEQ_FILE), floorOf(5), 'lowers the floor')
  t.is(s.read('state/segredos/seq.anterior'), floorOf(10), 'and keeps the floor of the env it moved aside')
  t.is(modeOf(s.p('state/segredos/seq.anterior')), 0o600, 'in a 0600 file')
  const rb = s.run(MAIN + 'cmd_rollback')
  t.is(rb.status, 0, 'rollback passes: ' + rb.log)
  t.is(s.read('state/segredos/efetivo.env'), text, 'the seq-10 env runs again')
  t.is(s.read(SEQ_FILE), floorOf(10), 'and the floor is back at 10')
  t.ok(rb.log.includes('segredos compartilhados: seq 10 (sha256 ' + sha256(SEALED) + ') anotado em ' + s.p(SEQ_FILE) + ', o da versão anterior'), 'says so')
  t.absent(s.exists('state/segredos/seq.anterior'), 'no previous floor line left')
  // A later release on the channel carries seq 7, older than the running 10.
  s.write('fix/digest', 'sha256:' + H('6', 64) + '\n')
  s.write('fix/release.json', '{"v":1,"commit":"' + H('2', 40) + '","seq":6,"web":"' + WEB_REF + '"}\n')
  s.write('fix/seq', '7')
  const r = s.run(MAIN + 'cmd_run')
  t.is(r.status, 1, 'the timer refuses it: ' + r.log)
  t.ok(r.log.includes('o arquivo selado da nova versão tem seq 7, menor que o último aplicado 10'), 'below the restored floor')
  t.is(s.read(SEQ_FILE), floorOf(10), 'the floor stays')
})

test('update.sh: rollback never lowers the floor, and the way back keeps the previous floor line', (t) => {
  if (!hasBash(t)) return
  // A higher recorded line wins; a lower or equal one leaves the floor.
  const { s } = seqServer(t, { seq: 9, floor: floorOf(5) })
  t.is(s.run(MAIN + 'cmd_apply').status, 0, 'apply of seq 9')
  t.is(s.read('state/segredos/seq.anterior'), floorOf(5), 'the previous floor line is 5')
  const rb = s.run(MAIN + 'cmd_rollback')
  t.is(rb.status, 0, 'rollback passes: ' + rb.log)
  t.is(s.read(SEQ_FILE), floorOf(9), 'a lower recorded line leaves the floor')
  const e = seqServer(t, { seq: 9, floor: floorOf(5) })
  t.is(e.s.run(MAIN + 'cmd_apply').status, 0, 'apply of seq 9')
  e.s.write('state/segredos/seq.anterior', floorOf(9, H('a', 64)), 0o600)
  t.is(e.s.run(MAIN + 'cmd_rollback').status, 0, 'rollback passes')
  t.is(e.s.read(SEQ_FILE), floorOf(9), 'an equal seq keeps the current line')
  // No recorded line: the floor stays.
  const n = seqServer(t, { seq: 9, floor: floorOf(5) })
  t.is(n.s.run(MAIN + 'cmd_apply').status, 0, 'apply of seq 9')
  fs.rmSync(n.s.p('state/segredos/seq.anterior'))
  t.is(n.s.run(MAIN + 'cmd_rollback').status, 0, 'rollback passes')
  t.is(n.s.read(SEQ_FILE), floorOf(9), 'the floor stays')
  // A failed gate: the way back puts the previous slot back as it was.
  const g = seqServer(t, { seq: 9, floor: floorOf(5) })
  g.s.write('state/segredos/seq.anterior', floorOf(3), 0o600)
  g.s.write('state/segredos/efetivo.env.anterior', 'ANTES\n', 0o600)
  g.s.write('fix/gate_fail_1', '')
  t.is(g.s.run(MAIN + 'cmd_apply').status, 1, 'the failed gate fails the apply')
  t.is(g.s.read('state/segredos/seq.anterior'), floorOf(3), 'the previous floor line is back')
  t.is(g.s.read('state/segredos/efetivo.env.anterior'), 'ANTES\n', 'with its env')
  t.absent(g.s.exists('state/segredos/seq.anterior.velho'), 'no .velho left')
  t.is(g.s.read(SEQ_FILE), floorOf(5), 'and the floor is unchanged')
})

test('update.sh: a malformed previous floor line refuses the rollback and changes nothing', (t) => {
  if (!hasBash(t)) return
  for (const [what, body] of [['letters', 'x\n'], ['the seq alone', '10\n'], ['an uppercase hash', floorOf(10, H('A', 64))], ['a directory', null]]) {
    const { s } = seqServer(t, { seq: 5, floor: floorOf(10) })
    t.is(s.run(MAIN + 'cmd_apply').status, 0, 'apply of seq 5')
    const sa = s.p('state/segredos/seq.anterior')
    fs.rmSync(sa)
    if (body === null) fs.mkdirSync(sa)
    else s.write('state/segredos/seq.anterior', body, 0o600)
    const env = s.read('state/segredos/efetivo.env')
    const rb = s.run(MAIN + 'cmd_rollback')
    t.is(rb.status, 1, 'rollback refuses (' + what + ')')
    t.ok(rb.log.includes(sa + ' não é uma linha "<seq> <sha256>" (seq de 1 a 4294967295, sha256 em 64 hexadecimais minúsculos) num arquivo comum; nada mudou. Para voltar sem mexer no piso, apague ' + sa),
      'names the file and the fix (' + what + '): ' + rb.log)
    t.is(s.read('state/atual'), record(COMMIT, 5, SEEDER_REF, WEB_REF), 'atual unchanged (' + what + ')')
    t.is(s.read('state/segredos/efetivo.env'), env, 'efetivo.env unchanged (' + what + ')')
    t.is(s.read(SEQ_FILE), floorOf(5), 'the floor unchanged (' + what + ')')
    t.absent(rb.log.includes('voltando para'), 'no way back started (' + what + ')')
  }
})

test('update.sh: an exit while secrets verify or open runs leaves none of their output files', (t) => {
  if (!hasBash(t)) return
  for (const step of ['verify', 'open']) {
    const { s } = seqServer(t, { floor: floorOf(5) })
    s.write('fix/' + step + '_exit', '')
    const r = s.run(MAIN + 'cmd_apply')
    t.is(r.status, 1, 'the run exits (' + step + ')')
    for (const f of ['conferir.out', 'conferir.err', 'abrir.err']) t.absent(s.exists('state/segredos/' + f), f + ' is gone (' + step + ')')
    t.absent(s.exists('state/segredos/abrir'), 'no opened directory left (' + step + ')')
  }
})

test('update.sh: install over running containers takes a seq below the floor like apply, and lowers it', (t) => {
  if (!hasBash(t)) return
  const s = server(t)
  s.write('etc/update.conf', 'VARANDA_UPDATE=manual\nVARANDA_PROFILE=full\n')
  s.write('etc/varanda.env', FULL_ENV)
  s.write('fix/ps_seeder', 'aaa111\n')
  s.write('fix/ps_web', 'bbb222\n')
  s.write('fix/img_aaa111', 'sha256:old-seeder\n')
  s.write('fix/img_bbb222', 'sha256:old-caddy\n')
  s.write('fix/workdir', s.p('checkout') + '\n')
  s.write('fix/bundle/secrets.sealed.json', SEALED)
  s.write('fix/bundle/secrets-signers.txt', H('5', 64) + '\n')
  s.write('etc/secrets-key.json', '{"v":1,"publicKey":"' + H('f', 64) + '","secretKey":"' + sentinel('key') + '"}\n')
  s.write('fix/aberto.env', "VARANDA_GIF_API_KEY='" + sentinel('gif') + "'\n")
  s.write('fix/seq', '4')
  fs.mkdirSync(s.p('state/segredos'), { recursive: true })
  s.write(SEQ_FILE, floorOf(9), 0o600)
  const r = s.run(MAIN + 'ref_install=' + SEEDER_REF + '\ncmd_install')
  t.is(r.status, 0, 'install over the checkout passes: ' + r.log)
  t.ok(r.log.includes('segredos compartilhados: aplicando o arquivo selado com seq 4, menor que o último aplicado 9'), 'logs both seqs')
  t.is(s.read('state/atual'), record(COMMIT, 5, SEEDER_REF, WEB_REF), 'the release is applied')
  t.is(s.read(SEQ_FILE), floorOf(4), 'the floor is the applied seq and hash')
})

test('update.sh: install applies the floor rule like apply', (t) => {
  if (!hasBash(t)) return
  // A new server: nothing starts, so the floor waits for the first apply.
  const n = server(t)
  n.write('etc/update.conf', 'VARANDA_UPDATE=manual\n')
  n.write('fix/bundle/secrets.sealed.json', '{"v":1}\n')
  n.write('fix/bundle/secrets-signers.txt', H('5', 64) + '\n')
  n.write('etc/secrets-key.json', '{"v":1,"publicKey":"' + H('f', 64) + '","secretKey":"' + sentinel('key') + '"}\n')
  n.write('fix/aberto.env', "VARANDA_GIF_API_KEY='" + sentinel('gif') + "'\n")
  n.write('fix/seq', '6')
  const r = n.run(MAIN + 'ref_install=' + SEEDER_REF + '\ncmd_install')
  t.is(r.status, 0, 'install passes: ' + r.log)
  t.absent(n.exists(SEQ_FILE), 'no floor before anything passed the gate')
  const a = n.run(MAIN + 'cmd_apply')
  t.is(a.status, 0, 'the first apply passes: ' + a.log)
  t.is(n.read(SEQ_FILE), floorOf(6), 'the first apply records the floor')
  // A corrupt floor refuses install too.
  const c = server(t)
  c.write('etc/update.conf', 'VARANDA_UPDATE=manual\n')
  c.write('fix/bundle/secrets.sealed.json', '{"v":1}\n')
  c.write('fix/bundle/secrets-signers.txt', H('5', 64) + '\n')
  c.write('etc/secrets-key.json', '{"v":1,"publicKey":"' + H('f', 64) + '","secretKey":"' + sentinel('key') + '"}\n')
  c.write('fix/aberto.env', "VARANDA_GIF_API_KEY='" + sentinel('gif') + "'\n")
  fs.mkdirSync(c.p('state/segredos'), { recursive: true })
  c.write(SEQ_FILE, 'x\n', 0o600)
  const rc = c.run(MAIN + 'ref_install=' + SEEDER_REF + '\ncmd_install')
  t.is(rc.status, 1, 'install refuses with a corrupt floor')
  t.absent(c.exists('state/preparada'), 'nothing prepared')
  t.absent(c.exists('state/segredos/efetivo.env'), 'no efetivo.env')
})

// Known, value-free CLI messages (the last stderr line) and the CLI source
// fragments each one is built from, so a reworded message shows up here.
const CLI_MESSAGES = [
  ['erro: arquivo selado inválido', ["'arquivo selado inválido'"]],
  ['erro: arquivo de chave inválido', ["'arquivo de chave inválido'"]],
  ['erro: este arquivo é uma chave de assinatura, não a chave do servidor', ["'este arquivo é uma chave de assinatura, não a chave do servidor'"]],
  ['erro: versão do arquivo selado desconhecida', ["'versão do arquivo selado desconhecida'"]],
  ['erro: arquivo selado sem assinatura', ["'arquivo selado sem assinatura'"]],
  ['erro: o arquivo selado não foi assinado por uma chave da lista de quem sela', ["'o arquivo selado não foi assinado por uma chave da lista de quem sela'"]],
  ['erro: assinatura do arquivo selado inválida', ["'assinatura do arquivo selado inválida'"]],
  ['erro: lista de quem sela: nenhuma chave', ["'lista de quem sela: nenhuma chave'"]],
  ['erro: lista de quem sela: mais de 16 chaves', ["'lista de quem sela: mais de ' + MAX_SIGNERS + ' chaves'", 'const MAX_SIGNERS = 16\n']],
  ['erro: arquivo selado grande demais: /segredos/selado.json', ["' grande demais: '", "readInput(input, 'arquivo selado')"]],
  ['erro: lista de quem sela grande demais: /segredos/assinantes.txt', ["' grande demais: '", "readInput(file, 'lista de quem sela')"]],
  ['erro: o arquivo de chave pode ser lido por outros usuários (use chmod 600): /segredos/chave.json', ["'o arquivo de chave pode ser lido por outros usuários (use chmod 600): '"]]
]

test('update.sh: the CLI messages it logs exist in the CLI, value-free', (t) => {
  const cli = ['apps/cli/lib/sealed-secrets.js', 'apps/cli/lib/commands/secrets.js', 'apps/cli/bin/varanda.js']
    .map((f) => fs.readFileSync(path.join(repoRoot, f), 'utf8')).join('\n')
  t.ok(cli.includes("(usage ? 'uso: ' : 'erro: ') + err.message"), 'the CLI prefixes errors with "erro: "')
  for (const [line, parts] of CLI_MESSAGES) {
    t.ok(sh.includes("'" + line + "'"), 'update.sh knows ' + line)
    for (const part of parts) t.ok(cli.includes(part), 'the CLI builds it from ' + part)
  }
  t.ok(cli.includes("invalid: 'lista de quem sela: chave inválida na linha '") && cli.includes("repeated: 'lista de quem sela: chave repetida na linha '"),
    'the numbered signers messages exist')
})

test('update.sh: only a known CLI message from secrets open or verify reaches the log, never another line', (t) => {
  if (!hasBash(t)) return
  const known = [
    'erro: o arquivo selado não foi assinado por uma chave da lista de quem sela',
    'erro: assinatura do arquivo selado inválida',
    'erro: lista de quem sela: chave repetida na linha 3'
  ]
  const leak = sentinel('vazado')
  const unknown = [
    'erro: assinatura do arquivo selado inválida ' + leak,
    leak,
    'erro: lista de quem sela: chave inválida na linha 3 ' + leak,
    'erro: valor inválido em VARANDA_GIF_API_KEY: ' + leak,
    'erro: assinatura do arquivo selado inválida\n' + leak
  ]
  for (const step of ['open', 'verify']) {
    const msg = step === 'open' ? 'não foi possível abrir os segredos compartilhados' : 'não foi possível conferir o arquivo selado'
    for (const line of known) {
      const { s, v } = seqServer(t, { floor: floorOf(5) })
      const { val, text } = keepEfetivo(s)
      s.write('fix/' + step + '_rc', '1')
      s.write('fix/' + step + '_err', 'linha de antes\n' + line + '\n')
      const r = s.run(MAIN + 'cmd_apply')
      nothingChanged(t, s, r, text, step + ': ' + line)
      t.ok(r.log.includes(msg + ' (saída 1: ' + line + '); nada mudou'), 'the known message is logged (' + step + '): ' + r.log)
      t.absent(r.log.includes('linha de antes'), 'earlier lines are not (' + step + ')')
      t.alike(leaks(r, [...Object.values(v), val]), [], 'no value or key in the log (' + step + ')')
    }
    for (const line of unknown) {
      const { s, v } = seqServer(t, { floor: floorOf(5) })
      const { text } = keepEfetivo(s)
      s.write('fix/' + step + '_rc', '1')
      s.write('fix/' + step + '_err', line + '\n')
      const r = s.run(MAIN + 'cmd_apply')
      nothingChanged(t, s, r, text, step + ': unknown')
      t.ok(r.log.includes(msg + ' (saída 1); nada mudou'), 'only the exit code (' + step + '): ' + r.log)
      t.alike(leaks(r, [...Object.values(v), leak]), [], 'an unknown line never reaches the log (' + step + ')')
    }
  }
  // The open stub echoes the key file to stderr: without a known last line,
  // nothing of it is logged.
  const { s, v } = seqServer(t, {})
  s.write('fix/open_rc', '2')
  const r = s.run(MAIN + 'cmd_apply')
  t.ok(r.log.includes('não foi possível abrir os segredos compartilhados (saída 2); nada mudou'), 'a key on stderr gives only the exit code')
  t.alike(leaks(r, [v.key]), [], 'the key never reaches the log')
})
