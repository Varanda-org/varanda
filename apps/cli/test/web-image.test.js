'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../../..')
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8')
const code = (p) => read(p).split('\n').filter((l) => !/^\s*#/.test(l))

const web = code('deploy/seeder/Dockerfile.web')
const webText = web.join('\n')
const NODE_RE = /node:[\w.-]+@sha256:[0-9a-f]{64}/

test('Dockerfile.web: the node image is the one of the seeder image and build-web.sh', (t) => {
  const mine = web.find((l) => /^FROM node:/.test(l))
  t.ok(mine, 'node stage found')
  const ref = mine.match(NODE_RE)[0]
  const seeder = code('deploy/seeder/Dockerfile').find((l) => /^FROM node:/.test(l))
  t.is(seeder.match(NODE_RE)[0], ref, 'same node reference as Dockerfile')
  const script = code('deploy/seeder/build-web.sh').find((l) => /^image="node:/.test(l))
  t.is(script.match(NODE_RE)[0], ref, 'same node reference as build-web.sh')
})

test('Dockerfile.web: the caddy stages and the xcaddy line equal Dockerfile.caddy', (t) => {
  const caddy = code('deploy/seeder/Dockerfile.caddy')
  for (const re of [/^FROM caddy:.*-builder-alpine@.*$/, /^FROM caddy:(?!.*builder).*$/, /xcaddy build/, /^COPY --from=builder \/usr\/bin\/caddy /]) {
    const want = caddy.find((l) => re.test(l))
    t.ok(want, 'Dockerfile.caddy has ' + re)
    t.ok(web.includes(want), 'Dockerfile.web repeats: ' + want)
  }
})

test('Dockerfile.web: every FROM is pinned by sha256', (t) => {
  const froms = web.filter((l) => /^FROM\s/.test(l))
  t.is(froms.length, 3, 'three stages')
  for (const f of froms) t.ok(/^FROM \S+@sha256:[0-9a-f]{64}( AS \w+)?$/.test(f), f)
})

test('Dockerfile.web: install without scripts and no fetch from the network at build', (t) => {
  t.ok(/npm ci [^&\n]*--ignore-scripts/.test(webText), 'npm ci has --ignore-scripts')
  t.ok(webText.includes('npm run export:web -w apps/app'), 'exports the web app')
  t.absent(/^\s*ADD\s/m.test(webText), 'no ADD')
  t.absent(/\b(curl|wget)\b/.test(webText), 'no curl or wget')
  t.absent(webText.includes('@latest'), 'no @latest')
  t.ok(/\[0-9a-f\]\{40\}/.test(webText), 'the commit must be 40 lower-case hex')
})

test('Dockerfile.web: version.json comes from the ARG and LICENSE ships with the image', (t) => {
  const lastFrom = web.map((l) => /^FROM /.test(l)).lastIndexOf(true)
  const finalStage = web.slice(lastFrom)
  const finalText = finalStage.join('\n')
  const printfAt = finalStage.findIndex((l) => l.includes('> /srv/web/version.json'))
  const argAt = finalStage.indexOf('ARG VARANDA_COMMIT')
  t.ok(argAt > 0 && argAt < printfAt, 'ARG VARANDA_COMMIT re-declared in the final stage, before the printf')
  t.ok(webText.includes('printf \'{"v":1,"commit":"%s"}\\n\' "$VARANDA_COMMIT" > /srv/web/version.json'), 'version.json written from the ARG')
  t.ok(/for f in index\.html varanda-node\.js sw\.js; do/.test(finalText), 'the three required files are checked')
  t.ok(finalText.includes('test -f "/srv/web/$f"'), 'each required file must be a regular file')
  // The node copy the page loads, named by the release mark of index.html.
  t.ok(finalText.includes('versao=$(sed -n \'s/.*<meta name="varanda-release" content="\\([0-9a-f]\\{16\\}\\)">.*/\\1/p\' /srv/web/index.html | head -n 1)'), 'the release is read from the index.html mark')
  t.ok(finalText.includes('{ [ -n "$versao" ] && test -f "/srv/web/varanda-node-$versao.js"; }'), 'the release node copy must be a regular file')
  t.ok(finalText.includes('find /srv/web ! -type f ! -type d -print -quit'), 'links and special files are refused')
  t.ok(finalText.includes('rm -rf /srv/web/.well-known'), 'the build .well-known is removed')
  t.ok(finalText.includes('chown -R 0:0 /srv/web'), 'root owns /srv/web, never the build user')
  t.ok(finalText.includes('find /srv/web -type d -exec chmod 0755 {} +'), 'directories 0755')
  t.ok(finalText.includes('find /srv/web -type f -exec chmod 0644 {} +'), 'files 0644: no setuid, setgid or group write')
  t.ok(web.includes('COPY LICENSE /srv/LICENSE'), 'LICENSE copied')
  t.ok(web.includes('COPY deploy/seeder/Caddyfile /etc/caddy/Caddyfile'), 'Caddyfile copied unchanged')
  t.ok(web.includes('COPY --from=app /src/apps/app/dist /srv/web'), 'dist copied to /srv/web')
  t.ok(webText.includes('PolyForm-Noncommercial-1.0.0 AND Apache-2.0'), 'licenses label')
  for (const rel of ['deploy/seeder/Dockerfile.web', 'deploy/seeder/Dockerfile.web.dockerignore', 'apps/cli/test/web-image.test.js']) {
    t.absent(read(rel).includes('\u2014'), 'no em dash in ' + rel)
  }
})

test('Dockerfile.web.dockerignore: starts with * and keeps secrets and modules out', (t) => {
  const ig = code('deploy/seeder/Dockerfile.web.dockerignore').filter((l) => l.trim())
  t.is(ig[0], '*', 'first rule is *')
  t.ok(ig.includes('**/node_modules'), 'excludes node_modules')
  t.ok(ig.includes('**/.env'), 'excludes .env')
  t.ok(ig.includes('**/.env.*'), 'excludes .env.* (Expo would inline EXPO_PUBLIC_* from them)')
  for (const a of ['!LICENSE', '!package.json', '!package-lock.json', '!apps/app', '!deploy/seeder/Caddyfile']) t.ok(ig.includes(a), 'admits ' + a)
})
