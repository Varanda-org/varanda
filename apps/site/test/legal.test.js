'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { PAGES, PUBLIC, loadLegal, render } = require('../scripts/render-legal.js')

const FIX = 'rode: node apps/site/scripts/render-legal.js'

function walk (dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const fileOf = (page) => path.join(PUBLIC, page.dir, 'index.html')
const read = (page) => fs.readFileSync(fileOf(page), 'utf8')

function attrs (tag) {
  const out = {}
  const re = /([a-zA-Z:_-]+)(?:\s*=\s*"([^"]*)")?/g
  const inner = tag.replace(/^<[a-zA-Z0-9]+/, '').replace(/\/?>$/, '')
  let m
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = m[2] === undefined ? '' : m[2]
  return out
}

// Visible text of an element's inner HTML: tags dropped, entities decoded.
function text (inner) {
  return inner.replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

test('legal pages: the files on disk are the render of apps/app/src/legal.js', async (t) => {
  const pages = render(await loadLegal())
  t.alike(Object.keys(pages).sort(), PAGES.map((p) => p.dir + '/index.html').sort())
  for (const [rel, html] of Object.entries(pages)) {
    const file = path.join(PUBLIC, rel)
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    t.ok(current === html, rel + ' em dia com legal.js (' + FIX + ')')
  }
})

// Reads the committed files without render(), so a renderer that drops or
// rewrites text fails here even when the files match its output.
test('legal pages: title, version, review note and every section of legal.js, in order', async (t) => {
  const legal = await loadLegal()
  t.is(legal.LEGAL_VERSION, 40)
  t.is(legal.LEGAL_DATE, '13/11/2026')
  for (const page of PAGES) {
    const doc = legal[page.doc]
    const html = read(page)
    t.is(text(/<h1>([\s\S]*?)<\/h1>/.exec(html)[1]), doc.title, page.dir + ': h1')
    t.is(text(/<title>([\s\S]*?)<\/title>/.exec(html)[1]), 'Varanda: ' + doc.title, page.dir + ': title')
    t.is(text(/<p class="legal__aviso">([\s\S]*?)<\/p>/.exec(html)[1]), legal.REVIEW_NOTE, page.dir + ': review note')
    const intro = text(/<p class="legal__intro">([\s\S]*?)<\/p>/.exec(html)[1])
    t.ok(intro.startsWith('Versão ' + legal.LEGAL_VERSION + ', de ' + legal.LEGAL_DATE + '.'), page.dir + ': version and date')
    const body = /<div class="legal__texto">([\s\S]*?)<\/div>/.exec(html)
    t.ok(body, page.dir + ': legal__texto block')
    const got = [...body[1].matchAll(/<(h2|p)>([\s\S]*?)<\/\1>/g)].map((m) => [m[1], text(m[2])])
    const want = doc.sections.flatMap((s) => [['h2', s.heading], ...s.paragraphs.map((p) => ['p', p])])
    t.alike(got, want, page.dir + ': ' + want.length + ' headings and paragraphs (' + FIX + ')')
  }
})

test('legal pages: language, forbidden elements, CSP and images', (t) => {
  const csp = [
    "default-src 'none'",
    "img-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ]
  for (const page of PAGES) {
    const html = read(page)
    t.ok(/<html[^>]*\slang="pt-BR"/.test(html), page.dir + ': lang="pt-BR"')
    for (const tag of ['script', 'form', 'iframe', 'object', 'embed', 'base']) {
      t.absent(new RegExp('<' + tag + '[\\s>/]', 'i').test(html), page.dir + ': no <' + tag + '>')
    }
    t.absent(/\sstyle\s*=/i.test(html), page.dir + ': no style attribute')
    t.absent(/\son[a-z]+\s*=/i.test(html), page.dir + ': no inline event handler')
    t.absent(html.includes('\u2014'), page.dir + ': no em dash')
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)
    t.ok(meta, page.dir + ': CSP meta present')
    t.alike(meta[1].split(';').map((d) => d.trim()).filter(Boolean).sort(), csp.slice().sort(), page.dir + ': CSP')
    t.is(/<link rel="canonical" href="([^"]+)"/.exec(html)[1], 'https://varanda.app/' + page.dir + '/', page.dir + ': canonical')
    for (const m of html.matchAll(/<img\s[^>]*>/g)) {
      const a = attrs(m[0])
      t.ok(a.width && a.height && a.alt && a.alt.trim() !== '', page.dir + ': dimensions and alt for ' + a.src)
    }
  }
})

function urlsOf (source) {
  const urls = []
  for (const m of source.matchAll(/\s(?:href|src)="([^"]*)"/g)) urls.push(m[1])
  return urls
}

const isAbsolute = (u) => /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(u)

test('legal pages: local URLs are relative, resolve under public/, and fragments hit an id', (t) => {
  for (const page of PAGES) {
    const html = read(page)
    const dir = path.dirname(fileOf(page))
    for (const u of urlsOf(html)) {
      if (isAbsolute(u)) continue
      t.absent(u.startsWith('/'), page.dir + ': not root-relative: ' + u)
      const [target, fragment] = u.split('#')
      let file = target === '' ? fileOf(page) : path.resolve(dir, target)
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
      const ok = file.startsWith(PUBLIC + path.sep) && fs.existsSync(file)
      t.ok(ok, page.dir + ': file exists: ' + u)
      if (ok && fragment !== undefined) {
        t.ok(fs.readFileSync(file, 'utf8').includes('id="' + fragment + '"'), page.dir + ': id exists for ' + u)
      }
    }
  }
})

test('legal pages: absolute URLs are https and on the site allowlist', (t) => {
  for (const page of PAGES) {
    const html = read(page)
    const found = new Set(html.match(/(?:https?:)?\/\/[^\s"'<>]+/g) || [])
    for (const u of found) {
      const url = new URL(u, 'http://invalid.example')
      t.is(url.protocol, 'https:', page.dir + ': https: ' + u)
      const ok = url.host === 'varanda.app' ||
        (url.host === 'github.com' && url.pathname.startsWith('/Varanda-org/varanda/'))
      t.ok(ok, page.dir + ': allowed: ' + u)
    }
  }
})

test('the home page links to both legal pages', (t) => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
  for (const page of PAGES) {
    t.ok(html.includes('href="' + page.dir + '/"'), 'index.html links to ' + page.dir + '/')
  }
})

// site.test.js checks index.html and these tests check the legal pages, so a
// new HTML page has to join one of them before it can be published.
test('every HTML file under public/ is checked by a site test', (t) => {
  const known = ['index.html', ...PAGES.map((p) => p.dir + '/index.html')].sort()
  const found = walk(PUBLIC).filter((f) => f.endsWith('.html')).map((f) => path.relative(PUBLIC, f).split(path.sep).join('/')).sort()
  t.alike(found, known)
})
