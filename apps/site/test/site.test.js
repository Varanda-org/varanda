'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const PUBLIC = path.join(__dirname, '..', 'public')
const WORKFLOW = path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'site.yml')

const read = (...p) => fs.readFileSync(path.join(PUBLIC, ...p), 'utf8')
const size = (...p) => fs.statSync(path.join(PUBLIC, ...p)).size

function walk (dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const html = read('index.html')
const css = read('styles.css')

function attrs (tag) {
  const out = {}
  const re = /([a-zA-Z:_-]+)(?:\s*=\s*"([^"]*)")?/g
  const inner = tag.replace(/^<[a-zA-Z0-9]+/, '').replace(/\/?>$/, '')
  let m
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = m[2] === undefined ? '' : m[2]
  return out
}

function metas () {
  const out = {}
  for (const m of html.matchAll(/<meta\s[^>]*>/g)) {
    const a = attrs(m[0])
    const key = a.property || a.name || a['http-equiv']
    if (key) out[key.toLowerCase()] = a.content
  }
  return out
}

const meta = metas()

test('index.html: language and forbidden elements', (t) => {
  t.ok(/<html[^>]*\slang="pt-BR"/.test(html), 'lang="pt-BR"')
  for (const tag of ['script', 'form', 'iframe', 'object', 'embed', 'base']) {
    t.absent(new RegExp('<' + tag + '[\\s>/]', 'i').test(html), 'no <' + tag + '>')
  }
  t.absent(/\sstyle\s*=/i.test(html), 'no style attribute')
  t.absent(/\son[a-z]+\s*=/i.test(html), 'no inline event handler')
})

test('CSP meta is the declared policy, compared as a set of directives', (t) => {
  const expected = [
    "default-src 'none'",
    "img-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ]
  const csp = meta['content-security-policy']
  t.ok(csp, 'CSP meta present')
  const got = csp.split(';').map((d) => d.trim()).filter(Boolean).sort()
  t.alike(got, expected.slice().sort())
})

test('every img has dimensions and alt text (or is decorative)', (t) => {
  const imgs = [...html.matchAll(/<img\s[^>]*>/g)].map((m) => attrs(m[0]))
  t.ok(imgs.length > 0, 'there are images (' + imgs.length + ')')
  for (const a of imgs) {
    t.ok(a.width && a.height, 'width and height: ' + a.src)
    const decorative = a.alt === '' && a['aria-hidden'] === 'true'
    t.ok(decorative || (a.alt && a.alt.trim() !== ''), 'alt: ' + a.src)
  }
})

function urlsOf (source) {
  const urls = []
  for (const m of source.matchAll(/\s(?:href|src)="([^"]*)"/g)) urls.push(m[1])
  for (const m of source.matchAll(/\ssrcset="([^"]*)"/g)) {
    for (const part of m[1].split(',')) urls.push(part.trim().split(/\s+/)[0])
  }
  return urls
}

const isAbsolute = (u) => /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(u)

test('local URLs resolve under public/, relative, and fragments hit an id', (t) => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
  const urls = urlsOf(html)
  for (const u of urls) {
    if (isAbsolute(u)) continue
    t.absent(u.startsWith('/'), 'not root-relative: ' + u)
    if (u.startsWith('#')) {
      t.ok(ids.has(u.slice(1)), 'id exists for ' + u)
      continue
    }
    const file = path.join(PUBLIC, u.split(/[#?]/)[0])
    t.ok(file.startsWith(PUBLIC + path.sep) && fs.existsSync(file), 'file exists: ' + u)
  }
})

test('styles.css local url() references resolve', (t) => {
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    t.absent(isAbsolute(m[1]) || m[1].startsWith('/'), 'local: ' + m[1])
    t.ok(fs.existsSync(path.join(PUBLIC, m[1])), 'file exists: ' + m[1])
  }
})

test('absolute URLs are https and on the allowlist', (t) => {
  const found = new Set(html.match(/(?:https?:)?\/\/[^\s"'<>]+/g) || [])
  t.ok(found.size > 0, 'absolute URLs found (' + found.size + ')')
  for (const u of found) {
    const url = new URL(u, 'http://invalid.example')
    t.is(url.protocol, 'https:', 'https: ' + u)
    // bora.varanda.app is the hosted app the buttons open: only the root, so no tracking parameter gets in
    const ok = url.host === 'varanda.app' ||
      u === 'https://bora.varanda.app/' ||
      (url.host === 'github.com' &&
        (url.pathname === '/Varanda-org/varanda' || url.pathname.startsWith('/Varanda-org/varanda/')))
    t.ok(ok, 'allowed: ' + u)
  }
})

test('calls to action open the hosted install', (t) => {
  const links = html.match(/href="https:\/\/bora\.varanda\.app\/"/g) || []
  t.is(links.length, 2, 'exactly two links to the hosted app, each next to a limited-seats notice')
  for (const id of ['cta-inicio', 'cta-gente']) {
    const tag = new RegExp('<a\\s[^>]*\\bid="' + id + '"[^>]*>').exec(html)
    t.ok(tag, 'link #' + id)
    const a = attrs(tag[0])
    t.is(a.href, 'https://bora.varanda.app/', id + ' opens the hosted app')
    t.ok(a['aria-describedby'] && html.includes('id="' + a['aria-describedby'] + '"'), id + ' describedby points to an existing id')
  }
  t.ok(html.split('Vagas limitadas nesta abertura').length - 1 >= 2, 'the limited-seats notice appears at least twice')
})

test('copy rules', (t) => {
  const banned = [
    'impossível de derrubar', 'ninguém pode censurar', '100% segura', 'totalmente anônima',
    'sem moderação', 'nunca sai do ar', 'avisaremos', 'piloto em breve', 'repassa',
    'como num torrent', 'utm_', 'instagram.com', 'mailto:', 'target=',
    // the page cannot promise more than the app does when it is full (apps/app/src/account.js)
    'código aberto', 'notificaremos', 'avisa na hora', 'muito perto de abrir', 'nada sobre você fica guardado'
  ]
  const lower = html.toLowerCase()
  for (const b of banned) t.absent(lower.includes(b), 'absent: ' + b)
  t.absent(html.includes('\u2014'), 'no em dash in index.html')
  t.absent(css.includes('\u2014'), 'no em dash in styles.css')
  for (const id of ['inicio', 'por-que', 'a-varanda', 'como-e-usar', 'o-que-muda', 'gente', 'perguntas', 'para-desenvolvedores', 'contato', 'privacidade', 'termos']) {
    t.ok(html.includes('id="' + id + '"'), 'id exists: ' + id)
  }
})

test('Open Graph and Twitter tags', (t) => {
  const image = 'https://varanda.app/assets/og-varanda.jpg'
  t.ok(meta['og:title'], 'og:title')
  t.ok(meta['og:description'], 'og:description')
  t.is(meta['og:url'], 'https://varanda.app/')
  t.is(meta['og:image'], image)
  t.ok(meta['og:image:alt'], 'og:image:alt')
  t.is(meta['og:locale'], 'pt_BR')
  t.is(meta['og:type'], 'website')
  t.is(meta['og:site_name'], 'Varanda')
  t.is(meta['og:image:width'], '1200')
  t.is(meta['og:image:height'], '630')
  t.is(meta['twitter:card'], 'summary_large_image')
  t.is(meta['twitter:image'], meta['og:image'], 'twitter:image equals og:image')
  t.ok(meta['twitter:title'], 'twitter:title')
  t.ok(meta['twitter:description'], 'twitter:description')
  t.is(/<link rel="canonical" href="([^"]+)"/.exec(html)[1], 'https://varanda.app/', 'canonical')
  t.ok(fs.existsSync(path.join(PUBLIC, 'assets', 'og-varanda.jpg')), 'og-varanda.jpg exists in public/assets')
})

test('styles.css: no imports, no remote url(), reduced motion, pause control', (t) => {
  t.absent(/@import/i.test(css), 'no @import')
  t.absent(/url\(\s*["']?[a-z][a-z0-9+.-]*:/i.test(css), 'no url() with a scheme')
  t.absent(/url\(\s*["']?\/\//.test(css), 'no protocol-relative url()')
  t.ok(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/.test(css), 'prefers-reduced-motion: reduce block')
  t.ok(/<input[^>]*type="checkbox"[^>]*id="pausar"|<input[^>]*id="pausar"[^>]*type="checkbox"/.test(html), '#pausar checkbox')
  t.ok(/<label[^>]*for="pausar"/.test(html), 'label for #pausar')
  t.ok(/\.pausar:checked[^{]*\{[^}]*animation-play-state:\s*paused/.test(css), 'checked pauses the animation')
})

test('every SVG under public/ is inert', (t) => {
  const svgs = walk(PUBLIC).filter((f) => f.endsWith('.svg'))
  t.ok(svgs.length > 0, 'svgs found (' + svgs.length + ')')
  for (const f of svgs) {
    const s = fs.readFileSync(f, 'utf8')
    const name = path.relative(PUBLIC, f)
    t.absent(/<script/i.test(s), name + ': no <script')
    t.absent(/<foreignObject/i.test(s), name + ': no <foreignObject')
    t.absent(/\son[a-z]+\s*=/i.test(s), name + ': no on...= attribute')
    for (const m of s.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
      t.ok(m[1].startsWith('#'), name + ': only local href, got ' + m[1])
    }
  }
})

// Budgets (bytes). Measured on 2026-11-07 (after the four app screens), each set about 25% above:
//   index.html 21843 + styles.css 14704 = 36547  -> 46000
//   all of public/ = 669117 with og-varanda.jpg and assets/screens/ -> 837000
const BUDGET_PAGE = 46000
const BUDGET_TOTAL = 837000
const BUDGET_OG = 200 * 1024

test('size budgets', (t) => {
  const page = size('index.html') + size('styles.css')
  t.ok(page <= BUDGET_PAGE, 'index.html + styles.css ' + page + ' <= ' + BUDGET_PAGE)
  const total = walk(PUBLIC).reduce((n, f) => n + fs.statSync(f).size, 0)
  t.ok(total <= BUDGET_TOTAL, 'public/ total ' + total + ' <= ' + BUDGET_TOTAL)
  const og = path.join(PUBLIC, 'assets', 'og-varanda.jpg')
  if (fs.existsSync(og)) {
    const n = fs.statSync(og).size
    t.ok(n <= BUDGET_OG, 'og-varanda.jpg ' + n + ' <= ' + BUDGET_OG)
  } else {
    t.fail('og-varanda.jpg missing')
  }
})

// The page has no role="img" today. If one comes back, it needs a label and
// nothing focusable or interactive inside.
test('every role="img" element has a label and contains nothing interactive', (t) => {
  const starts = [...html.matchAll(/<([a-z0-9]+)\s[^>]*\brole="img"[^>]*>/g)]
  for (const m of starts) {
    const a = attrs(m[0])
    t.ok(a['aria-label'] && a['aria-label'].trim() !== '', 'aria-label on ' + m[0].slice(0, 60))
    // the element's inner HTML: walk the tags from the start tag to its matching close
    const tag = m[1]
    const open = new RegExp('<' + tag + '[\\s>]', 'g')
    const close = new RegExp('</' + tag + '>', 'g')
    let depth = 1
    let i = m.index + m[0].length
    let end = -1
    while (depth > 0) {
      open.lastIndex = i
      close.lastIndex = i
      const o = open.exec(html)
      const c = close.exec(html)
      if (!c) break
      if (o && o.index < c.index) { depth++; i = o.index + 1 } else { depth--; i = c.index + 1; end = c.index }
    }
    t.ok(end > 0, 'closing tag found')
    const inner = html.slice(m.index + m[0].length, end)
    for (const bad of ['a', 'button', 'input', 'select', 'textarea', 'label']) {
      t.absent(new RegExp('<' + bad + '[\\s>/]', 'i').test(inner), 'no <' + bad + '> inside ' + a['aria-label'].slice(0, 40))
    }
    t.absent(/\stabindex\s*=/i.test(inner), 'no tabindex inside ' + a['aria-label'].slice(0, 40))
  }
})

test('app screens: exact inventory, budgets and markup', (t) => {
  const dir = path.join(PUBLIC, 'assets', 'screens')
  const stems = ['a-rua', 'diario', 'conversas', 'conversa']
  const expected = []
  for (const s of stems) expected.push(s + '-402.webp', s + '-804.webp')
  t.alike(fs.readdirSync(dir).sort(), expected.slice().sort(), 'exactly the eight screen files')
  for (const f of expected) {
    const buf = fs.readFileSync(path.join(dir, f))
    const cap = f.endsWith('-402.webp') ? 45 * 1024 : 120 * 1024
    t.ok(buf.length <= cap, f + ' ' + buf.length + ' <= ' + cap)
    t.is(buf.toString('latin1', 0, 4), 'RIFF', f + ' RIFF header')
    t.is(buf.toString('latin1', 8, 12), 'WEBP', f + ' WEBP header')
    // simple lossy WebP: no VP8X header, so no room for EXIF or XMP chunks
    t.is(buf.toString('latin1', 12, 16), 'VP8 ', f + ' lossy VP8 without metadata chunks')
    const vp8 = buf.readUInt32LE(16)
    t.is(buf.readUInt32LE(4), buf.length - 8, f + ' RIFF size matches the file')
    t.is(20 + vp8 + (vp8 % 2), buf.length, f + ' one VP8 chunk fills the file')
    const w = buf.readUInt16LE(26) & 0x3fff
    const h = buf.readUInt16LE(28) & 0x3fff
    t.alike([w, h], f.endsWith('-402.webp') ? [402, 874] : [804, 1748], f + ' pixel size')
  }

  const imgs = (html.match(/<img\b[^>]*>/gi) || []).map(attrs).filter((a) => (a.src || '').startsWith('assets/screens/'))
  t.is(imgs.length, 4, 'four screen images')
  stems.forEach((s, i) => {
    const a = imgs[i] || {}
    t.is(a.src, 'assets/screens/' + s + '-402.webp', s + ' src')
    t.ok((a.srcset || '').includes('assets/screens/' + s + '-402.webp 402w'), s + ' srcset 402w')
    t.ok((a.srcset || '').includes('assets/screens/' + s + '-804.webp 804w'), s + ' srcset 804w')
    t.ok((a.sizes || '').length > 0, s + ' sizes')
    t.is(a.width, '402', s + ' width')
    t.is(a.height, '874', s + ' height')
    t.is(a.loading, 'lazy', s + ' loading')
    t.ok(/exemplo/i.test(a.alt || ''), s + ' alt says exemplo')
  })

  const captions = (html.match(/<figcaption>([^<]*)<\/figcaption>/g) || []).map((c) => c.replace(/<\/?figcaption>/g, ''))
  t.alike(captions, [
    'A Rua: as publicações de quem você segue, em ordem de chegada.',
    'Seu Diário: o seu perfil e as suas publicações.',
    'As Conversas: mensagens privadas e comunidades, numa lista só.',
    'Uma conversa: fotos e recados só entre duas pessoas, cifrados de ponta a ponta.'
  ], 'figcaptions in order')

  const strip = (html.match(/<div\b[^>]*>/gi) || []).map((tag) => ({ tag, a: attrs(tag) })).find((x) => /(^|\s)telas(\s|$)/.test(x.a.class || ''))
  t.ok(strip, 'strip element found')
  if (strip) {
    t.is(strip.a.role, 'region', 'strip role')
    t.ok((strip.a['aria-label'] || '').length > 0, 'strip aria-label')
    t.is(strip.a.tabindex, '0', 'strip focusable')
  }
  t.ok(css.includes('.telas') && css.includes('scroll-snap-type'), 'styles.css keeps the .telas scroll-snap carousel')
  t.ok(html.includes('As pessoas e as publicações destas telas são de exemplo.'), 'intro says the content is example')
})

test('robots.txt exists and there is no CNAME in public/', (t) => {
  t.ok(fs.existsSync(path.join(PUBLIC, 'robots.txt')), 'robots.txt')
  t.absent(fs.existsSync(path.join(PUBLIC, 'CNAME')), 'no CNAME (the domain lives in the Pages settings, docs/site.md)')
})

// site.yml, checked with line and regex rules (no YAML parser available).
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

test('site.yml: actions pinned to the expected commits', (t) => {
  const pins = {
    'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/upload-pages-artifact': 'fc324d3547104276b827a68afc52ff2a11cc49c9',
    'actions/deploy-pages': '368f82528645a54fb793d4d04e342629a3f51346'
  }
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1])
  t.is(uses.length, 3, 'three uses: lines')
  for (const u of uses) {
    const [name, ref] = u.split('@')
    t.ok(/^[0-9a-f]{40}$/.test(ref), 'pinned to a 40-hex SHA: ' + u)
    t.is(ref, pins[name], 'expected pin for ' + name)
  }
  t.alike(uses.map((u) => u.split('@')[0]).sort(), Object.keys(pins).sort())
})

test('site.yml: permissions, triggers, checkout, path and branch guard', (t) => {
  const top = block(/^permissions:/, /^\S/)
  const topLines = top.split('\n').slice(1).filter((l) => l.trim() !== '').map((l) => l.trim())
  t.alike(topLines, ['contents: read'], 'top-level permissions are contents: read only')
  const deploy = block(/^ {2}deploy:/, /^ {2}\S/)
  const build = block(/^ {2}build:/, /^ {2}\S/)
  t.ok(deploy && build, 'both jobs found')
  const count = (s, re) => (s.match(re) || []).length
  for (const re of [/pages:\s*write/g, /id-token:\s*write/g]) {
    t.is(count(deploy, re), 1, 'in the deploy job: ' + re)
    t.is(count(code, re), count(deploy, re), 'nowhere else: ' + re)
  }
  t.absent(/pull_request/.test(code), 'no pull_request or pull_request_target trigger')
  t.ok(/uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\s*\n\s+persist-credentials:\s*false/.test(code), 'checkout has persist-credentials: false')
  t.ok(/path:\s*apps\/site\/public\s*$/m.test(code), 'upload path is apps/site/public')
  const guard = /^\s+if:\s*github\.ref == 'refs\/heads\/main'\s*$/m
  t.ok(guard.test(build), 'build job is guarded')
  t.ok(guard.test(deploy), 'deploy job is guarded')
})
