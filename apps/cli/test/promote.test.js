'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../../..')
const WORKFLOW = path.join(repoRoot, '.github/workflows/promote.yml')

// promote.yml, checked with line and regex rules like ios-release.test.js (no
// YAML parser available). Comment lines are dropped so prose cannot satisfy or
// trip a rule. The job signs with the stable identity and moves the tag that
// stable servers follow, so the rules keep it on main, behind the variable and
// the environment, with nothing spliced into a script, and in the order
// verify, sign, verify, move by digest, read back.
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

function indexOf (re) {
  return lines.findIndex((l) => re.test(l))
}

// The text of the run: block of the step with this name.
function stepRun (name) {
  const start = lines.findIndex((l) => l.trim() === '- name: ' + name)
  if (start === -1) return ''
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {6}- /.test(lines[i])) break
    out.push(lines[i])
  }
  return out.join('\n')
}

const job = block(/^ {2}promote:\s*$/, /^ {2}\S/)
const GUARD = "github\\.repository == 'Varanda-org\\/varanda' && github\\.ref == 'refs\\/heads\\/main' && vars\\.VARANDA_PROMOTE == 'true'"
const EDGE_IDENTITY = 'https://github.com/Varanda-org/varanda/.github/workflows/release.yml@refs/heads/main'
const STABLE_IDENTITY = 'https://github.com/Varanda-org/varanda/.github/workflows/promote.yml@refs/heads/main'
const ISSUER = 'https://token.actions.githubusercontent.com'

test('promote.yml: workflow_dispatch only, with the two inputs', (t) => {
  t.ok(/^name:\s*promote\s*$/m.test(code), 'workflow name is promote')
  const on = block(/^on:/, /^\S/)
  const triggers = (on.match(/^ {2}\S+:/gm) || []).map((s) => s.trim())
  t.alike(triggers, ['workflow_dispatch:'], 'the only trigger is workflow_dispatch')

  const inputs = (on.match(/^ {6}\S+:/gm) || []).map((s) => s.trim())
  t.alike(inputs, ['commit:', 'allow_older:'], 'inputs are commit and allow_older')
  const commit = block(/^ {6}commit:/, /^ {6}\S/)
  t.ok(/^ {8}required:\s*true\s*$/m.test(commit), 'commit is required')
  t.ok(/^ {8}type:\s*string\s*$/m.test(commit), 'commit is a string')
  const older = block(/^ {6}allow_older:/, /^ {6}\S/)
  t.ok(/^ {8}type:\s*boolean\s*$/m.test(older), 'allow_older is a boolean')
  t.ok(/^ {8}default:\s*false\s*$/m.test(older), 'allow_older defaults to false')
})

test('promote.yml: permissions, guard, environment and concurrency', (t) => {
  const top = block(/^permissions:/, /^\S/)
  const topLines = top.split('\n').slice(1).filter((l) => l.trim() !== '').map((l) => l.trim())
  t.alike(topLines, ['contents: read'], 'top-level permissions are contents: read only')

  const jobs = block(/^jobs:/, /^\S/).split('\n').filter((l) => /^ {2}[A-Za-z0-9_-]+:/.test(l)).map((l) => l.trim().replace(/:.*$/, ''))
  t.alike(jobs, ['promote'], 'one job, promote')

  const perms = block(/^ {4}permissions:\s*$/, /^ {4}\S/).split('\n').slice(1).filter((l) => l.trim() !== '').map((l) => l.trim())
  t.alike(perms.sort(), ['contents: read', 'id-token: write', 'packages: write'], 'job permissions: contents read, packages and id-token write')
  t.is((code.match(/^\s*permissions:/gm) || []).length, 2, 'permissions only at the top level and on the job')

  t.ok(new RegExp('^ {4}if:\\s*' + GUARD + '\\s*$', 'm').test(job), 'repository, branch and variable guard')
  t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(job), 'runs-on ubuntu-24.04')
  t.ok(/^ {4}timeout-minutes:\s*\d+\s*$/m.test(job), 'has a timeout')
  t.ok(/^ {4}environment:\s*\n {6}name:\s*release-stable\s*$/m.test(job), 'uses the release-stable environment')

  t.ok(/^ {2}group:\s*promote\s*$/m.test(code), 'concurrency group is promote')
  t.ok(/^ {2}cancel-in-progress:\s*false\s*$/m.test(code), 'cancel-in-progress is false')
})

test('promote.yml: only checkout, pinned, without credentials and with full history', (t) => {
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1])
  t.alike(uses, ['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'], 'one uses: line, checkout at the deploy.yml pin')
  t.ok(/uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\s*\n\s+persist-credentials:\s*false\s*\n\s+fetch-depth:\s*0\s*$/m.test(code), 'checkout has persist-credentials: false and fetch-depth: 0')
  t.absent(/cosign-installer|setup-buildx|docker\/login-action/.test(code), 'no installer or login action')
})

test('promote.yml: inputs, secrets and vars only in env: or if:', (t) => {
  const secrets = new Set([...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
  const vars = new Set([...code.matchAll(/vars\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
  t.alike([...secrets], ['GITHUB_TOKEN'], 'secret names')
  t.alike([...vars], ['VARANDA_PROMOTE'], 'the only variable is VARANDA_PROMOTE')
  t.absent(/\bsecrets:\s*inherit/.test(code), 'no secrets: inherit')
  t.absent(/toJSON\(/i.test(code), 'no dump of a context')
  t.absent(/github\.event\.inputs/.test(code), 'inputs read only through the inputs context')
  for (const l of lines) {
    if (!/\b(secrets|vars)\./.test(l)) continue
    const ok = /^\s+if:\s/.test(l) || /^\s+[A-Z_]+:\s*\$\{\{\s*(secrets|vars)\.[A-Za-z0-9_]+\s*\}\}\s*$/.test(l)
    t.ok(ok, 'only in env: or if: -> ' + l.trim())
  }
  const inputLines = lines.filter((l) => /\binputs\./.test(l))
  t.is(inputLines.length, 2, 'two lines read an input')
  for (const l of inputLines) {
    t.ok(/^\s+[A-Z_]+:\s*\$\{\{\s*inputs\.[a-z_]+\s*\}\}\s*$/.test(l), 'input only in env: -> ' + l.trim())
  }

  let inRun = false
  let runIndent = 0
  let runs = 0
  for (const l of lines) {
    const m = l.match(/^(\s*)(- )?run:\s*(\|)?(.*)$/)
    if (m) {
      runs++
      t.absent(/\$\{\{/.test(m[4]), 'no ${{ in a run: line: ' + l.trim())
      inRun = m[3] === '|'
      runIndent = m[1].length + (m[2] ? 2 : 0)
      continue
    }
    if (inRun) {
      if (l.trim() !== '' && l.match(/^\s*/)[0].length <= runIndent) inRun = false
      else t.absent(/\$\{\{/.test(l), 'no ${{ inside a run: block: ' + l.trim())
    }
  }
  t.ok(runs >= 8, 'the run: steps were scanned')
  for (const bad of ['pull_request', 'workflow_run', 'continue-on-error', 'self-hosted', '<<:', '\u2014']) {
    t.absent(yml.includes(bad), 'absent: ' + bad)
  }
})

test('promote.yml: the release contract names', (t) => {
  t.ok(/^ {6}SEEDER:\s*ghcr\.io\/varanda-org\/varanda-seeder\s*$/m.test(job), 'seeder repository')
  t.ok(/^ {6}WEB:\s*ghcr\.io\/varanda-org\/varanda-web\s*$/m.test(job), 'web repository')
  t.ok(new RegExp('^ {6}ISSUER:\\s*' + ISSUER.replace(/[.]/g, '\\.') + '\\s*$', 'm').test(job), 'OIDC issuer')
  t.ok(job.includes('EDGE_IDENTITY: ' + EDGE_IDENTITY + '\n'), 'release.yml identity')
  t.ok(job.includes('STABLE_IDENTITY: ' + STABLE_IDENTITY + '\n'), 'promote.yml identity')
  t.ok(/^ {6}COMMIT:\s*\$\{\{ inputs\.commit \}\}\s*$/m.test(job), 'COMMIT from the input')
  t.ok(/^ {6}ALLOW_OLDER:\s*\$\{\{ inputs\.allow_older \}\}\s*$/m.test(job), 'ALLOW_OLDER from the input')
})

test('promote.yml: commit check and the pinned cosign image', (t) => {
  const check = stepRun('Check the commit')
  t.ok(check.includes('[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]]'), 'commit is 40 lower-case hex')
  t.ok(/git merge-base --is-ancestor "\$COMMIT" origin\/main/.test(check), 'commit is an ancestor of or equal to origin/main')
  // Each refusal stops the job; without the exit the next step would run.
  for (const cond of ['if ! [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]]; then', 'if ! git cat-file -e "$COMMIT^{commit}" 2>/dev/null; then', 'if ! git merge-base --is-ancestor "$COMMIT" origin/main; then']) {
    const at = check.indexOf(cond)
    t.ok(at !== -1 && /^\n\s+echo "::error::[^"\n]*"\n\s+exit 1\n\s+fi/.test(check.slice(at + cond.length)), 'refused with exit 1: ' + cond)
  }

  const cos = stepRun('Read the pinned cosign image')
  t.ok(/ref=\$\(grep -Ev '\^\[\[:space:\]\]\*\(#\|\$\)' deploy\/seeder\/cosign\.ref \|\| true\)/.test(cos), 'reads deploy/seeder/cosign.ref without comment lines')
  t.ok(/\[\[ "\$ref" =~ \$re \]\]/.test(cos), 'checks the whole reference against the pattern')
  t.ok(/if ! \[\[ "\$ref" =~ \$re \]\]; then\n\s+echo "::error::[^"\n]*"\n\s+exit 1\n\s+fi\n\s+echo "COSIGN=\$ref" >> "\$GITHUB_ENV"/.test(cos), 'an invalid cosign.ref stops the job before it reaches GITHUB_ENV')
  const m = cos.match(/re='([^']+)'/)
  t.ok(m, 'cosign.ref pattern')
  const re = new RegExp(m[1])
  const digest = 'sha256:' + 'a'.repeat(64)
  t.ok(re.test('ghcr.io/sigstore/cosign/cosign:v2.4.1@' + digest), 'accepts a pinned cosign image')
  t.absent(re.test('ghcr.io/sigstore/cosign/cosign:v2.4.1'), 'refuses a tag without a digest')
  t.absent(re.test('ghcr.io/evil/cosign:v2.4.1@' + digest), 'refuses another repository')
  t.absent(re.test('ghcr.io/sigstore/cosign/cosign:latest@' + digest), 'refuses a non-semver tag')
  t.absent(re.test('ghcr.io/sigstore/cosign/cosign:v2.4.1@sha256:' + 'A'.repeat(64)), 'refuses an upper-case digest')
  const pinned = fs.readFileSync(path.join(repoRoot, 'deploy/seeder/cosign.ref'), 'utf8')
    .split('\n').filter((l) => !/^\s*(#|$)/.test(l))
  t.is(pinned.length, 1, 'cosign.ref holds one reference')
  t.ok(re.test(pinned[0]), 'the pinned cosign.ref passes the check')

  // cosign only as that container, never a binary on the runner.
  const cosignCalls = lines.filter((l) => /\bcosign\b/.test(l) && !/^\s+- name:/.test(l) && !/cosign\.ref|sigstore\/cosign\/cosign/.test(l))
  t.alike(cosignCalls, [], 'no cosign binary is called')
  for (const l of lines.filter((l) => /"\$COSIGN" (sign|verify)/.test(l))) {
    t.ok(/^\s+"\$COSIGN" (sign|verify)\b/.test(l), 'cosign subcommand runs from the container: ' + l.trim())
  }
})

test('promote.yml: login, pull and the release.json check', (t) => {
  const login = stepRun('Log in to GHCR')
  t.ok(/printf '%s' "\$GITHUB_TOKEN" \| [^\n]*docker login ghcr\.io -u "\$GITHUB_ACTOR" --password-stdin/.test(login), 'token on stdin')
  t.ok(/^ {10}GITHUB_TOKEN:\s*\$\{\{ secrets\.GITHUB_TOKEN \}\}\s*$/m.test(code), 'GITHUB_TOKEN only in the login step env')
  t.is((code.match(/secrets\.GITHUB_TOKEN/g) || []).length, 1, 'the token reaches one step only')

  const pull = stepRun('Pull the seeder image of the commit')
  t.ok(/if ! digest="\$\(digest_of "\$SEEDER:sha-\$COMMIT"\)"; then\n\s+exit 1\n/.test(pull), 'resolves the commit tag; a registry error fails')
  t.ok(/if \[ -z "\$digest" \]; then\n\s+echo "::error::[^"\n]*esta versão não foi publicada pelo release; publique a ponta ou escolha um commit publicado"\n\s+exit 1\n/.test(pull), 'a commit with no image fails with a clear error')
  t.ok(pull.includes('docker pull "$SEEDER@$digest"'), 'pulls by digest')

  const rel = stepRun('Check release.json and the seq')
  t.ok(/docker run --rm --pull never --network none --entrypoint cat "\$1" \/app\/release\.json/.test(rel), 'reads release.json with no network')
  t.ok(/if \[ "\$rel_commit" != "\$COMMIT" \]; then\n\s+echo "::error::[^"\n]*"\n\s+exit 1\n/.test(rel), 'release.json commit must equal the input, or fail')
  t.ok(/if ! out=\$\(read_release "\$SEEDER@\$SEEDER_DIGEST" new\); then\n\s+echo "::error::[^"\n]*"\n\s+exit 1\n/.test(rel), 'an unreadable release.json fails')

  const m = rel.match(/re='([^']+)'/)
  t.ok(m, 'release.json pattern')
  const re = new RegExp(m[1])
  const c = 'c'.repeat(40)
  const w = 'sha256:' + 'd'.repeat(64)
  const ok = '{"v":1,"commit":"' + c + '","seq":42,"web":"ghcr.io/varanda-org/varanda-web@' + w + '"}'
  t.ok(re.test(ok), 'accepts the exact format')
  t.is(ok.match(re)[1], c, 'captures the commit')
  t.is(ok.match(re)[2], '42', 'captures the seq')
  t.is(ok.match(re)[3], w, 'captures the web digest')
  t.absent(re.test(ok.replace('"v":1', '"v":2')), 'refuses another version')
  t.absent(re.test(ok.replace(':42,', ':042,')), 'refuses a seq with a leading zero')
  t.absent(re.test(ok.replace(':42,', ':-1,')), 'refuses a negative seq')
  t.absent(re.test(ok.replace(':42,', ':0,')), 'refuses seq 0, which servers refuse')
  t.absent(re.test(ok.replace(':42,', ':12345678901,')), 'refuses a seq of 11 digits, which servers refuse')
  t.ok(re.test(ok.replace(':42,', ':1234567890,')), 'accepts a seq of 10 digits')
  t.absent(re.test(ok.replace('varanda-org/varanda-web', 'evil/varanda-web')), 'refuses another web repository')
  t.absent(re.test(ok.replace(',"seq"', ', "seq"')), 'refuses extra spaces')
  t.absent(re.test(ok + ' '), 'refuses trailing text')
  t.absent(re.test(ok.replace(c, c.toUpperCase())), 'refuses an upper-case commit')
  t.ok(/\[ "\$\(wc -l < "\$f"\)" -eq 1 \]/.test(rel), 'exactly one line')
  t.ok(/\[ -z "\$\(tail -c 1 "\$f"\)" \]/.test(rel), 'ends with LF')
})

test('promote.yml: the current stable counts only when it verifies', (t) => {
  const rel = stepRun('Check release.json and the seq')
  t.ok(/verify_stable \(\) \{\n\s+docker run [^\n]*\n[^\n]*\n\s+"\$COSIGN" verify \\\n\s+--certificate-identity "\$STABLE_IDENTITY" \\\n\s+--certificate-oidc-issuer "\$ISSUER" \\\n\s+"\$1" > \/dev\/null\n\s+\}/.test(rel), 'verify_stable checks the promote.yml identity and issuer and can fail')
  t.ok(/^ {10}stable=unknown\n {10}stable_seq=""\n/m.test(rel), 'the stable starts as unknown')
  t.ok(/if stable_digest="\$\(digest_of "\$SEEDER:stable"\)"; then\n\s+if \[ -z "\$stable_digest" \]; then\n\s+stable=none\n/.test(rel), 'only the registry answer that the tag is missing means no stable')
  t.ok(/elif verify_stable "\$SEEDER@\$stable_digest" \\\n\s+&& docker pull "\$SEEDER@\$stable_digest" \\\n\s+&& stable_out=\$\(read_release "\$SEEDER@\$stable_digest" stable\); then\n\s+read -r _ stable_seq _ <<< "\$stable_out"\n\s+stable=ok\n/.test(rel), 'the stable is verified before it is pulled and run, and its seq is read only then')
  t.absent(/grep -q 'not found'/.test(code), 'no loose "not found" match')

  // The three outcomes, each refusal followed by its exit.
  t.ok(/^ {12}none\)\n {14}echo "[^"\n]*"\n {14};;\n/m.test(rel), 'no stable yet: nothing to compare')
  t.ok(/^ {12}ok\)\n {14}if \[ "\$seq" -le "\$stable_seq" \]; then\n {16}if \[ "\$ALLOW_OLDER" = 'true' \]; then\n {18}echo "::warning::[^"\n]*"\n {16}else\n {18}echo "::error::[^"\n]*"\n {18}exit 1\n {16}fi\n {14}fi\n {14};;\n/m.test(rel), 'a lower or equal seq is refused unless allow_older')
  t.ok(/^ {12}\*\)\n {14}if \[ "\$ALLOW_OLDER" = 'true' \]; then\n {16}echo "::warning::[^"\n]*"\n {14}else\n {16}echo "::error::[^"\n]*"\n {16}exit 1\n {14}fi\n {14};;\n/m.test(rel), 'an unreadable or unverifiable stable is refused unless allow_older')
  t.ok(rel.indexOf('esac') < rel.indexOf('echo "SEQ=$seq" >> "$GITHUB_ENV"'), 'the seq is recorded only after the check')
})

test('promote.yml: digests read one way, the registry answer for a missing tag only', (t) => {
  const fns = []
  const ls = code.split('\n')
  for (let i = 0; i < ls.length; i++) {
    if (!/^\s+digest_of\(\) \{\s*$/.test(ls[i])) continue
    const fn = []
    for (let j = i; j < ls.length; j++) {
      fn.push(ls[j].trim())
      if (j > i && ls[j].search(/\S/) === ls[i].search(/\S/) && ls[j].trim() === '}') break
    }
    fns.push(fn.join('\n'))
  }
  t.is(fns.length, 3, 'pull, release.json and tag move steps define digest_of')
  for (const f of fns) t.is(f, fns[0], 'the same digest_of each time')
  t.ok(fns[0].includes('elif grep -Fxq -- "ERROR: $1: not found" "$err"; then\nreturn 0'), 'missing only on the registry answer for that exact reference')
  t.is(lines.filter((l) => /imagetools inspect/.test(l)).length, 3, 'no digest read outside digest_of')
})

test('promote.yml: verify, sign, verify, then move by digest with read-back', (t) => {
  const verifyRelease = stepRun('Verify the release signature')
  t.ok(/"\$COSIGN" verify \\\n\s+--certificate-identity "\$EDGE_IDENTITY" \\\n\s+--certificate-oidc-issuer "\$ISSUER" \\\n\s+"\$SEEDER@\$SEEDER_DIGEST" > \/dev\/null\s*$/.test(verifyRelease), 'the release signature is verified on the seeder digest being promoted')
  const verifyStableRun = stepRun('Verify the stable signature')
  t.ok(/"\$COSIGN" verify \\\n\s+--certificate-identity "\$STABLE_IDENTITY" \\\n\s+--certificate-oidc-issuer "\$ISSUER" \\\n\s+"\$SEEDER@\$SEEDER_DIGEST" > \/dev\/null\s*$/.test(verifyStableRun), 'the new signature is verified on the same digest')
  for (const l of lines.filter((l) => /> \/dev\/null/.test(l) && /SEEDER|"\$1"/.test(l))) {
    t.absent(/\|\|\s*(true|:)\b/.test(l), 'a verify failure is never ignored: ' + l.trim())
  }

  const stepStart = (name) => lines.findIndex((l) => l.trim() === '- name: ' + name)
  const verifyEdge = indexOf(/--certificate-identity "\$EDGE_IDENTITY"/)
  const sign = indexOf(/"\$COSIGN" sign --yes "\$SEEDER@\$SEEDER_DIGEST"/)
  const verifyStable = stepStart('Verify the stable signature')
  const moveWeb = indexOf(/^\s+if ! move "\$WEB" "\$WEB_DIGEST"; then/)
  const moveSeeder = indexOf(/^\s+if ! move "\$SEEDER" "\$SEEDER_DIGEST"; then/)
  t.ok(verifyEdge > -1, 'verifies the release.yml signature')
  t.ok(sign > -1, 'signs the seeder digest')
  t.ok(verifyStable > -1, 'verifies the promote.yml signature')
  t.ok(moveWeb > -1 && moveSeeder > -1, 'moves both tags')
  t.ok(verifyEdge < stepStart('Check release.json and the seq'), 'the release signature is verified before the image is run')
  t.ok(verifyEdge < sign, 'verify before sign')
  t.ok(sign < verifyStable, 'sign before the stable verify')
  t.ok(verifyStable < moveWeb, 'stable verify before the tag move')
  t.ok(moveWeb < moveSeeder, 'web tag first, seeder tag last')
  t.is((code.match(/--certificate-oidc-issuer "\$ISSUER"/g) || []).length, 3, 'every verify pins the issuer')
  t.absent(/certificate-identity-regexp|--insecure|allow-insecure|--allow-http-registry|tlog-upload=false/.test(code), 'no loosened cosign option')

  const signRun = stepRun('Sign for the stable channel')
  t.ok(signRun.includes('-v "$DOCKER_CONFIG:/dockercfg:ro" -e DOCKER_CONFIG=/dockercfg'), 'docker config mounted read-only for signing')
  t.ok(signRun.includes('-e ACTIONS_ID_TOKEN_REQUEST_URL -e ACTIONS_ID_TOKEN_REQUEST_TOKEN'), 'OIDC request variables passed by name')
  t.absent(/ACTIONS_ID_TOKEN_REQUEST_(URL|TOKEN)=/.test(code), 'OIDC request values never spelled out')

  const move = stepRun('Move the stable tags')
  const creates = lines.filter((l) => /imagetools create/.test(l))
  t.is(creates.length, 1, 'one imagetools create')
  t.ok(/docker buildx imagetools create --prefer-index=false -t "\$1:stable" "\$1@\$2"$/.test(creates[0].trim()), 'tag moved by digest with --prefer-index=false')
  t.ok(/src="\$\(digest_of "\$1@\$2"\)" \|\| return 1\n\s+if \[ "\$src" != "\$2" \]; then\n[^\n]*\n\s+return 1/.test(move), 'source digest equals the verified digest')
  t.ok(/if ! retag "\$1" "\$2"; then\n[^\n]*\n\s+return 1/.test(move), 'a failed retag fails the move')
  t.ok(/got="\$\(digest_of "\$1:stable"\)" \|\| got=""\n\s+if \[ "\$got" != "\$2" \]; then\n[^\n]*\n\s+return 1/.test(move), 'reads :stable back; it must equal the verified digest')
  t.ok(/web_prev="\$\(digest_of "\$WEB:stable"\)" \|\| exit 1/.test(move) && /seeder_prev="\$\(digest_of "\$SEEDER:stable"\)" \|\| exit 1/.test(move), 'previous digests read before the move')
  t.ok(/restore "\$SEEDER" "\$seeder_prev"\n\s+restore "\$WEB" "\$web_prev"\n\s+exit 1/.test(move), 'a failed seeder move restores both tags and fails')
  t.ok(/restore "\$WEB" "\$web_prev"\n\s+exit 1/.test(move), 'a failed web move restores it and fails')
  t.ok(/retag "\$1" "\$2" \|\| echo "::error::[^"\n]*"/.test(move), 'a failed restore is reported')
  t.ok(/if \[ -n "\$2" \]; then\n[^\n]*\n\s+else\n\s+echo "::error::[^"\n]*"\n\s+fi/.test(move), 'a missing previous digest is reported')
  t.absent(/docker (image )?(tag|push)\b/.test(code), 'no local tag and push')
  t.absent(/docker build\b|buildx build\b|imagetools create(?![^\n]*--prefer-index=false)/.test(code), 'nothing is rebuilt')
})

test('promote.yml: summary with commit, seq and digests', (t) => {
  const sum = stepRun('Summary')
  for (const v of ['$COMMIT', '$SEQ', '$SEEDER_DIGEST', '$WEB_DIGEST']) t.ok(sum.includes(v), 'summary has ' + v)
  t.ok(/>> "\$GITHUB_STEP_SUMMARY"/.test(sum), 'written to the step summary')
})

test('promote.yml: messages in pt-BR', (t) => {
  // The English words the old messages used; release.yml and deploy.yml log in pt-BR.
  for (const l of lines.filter((l) => /::(error|warning)::/.test(l))) {
    t.absent(/\b(is not|must|could not|not newer|no valid|set allow_older|missing|expected)\b/.test(l), 'pt-BR: ' + l.trim())
  }
})

test('promote.yml: the header orders the stable gate before VARANDA_PROMOTE', (t) => {
  const header = yml.split('\n').filter((l) => /^#/.test(l)).join('\n')
  const env = header.indexOf('1. Settings > Environments > New environment release-stable')
  const variable = header.indexOf('VARANDA_PROMOTE = true')
  t.ok(env !== -1 && variable !== -1 && env < variable, 'create release-stable before setting VARANDA_PROMOTE')
  t.ok(/required\n?#?\s*reviewers/.test(header) && /prevent self-review/.test(header) && /limited to main/.test(header), 'reviewers, no self-review, main only')
  t.ok(/GitHub creates a missing\n?#?\s*environment without any protection/.test(header), 'says why the order matters')
  t.ok(/VARANDA_RELEASE enables only release\.yml/.test(header), 'VARANDA_RELEASE does not enable promote')
  t.ok(/Not every commit of main has an image/.test(header), 'documents commits with no image')
})
