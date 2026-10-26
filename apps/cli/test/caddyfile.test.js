const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../../..')
const CADDYFILE = path.join(repoRoot, 'deploy/seeder/Caddyfile')

// The production Caddyfile, checked with line and string rules (no Caddy in
// the test run). Comment lines are dropped so prose cannot satisfy or trip a rule.
const lines = fs.readFileSync(CADDYFILE, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
const code = lines.join('\n')

const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' wss://{$VARANDA_DOMAIN}; " +
  "manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; " +
  "object-src 'none'"

function count (s) {
  return code.split(s).length - 1
}

// The lines of the block opened by the first line equal to `head` (trimmed),
// up to its closing brace at the same indentation.
function block (head) {
  const start = lines.findIndex((l) => l.trim() === head)
  if (start === -1) return []
  const indent = lines[start].match(/^\s*/)[0]
  const end = lines.findIndex((l, i) => i > start && l === indent + '}')
  return lines.slice(start, end === -1 ? lines.length : end + 1)
}

test('Caddyfile: CSP unchanged, scripts only from self', (t) => {
  const csp = lines.filter((l) => /^\s*Content-Security-Policy\s/.test(l))
  t.is(csp.length, 1, 'one Content-Security-Policy line')
  t.is(csp[0].trim(), 'Content-Security-Policy "' + CSP + '"', 'CSP directive string')
  const scriptSrc = CSP.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'))
  t.ok(CSP.includes("script-src 'self' 'wasm-unsafe-eval'"), 'script-src self and wasm only')
  t.absent(scriptSrc.includes("'unsafe-inline'"), "no 'unsafe-inline' for scripts")
})

test('Caddyfile: existing blocks kept', (t) => {
  t.ok(lines.some((l) => l.trim() === 'admin off'), 'admin off')
  t.ok(block('handle /seeder {').length > 0, 'handle /seeder')
  const json = block('handle /varanda.json {')
  t.ok(json.length > 0, 'handle /varanda.json')
  t.ok(json.some((l) => l.trim() === 'header Cache-Control "no-store"'), '/varanda.json is no-store')
})

test('Caddyfile: cache headers', (t) => {
  // No long-lived cache anywhere: the deploy replaces www in place while
  // Caddy serves, so a torn file must never be pinned by the browser.
  t.is(count('immutable'), 0, 'no immutable')
  // The only max-age is the HSTS one, which is not a cache directive.
  t.absent(lines.some((l) => l.includes('max-age') && !/^\s*Strict-Transport-Security\s/.test(l)),
    'no max-age outside Strict-Transport-Security')
  t.absent(lines.some((l) => l.includes('@hashed')), 'no @hashed matcher')

  // Everything served from /srv/web, hashed names included, is no-cache.
  t.ok(lines.some((l) => l.trim() === 'header @mutavel Cache-Control "no-cache"'), '@mutavel is no-cache')
  const mutavel = block('@mutavel {').filter((l) => /^\s*not path\s/.test(l))
  t.is(mutavel.length, 1, 'one not path line in @mutavel')
  t.alike(mutavel[0].trim().split(/\s+/).slice(2).sort(), ['/account/*', '/index/*', '/media/*', '/seeder', '/varanda.json'],
    '@mutavel excludes exactly /varanda.json, /seeder, /account/*, /media/* and /index/*')

  // Every 404 is no-store: a missing file with an extension, or a missing
  // index.html behind an app route.
  const arquivo = block('@ausenteArquivo {')
  t.ok(arquivo.some((l) => l.trim() === 'path *.*'), '@ausenteArquivo covers paths with an extension')
  t.ok(arquivo.some((l) => l.trim() === 'not file {'), '@ausenteArquivo is a missing file')
  const app = block('@ausenteApp {')
  t.ok(app.some((l) => l.trim() === 'not path *.*'), '@ausenteApp covers app routes')
  t.ok(app.some((l) => /^\s*not path\s/.test(l) && l.trim().split(/\s+/).includes('/account/*')),
    '@ausenteApp leaves /account/* alone')
  t.ok(app.some((l) => /^\s*not path\s/.test(l) && l.trim().split(/\s+/).includes('/media/*')),
    '@ausenteApp leaves /media/* alone')
  t.ok(app.some((l) => /^\s*not path\s/.test(l) && l.trim().split(/\s+/).includes('/index/*')),
    '@ausenteApp leaves /index/* alone')
  const appPaths = app.filter((l) => /^\s*not path\s/.test(l) && !l.includes('*.*'))
  t.is(appPaths.length, 1, 'one not path list of routes in @ausenteApp')
  t.alike(appPaths[0].trim().split(/\s+/).slice(2).sort(), ['/account/*', '/index/*', '/media/*', '/seeder'],
    '@ausenteApp excludes exactly /seeder, /account/*, /media/* and /index/*')
  t.ok(app.some((l) => l.trim() === 'not file /index.html {'), '@ausenteApp is a missing index.html')
  t.ok(lines.some((l) => l.trim() === 'header @ausenteArquivo Cache-Control "no-store"'), 'missing file -> no-store')
  t.ok(lines.some((l) => l.trim() === 'header @ausenteApp Cache-Control "no-store"'), 'missing index.html -> no-store')
  const mut = lines.findIndex((l) => l.trim() === 'header @mutavel Cache-Control "no-cache"')
  const aus = lines.findIndex((l) => l.trim() === 'header @ausenteArquivo Cache-Control "no-store"')
  t.ok(mut !== -1 && aus > mut, 'no-store comes after no-cache, so it wins')

  t.ok(lines.some((l) => l.trim() === 'header /manifest.webmanifest >Content-Type "application/manifest+json"'),
    'web manifest type pinned')
})

// The account service (Google link, @username) answers /account/* from
// 127.0.0.1, before the SPA catch-all, without the client address and with
// its own Cache-Control (no-store): nothing from the app's cache rules.
test('Caddyfile: /account/* goes to the account service, before the SPA handle', (t) => {
  const account = block('handle /account/* {')
  t.ok(account.length > 0, 'handle /account/*')
  t.ok(account.some((l) => l.trim() === 'reverse_proxy 127.0.0.1:{$VARANDA_ACCOUNT_PORT} {'),
    'reverse proxy to VARANDA_ACCOUNT_PORT on loopback')
  t.ok(account.some((l) => l.trim() === 'header_up Host {upstream_hostport}'), 'Host rewritten to the upstream')
  t.ok(account.some((l) => l.trim() === 'header_up -X-Forwarded-For'), 'X-Forwarded-For stripped')
  t.ok(account.some((l) => l.trim() === 'header_up -X-Real-Ip'), 'X-Real-Ip stripped')
  t.absent(account.some((l) => /Cache-Control/.test(l)), 'no Cache-Control set by Caddy for /account/*')
  const start = lines.findIndex((l) => l.trim() === 'handle /account/* {')
  const spa = lines.findIndex((l) => l.trim() === 'handle {')
  t.ok(start !== -1 && spa > start, 'handle /account/* comes before the catch-all handle')
})

// Post media is served by the seeder on the WebSocket port, before the SPA
// catch-all, without the client address; Cache-Control comes from upstream.
test('Caddyfile: /media/* goes to the seeder, before the SPA handle', (t) => {
  const media = block('handle /media/* {')
  t.ok(media.length > 0, 'handle /media/*')
  t.ok(media.some((l) => l.trim() === 'reverse_proxy 127.0.0.1:{$VARANDA_WS_PORT} {'),
    'reverse proxy to VARANDA_WS_PORT on loopback')
  t.ok(media.some((l) => l.trim() === 'header_up Host {upstream_hostport}'), 'Host rewritten to the upstream')
  t.ok(media.some((l) => l.trim() === 'header_up -X-Forwarded-For'), 'X-Forwarded-For stripped')
  t.ok(media.some((l) => l.trim() === 'header_up -X-Real-Ip'), 'X-Real-Ip stripped')
  t.absent(media.some((l) => /Cache-Control/.test(l)), 'no Cache-Control set by Caddy for /media/*')
  const start = lines.findIndex((l) => l.trim() === 'handle /media/* {')
  const spa = lines.findIndex((l) => l.trim() === 'handle {')
  t.ok(start !== -1 && spa > start, 'handle /media/* comes before the catch-all handle')
})

// The engagement index is served by the seeder on the WebSocket port, before
// the SPA catch-all, without the client address; Cache-Control (no-store)
// comes from upstream and the CSP is unchanged (same-origin fetch).
test('Caddyfile: /index/* goes to the seeder, before the SPA handle', (t) => {
  const index = block('handle /index/* {')
  t.ok(index.length > 0, 'handle /index/*')
  t.ok(index.some((l) => l.trim() === 'reverse_proxy 127.0.0.1:{$VARANDA_WS_PORT} {'),
    'reverse proxy to VARANDA_WS_PORT on loopback')
  t.ok(index.some((l) => l.trim() === 'header_up Host {upstream_hostport}'), 'Host rewritten to the upstream')
  t.ok(index.some((l) => l.trim() === 'header_up -X-Forwarded-For'), 'X-Forwarded-For stripped')
  t.ok(index.some((l) => l.trim() === 'header_up -X-Real-Ip'), 'X-Real-Ip stripped')
  t.absent(index.some((l) => /Cache-Control/.test(l)), 'no Cache-Control set by Caddy for /index/*')
  const start = lines.findIndex((l) => l.trim() === 'handle /index/* {')
  const spa = lines.findIndex((l) => l.trim() === 'handle {')
  t.ok(start !== -1 && spa > start, 'handle /index/* comes before the catch-all handle')
  t.is(count('handle /index/* {'), 1, 'exactly one /index/* handle')
})

// Per-client rate limit (caddy-ratelimit, built by Dockerfile.caddy) on the
// two public seeder routes, keyed on the client address, which lives only in
// Caddy's memory: never logged, never sent upstream.
test('Caddyfile: /index/* and /media/* have a per-client rate limit', (t) => {
  t.ok(lines.some((l) => l.trim() === 'order rate_limit before reverse_proxy'), 'order rate_limit before reverse_proxy')
  t.is(count('rate_limit {'), 2, 'exactly two rate_limit blocks')
  const limits = { 'handle /index/* {': ['index', '20'], 'handle /media/* {': ['media', '120'] }
  for (const [head, [zone, events]] of Object.entries(limits)) {
    const b = block(head)
    const text = b.map((l) => l.trim())
    t.ok(text.includes('rate_limit {'), head + ' has rate_limit')
    t.ok(text.includes('zone ' + zone + ' {'), head + ' zone ' + zone)
    t.ok(text.includes('key {remote_host}'), head + ' keyed exactly on {remote_host}')
    t.ok(text.includes('events ' + events), head + ' events ' + events)
    t.ok(text.includes('window 10s'), head + ' window 10s')
    t.absent(text.some((l) => /^key\s/.test(l) && l !== 'key {remote_host}'), head + ' has no other key')
    const rl = text.indexOf('rate_limit {')
    const rp = text.findIndex((l) => l.startsWith('reverse_proxy '))
    t.ok(rl !== -1 && rp > rl, head + ' rate_limit comes before reverse_proxy')
    t.ok(text.includes('header_up -X-Forwarded-For') && text.includes('header_up -X-Real-Ip'), head + ' still strips client address headers')
  }
  t.absent(lines.some((l) => /^\s*log_key\b/.test(l)), 'log_key is never enabled')
})

// No access log. The only log block is the global one that EXCLUDES the
// rate_limit logger (it prints remote_ip on every 429); it must not set an
// output or any other option, and no site block has a log directive.
test('Caddyfile: no access log, and the rate_limit logger (client IP) is excluded', (t) => {
  const logLines = lines.map((l, i) => [l, i]).filter(([l]) => /^\s*log(\s|$)/.test(l))
  t.is(logLines.length, 1, 'exactly one log block in the file')
  t.is(logLines[0][0], '\tlog {', 'it is the global-options log block (one tab deep)')
  const b = block('log {')
  t.alike(b.slice(1, -1).map((l) => l.trim()), ['exclude http.handlers.rate_limit'], 'it only excludes http.handlers.rate_limit')
  const siteStart = lines.findIndex((l) => l.startsWith('{$VARANDA_DOMAIN}'))
  t.ok(siteStart > logLines[0][1], 'it sits in the global options, before the site block')
  t.absent(/\baccess\b|log_name|output\s/.test(code), 'no access log or log output')
})

test('Caddyfile: SPA only for paths without an extension, real 404s otherwise', (t) => {
  t.ok(block('@semExtensao {').some((l) => l.trim() === 'not path *.*'), '@semExtensao is not path *.*')
  t.ok(lines.some((l) => l.trim() === 'rewrite @semExtensao /index.html'), 'rewrite @semExtensao /index.html')
  t.is(count('file_server'), 1, 'exactly one file_server')
  t.ok(lines.some((l) => l.trim() === 'root * /srv/web'), 'root * /srv/web')
  t.absent(fs.readFileSync(CADDYFILE, 'utf8').includes('try_files'), 'no try_files anywhere')
})
