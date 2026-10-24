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
  t.alike(mutavel[0].trim().split(/\s+/).slice(2).sort(), ['/seeder', '/varanda.json'],
    '@mutavel excludes exactly /varanda.json and /seeder')

  // Every 404 is no-store: a missing file with an extension, or a missing
  // index.html behind an app route.
  const arquivo = block('@ausenteArquivo {')
  t.ok(arquivo.some((l) => l.trim() === 'path *.*'), '@ausenteArquivo covers paths with an extension')
  t.ok(arquivo.some((l) => l.trim() === 'not file {'), '@ausenteArquivo is a missing file')
  const app = block('@ausenteApp {')
  t.ok(app.some((l) => l.trim() === 'not path *.*'), '@ausenteApp covers app routes')
  t.ok(app.some((l) => l.trim() === 'not file /index.html {'), '@ausenteApp is a missing index.html')
  t.ok(lines.some((l) => l.trim() === 'header @ausenteArquivo Cache-Control "no-store"'), 'missing file -> no-store')
  t.ok(lines.some((l) => l.trim() === 'header @ausenteApp Cache-Control "no-store"'), 'missing index.html -> no-store')
  const mut = lines.findIndex((l) => l.trim() === 'header @mutavel Cache-Control "no-cache"')
  const aus = lines.findIndex((l) => l.trim() === 'header @ausenteArquivo Cache-Control "no-store"')
  t.ok(mut !== -1 && aus > mut, 'no-store comes after no-cache, so it wins')

  t.ok(lines.some((l) => l.trim() === 'header /manifest.webmanifest >Content-Type "application/manifest+json"'),
    'web manifest type pinned')
})

test('Caddyfile: SPA only for paths without an extension, real 404s otherwise', (t) => {
  t.ok(block('@semExtensao {').some((l) => l.trim() === 'not path *.*'), '@semExtensao is not path *.*')
  t.ok(lines.some((l) => l.trim() === 'rewrite @semExtensao /index.html'), 'rewrite @semExtensao /index.html')
  t.is(count('file_server'), 1, 'exactly one file_server')
  t.ok(lines.some((l) => l.trim() === 'root * /srv/web'), 'root * /srv/web')
  t.absent(fs.readFileSync(CADDYFILE, 'utf8').includes('try_files'), 'no try_files anywhere')
})
