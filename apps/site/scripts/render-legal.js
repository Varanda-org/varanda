'use strict'

// Writes public/termos/index.html and public/privacidade/index.html from the
// legal text the app shows for acceptance (apps/app/src/legal.js), so a store
// listing can link to the policy itself. The site keeps no text of its own:
// test/legal.test.js fails when the pages drift from legal.js.
//
// Also writes two informational pages for the store listing (excluir-conta and
// seguranca-infantil) through the same shell. Their retention paragraphs are
// copied from legal.js by exact prefix, and the render throws if one is gone.
//
// Usage: node apps/site/scripts/render-legal.js [--check]
//   (no flag)  write the pages
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

const APP_URL = 'https://bora.varanda.app/'
const CONTACT = 'contato@varanda.app'

// Paragraphs of legal.js copied verbatim into excluir-conta.
const RETENTION_PREFIXES = [
  { doc: 'TERMS', prefix: 'Você pode excluir a conta em Ajustes' },
  { doc: 'TERMS', prefix: 'Excluir a conta, a seu pedido' },
  { doc: 'PRIVACY', prefix: 'Ao excluir a conta, o número do celular lacrado' },
  { doc: 'TERMS', prefix: 'Você pode apagar uma publicação' }
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

function paragraphStarting (legal, { doc, prefix }) {
  const found = legal[doc].sections.flatMap((s) => s.paragraphs).filter((p) => p.startsWith(prefix))
  if (found.length !== 1) {
    throw new Error('legal.js: esperado um parágrafo em ' + doc + ' começando com "' + prefix + '", achei ' + found.length)
  }
  return found[0]
}

const INFO_PAGES = [
  {
    dir: 'excluir-conta',
    nav: 'Excluir conta',
    title: 'Excluir sua conta no Varanda',
    description: 'Como pedir a exclusão da conta no Varanda, sem instalar o app, e o que acontece com os dados.',
    main (legal) {
      const [ajustes, pedido, apagado, semExcluir] = RETENTION_PREFIXES.map((entry) => paragraphStarting(legal, entry))
      return [
        '      <h1>Excluir sua conta no Varanda</h1>',
        '      <p class="legal__intro">O app é o Varanda, publicado pela associação que responde por ele e pelos serviços compartilhados (veja os <a href="../termos/">Termos de Uso</a>). Esta página explica como pedir a exclusão da conta sem instalar nem reinstalar o app, com ou sem a passkey.</p>',
        '      <div class="legal__texto">',
        '      <h2>Como pedir a exclusão</h2>',
        '      <ol>',
        '        <li>Abra <a href="' + APP_URL + '">' + APP_URL + '</a> num navegador. Não é preciso instalar nada.</li>',
        '        <li>Entre com a sua passkey.</li>',
        '        <li>Abra Ajustes.</li>',
        '        <li>Toque em Excluir conta.</li>',
        '        <li>Digite o seu @nome.</li>',
        '        <li>Confirme com a passkey.</li>',
        '      </ol>',
        '      <p>O mesmo caminho existe dentro do app, em Ajustes, na tela Excluir conta.</p>',
        '      <h2>Sem a passkey</h2>',
        '      <p>Se você não tem mais a passkey, abra ' + APP_URL + ' ou o app, toque em Excluir conta sem a passkey na tela de entrada, digite o seu @nome e o celular brasileiro que você confirmou e informe o código que chega por SMS. O código só registra o pedido, ele não exclui nada. Para seguir, escreva para ' + CONTACT + ' com o seu @nome. Nada acontece antes disso. Depois que a equipe confirmar o pedido, a conta fica marcada para exclusão e a exclusão acontece na data agendada. Até lá, a conta continua funcionando, e dá para cancelar em Ajustes, na tela Excluir conta, num aparelho em que a conta está aberta.</p>',
        '      <p>Se você perdeu o aparelho, entre em outro aparelho com a passkey sincronizada ou com o código de recuperação e peça a exclusão por lá.</p>',
        '      <p>O código do SMS vai para o número, não para o aparelho: quem recuperou o número junto à operadora consegue usar o caminho acima.</p>',
        '      <p>Se você entrou com o Google e nunca confirmou um celular, escreva para ' + CONTACT + ' pelo e-mail da conta. A equipe confere o pedido e agenda a mesma exclusão, com 7 dias de espera.</p>',
        '      <p>Sem nenhuma passkey, sem o código de recuperação e sem o número confirmado, a conta não pode ser recuperada e a equipe não tem como confirmar que ela é sua. Você ainda pode escrever para ' + CONTACT + ' com o seu @nome. O que acontece com os dados é o mesmo, descrito abaixo.</p>',
        '      <h2>O que acontece com os seus dados</h2>',
        '      <p>' + linked(ajustes) + '</p>',
        '      <p>' + linked(pedido) + '</p>',
        '      <p>' + linked(apagado) + '</p>',
        '      <h2>Apagar dados sem excluir a conta</h2>',
        '      <p>Para apagar uma publicação, abra o menu dela, no app ou em <a href="' + APP_URL + '">' + APP_URL + '</a>, e toque em Apagar. Para apagar uma versão do perfil, abra o seu perfil e toque em Apagar versão.</p>',
        '      <p>' + linked(semExcluir) + '</p>',
        '      </div>'
      ]
    }
  },
  {
    dir: 'seguranca-infantil',
    nav: 'Segurança infantil',
    title: 'Padrões de segurança infantil do Varanda',
    description: 'Os padrões do Varanda contra abuso e exploração sexual infantil e como denunciar.',
    main () {
      return [
        '      <h1>Padrões de segurança infantil do Varanda</h1>',
        '      <p class="legal__intro">Esta página descreve o que o Varanda, a rede social P2P publicada pela associação que responde por ela, faz e não faz para proteger crianças e adolescentes.</p>',
        '      <div class="legal__texto">',
        '      <h2>Quem pode usar</h2>',
        '      <p>O Varanda é para pessoas com 16 anos ou mais. Na web hospedada e no app ligado à instalação da associação, a idade é confirmada antes de a conta ser liberada.</p>',
        '      <h2>O que é proibido</h2>',
        '      <p>Material de abuso e exploração sexual infantil é proibido no Varanda, em qualquer forma e em qualquer lugar da rede, inclusive em mensagens e grupos.</p>',
        '      <h2>Como denunciar</h2>',
        '      <p>No app, toque em Denunciar na publicação, na conta ou na mensagem e escolha o motivo conteúdo ilegal. A denúncia vai para a moderação da associação.</p>',
        '      <h2>O que acontece depois</h2>',
        '      <p>Denúncias por conteúdo ilegal sempre são decididas por uma pessoa, nunca só pela automação. Quando o diário é bloqueado, ele sai dos semeadores da associação, que são os serviços que guardam e distribuem as cópias, assim que a associação publica a lista de moderação assinada.</p>',
        '      <p>O Varanda é uma rede P2P: cópias que ficam em aparelhos de terceiros ou em apps modificados não estão ao alcance da associação.</p>',
        '      <h2>Contato</h2>',
        '      <p>Para falar com a associação sobre uma denúncia ou sobre esta página, escreva para ' + CONTACT + '. Nunca coloque dados pessoais em uma issue pública.</p>',
        '      </div>'
      ]
    }
  }
]

const ALL_PAGES = [...PAGES, ...INFO_PAGES]

function renderPage (page, legal) {
  const doc = page.doc ? legal[page.doc] : null
  const title = doc ? 'Varanda: ' + doc.title : page.title
  const description = doc
    ? doc.title + ' da Varanda, versão ' + legal.LEGAL_VERSION + ', o texto que o app apresenta para aceite.'
    : page.description
  const nav = ALL_PAGES.map((p) => {
    const current = p.dir === page.dir ? ' aria-current="page"' : ''
    return '          <li><a href="../' + p.dir + '/"' + current + '>' + p.nav + '</a></li>'
  })
  const main = doc
    ? [
        '    <h1>' + escape(doc.title) + '</h1>',
        '    <p class="legal__aviso">' + escape(legal.REVIEW_NOTE) + '</p>',
        '    <p class="legal__intro">Versão ' + escape(legal.LEGAL_VERSION) + ', de ' + escape(legal.LEGAL_DATE) +
          '. Este é o texto que o app apresenta para aceite e que fica em Ajustes, no item Termos e privacidade. O aceite é feito no app. ' +
          seeAlso(page, legal) + '</p>',
        '    <div class="legal__texto">',
        ...doc.sections.flatMap((section) => [
          '      <h2>' + escape(section.heading) + '</h2>',
          ...section.paragraphs.map((paragraph) => '      <p>' + linked(paragraph) + '</p>')
        ]),
        '    </div>'
      ]
    : page.main(legal)
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
    '<!-- Gerado por apps/site/scripts/render-legal.js. Não edite à mão. -->',
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
    ...main,
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

// { 'termos/index.html': html, ... } for every page in ALL_PAGES
function render (legal) {
  const out = {}
  for (const page of ALL_PAGES) out[page.dir + '/index.html'] = renderPage(page, legal)
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

module.exports = { PAGES, INFO_PAGES, ALL_PAGES, APP_URL, RETENTION_PREFIXES, PUBLIC, loadLegal, render }
