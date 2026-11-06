'use strict'

// Writes public/termos/index.html and public/privacidade/index.html from the
// legal text the app shows for acceptance (apps/app/src/legal.js), so a store
// listing can link to the policy itself. The site keeps no text of its own:
// test/legal.test.js fails when the pages drift from legal.js.
//
// Usage: node apps/site/scripts/render-legal.js [--check]
//   (no flag)  write both pages
//   --check    compare with the files on disk; writes nothing, exits 1 on any difference

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const PUBLIC = path.join(__dirname, '..', 'public')
const LEGAL = path.join(__dirname, '..', '..', 'app', 'src', 'legal.js')

const CSP = "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'"

// legal.js only links to the project (apps/app/test/legal.test.js). Any other
// address stays plain text, and the site's URL allowlist rejects it.
const PROJECT_URL = /https:\/\/github\.com\/Varanda-org\/varanda\/[A-Za-z0-9/_-]*/g

const PAGES = [
  { dir: 'termos', doc: 'TERMS', nav: 'Termos de uso' },
  { dir: 'privacidade', doc: 'PRIVACY', nav: 'Privacidade' }
]

function loadLegal () {
  return import(pathToFileURL(LEGAL).href)
}

function escape (text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function linked (text) {
  return escape(text).replace(PROJECT_URL, (url) => '<a href="' + url + '">' + url + '</a>')
}

function seeAlso (page, legal) {
  if (page.doc === 'TERMS') {
    return 'Veja também a <a href="../privacidade/">' + escape(legal.PRIVACY.title) + '</a>.'
  }
  return 'Veja também os <a href="../termos/">' + escape(legal.TERMS.title) + '</a>. ' +
    'A visita a este site tem regras próprias, na <a href="../#privacidade">página inicial</a>.'
}

function renderPage (page, legal) {
  const doc = legal[page.doc]
  const title = 'Varanda: ' + doc.title
  const description = doc.title + ' da Varanda, versão ' + legal.LEGAL_VERSION + ', o texto que o app apresenta para aceite.'
  const nav = PAGES.map((p) => {
    const current = p.dir === page.dir ? ' aria-current="page"' : ''
    return '          <li><a href="../' + p.dir + '/"' + current + '>' + p.nav + '</a></li>'
  })
  const body = doc.sections.flatMap((section) => [
    '      <h2>' + escape(section.heading) + '</h2>',
    ...section.paragraphs.map((paragraph) => '      <p>' + linked(paragraph) + '</p>')
  ])
  return [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="theme-color" content="#f7b267">',
    '<title>' + escape(title) + '</title>',
    '<meta name="description" content="' + escape(description) + '">',
    '<link rel="canonical" href="https://varanda.app/' + page.dir + '/">',
    '<link rel="icon" href="../favicon.svg" type="image/svg+xml">',
    '<link rel="icon" href="../favicon-32.png" type="image/png" sizes="32x32">',
    '<link rel="apple-touch-icon" href="../apple-touch-icon.png">',
    '<link rel="stylesheet" href="../styles.css">',
    '</head>',
    '<body>',
    '<!-- Gerado por apps/site/scripts/render-legal.js a partir de apps/app/src/legal.js. Não edite à mão. -->',
    '<a class="pular" href="#conteudo">Pular para o conteúdo</a>',
    '',
    '<header class="legal__topo">',
    '  <div class="dentro">',
    '    <a class="topo__logo" href="../"><img src="../assets/logo-lockup.svg" alt="Varanda, página inicial" width="785" height="224"></a>',
    '  </div>',
    '</header>',
    '',
    '<main id="conteudo" class="legal">',
    '  <div class="dentro dentro--estreito">',
    '    <h1>' + escape(doc.title) + '</h1>',
    '    <p class="legal__aviso">' + escape(legal.REVIEW_NOTE) + '</p>',
    '    <p class="legal__intro">Versão ' + escape(legal.LEGAL_VERSION) + ', de ' + escape(legal.LEGAL_DATE) +
      '. Este é o texto que o app apresenta antes de entrar e que fica em Ajustes, no item Termos e privacidade. O aceite é feito no app. ' +
      seeAlso(page, legal) + '</p>',
    '    <div class="legal__texto">',
    ...body,
    '    </div>',
    '  </div>',
    '</main>',
    '',
    '<footer class="rodape">',
    '  <div class="dentro rodape__dentro">',
    '    <img src="../assets/logo-mark.svg" alt="Símbolo da Varanda" width="56" height="56">',
    '    <div>',
    '      <nav class="rodape__nav" aria-label="Rodapé">',
    '        <ul>',
    '          <li><a href="../">Página inicial</a></li>',
    ...nav,
    '        </ul>',
    '      </nav>',
    '      <p class="rodape__nome">Varanda. A conversa merece uma varanda.</p>',
    '      <p>Código-fonte disponível (PolyForm Noncommercial 1.0.0).</p>',
    '    </div>',
    '  </div>',
    '</footer>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

// { 'termos/index.html': html, 'privacidade/index.html': html }
function render (legal) {
  const out = {}
  for (const page of PAGES) out[page.dir + '/index.html'] = renderPage(page, legal)
  return out
}

async function main () {
  const check = process.argv.includes('--check')
  const pages = render(await loadLegal())
  let stale = 0
  for (const [rel, html] of Object.entries(pages)) {
    const file = path.join(PUBLIC, rel)
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    if (current === html) continue
    if (check) {
      stale++
      console.error('desatualizado: apps/site/public/' + rel)
      continue
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, html)
    console.log('gravado: apps/site/public/' + rel)
  }
  if (stale) {
    console.error('rode: node apps/site/scripts/render-legal.js')
    process.exitCode = 1
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}

module.exports = { PAGES, PUBLIC, loadLegal, render }
