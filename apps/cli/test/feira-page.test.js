'use strict'

// apps/cli/lib/feira-page.js: the public listing page, its not-found page and
// the sitemap. Pure, no network.

const test = require('brittle')
const { feira: { priceLabel, statusLabel } } = require('@varanda/rpc')
const { renderListingPage, renderNotFound, renderSitemap } = require('../lib/feira-page')

const HEX = 'ab'.repeat(32)
const PAGE = 'https://bora.varanda.app/f/' + HEX + '/7'

function photo (n) {
  return '/f/' + HEX + '/7/foto/' + n
}

function view (over) {
  return {
    kind: 'servico',
    title: 'Aula de violão',
    text: 'Aulas para iniciantes.\nTraga seu violão.',
    priceLabel: priceLabel(5000, 'hora', 'servico'),
    city: 'São Paulo',
    uf: 'SP',
    bairro: 'Pinheiros',
    catLabel: 'Aulas',
    status: 'disponivel',
    statusLabel: statusLabel('disponivel', 'servico'),
    username: 'ana',
    name: 'Ana Souza',
    photoUrls: [photo(0)],
    pageUrl: PAGE,
    enterUrl: '/entrar?volta=%2Ff%2F' + HEX + '%2F7',
    ...over
  }
}

function robots (html) {
  const m = html.match(/<meta name="robots" content="([^"]*)">/)
  return m ? m[1] : null
}

test('hostile title, text and name are escaped, no script tag', (t) => {
  const html = renderListingPage(view({
    title: '<script>alert(1)</script>"\'&',
    text: '</p><script src=//x></script><img onerror=1>',
    name: '<b onmouseover="x">Eva</b>',
    username: 'eva"><script>',
    catLabel: '<i>',
    city: '<x>',
    bairro: '"q"'
  }))
  t.ok(html)
  t.absent(/<script/i.test(html), 'no script tag')
  t.absent(html.includes('<b onmouseover'))
  t.absent(html.includes('<img onerror'))
  t.absent(html.includes('<i>'))
  t.absent(html.includes('<x>'))
  t.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;'))
  t.ok(html.includes('&lt;b onmouseover=&quot;x&quot;&gt;Eva&lt;/b&gt;'))
  t.ok(html.includes('@eva&quot;&gt;&lt;script&gt;'))
})

test('control and direction characters are stripped', (t) => {
  const html = renderListingPage(view({ title: 'Bi\u0000ci\u202ecle\u0007ta', name: 'A\u200fna\u0085' }))
  t.ok(html.includes('<h1>Bicicleta</h1>'))
  t.ok(html.includes('Ana @ana'))
  const bad = Array.from(html).filter((ch) => {
    const cp = ch.codePointAt(0)
    return (cp < 0x20 && cp !== 0x0a) || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x202a && cp <= 0x202e) ||
      cp === 0x200e || cp === 0x200f || cp === 0xfffd
  })
  t.is(bad.length, 0)
})

test('canonical link and og:url carry the page url', (t) => {
  const html = renderListingPage(view())
  t.ok(html.includes('<link rel="canonical" href="' + PAGE + '">'))
  t.ok(html.includes('<meta property="og:url" content="' + PAGE + '">'))
  t.ok(html.includes('<meta property="og:type" content="website">'))
})

test('a non-http page url gives no canonical', (t) => {
  const html = renderListingPage(view({ pageUrl: 'javascript:alert(1)', enterUrl: '//evil.example/x' }))
  t.absent(html.includes('rel="canonical"'))
  t.absent(html.includes('javascript:'))
  t.absent(html.includes('evil.example'))
  t.absent(html.includes('class="enter"'))
})

test('robots: live and procura index, vendido noindex', (t) => {
  t.is(robots(renderListingPage(view())), 'index,follow')
  t.is(robots(renderListingPage(view({ status: 'reservado', statusLabel: 'Reservado' }))), 'index,follow')
  t.is(robots(renderListingPage(view({ kind: 'procura', priceLabel: priceLabel(30000, null, 'procura') }))), 'index,follow')
  t.is(robots(renderListingPage(view({ status: 'vendido', statusLabel: 'Vendido' }))), 'noindex,follow')
  t.is(robots(renderListingPage(view({ kind: 'procura', status: 'vendido', statusLabel: 'Encontrado' }))), 'noindex,follow')
  t.is(robots(renderListingPage(view({ status: null, statusLabel: '' }))), 'noindex,follow', 'unknown status is not indexed')
})

test('badges Reservado, Vendido and Encontrado', (t) => {
  t.ok(renderListingPage(view({ status: 'reservado', statusLabel: 'Reservado' })).includes('<p class="badge">Reservado</p>'))
  t.ok(renderListingPage(view({ kind: 'produto', status: 'vendido', statusLabel: 'Vendido' })).includes('<p class="badge">Vendido</p>'))
  t.ok(renderListingPage(view({ kind: 'procura', status: 'vendido', statusLabel: 'Encontrado' })).includes('<p class="badge">Encontrado</p>'))
  t.absent(renderListingPage(view()).includes('class="badge"'))
})

test('og:image only for a same-origin /f/ photo', (t) => {
  t.absent(renderListingPage(view({ photoUrls: [] })).includes('og:image'))
  const off = renderListingPage(view({ photoUrls: ['https://evil.example/a.jpg', '//evil.example/b.jpg', 'javascript:x'] }))
  t.absent(off.includes('og:image'))
  t.absent(off.includes('evil.example'))
  t.absent(off.includes('<img'))
  const first = renderListingPage(view({ photoUrls: ['https://evil.example/a.jpg', photo(1)] }))
  t.absent(first.includes('og:image'), 'never promotes a later photo when the first is off-origin')
  t.ok(first.includes('<img src="' + photo(1) + '"'))
  const ok = renderListingPage(view())
  t.ok(ok.includes('<meta property="og:image" content="https://bora.varanda.app' + photo(0) + '">'))
})

test('four photos rendered, never a fifth', (t) => {
  const html = renderListingPage(view({ photoUrls: [photo(0), photo(1), photo(2), photo(3), photo(4)] }))
  t.is(html.match(/<img /g).length, 4)
  for (let i = 0; i < 4; i++) t.ok(html.includes('<img src="' + photo(i) + '"'))
  t.absent(html.includes(photo(4)))
})

test('procura heading, budget label and offer anchor', (t) => {
  const html = renderListingPage(view({
    kind: 'procura',
    title: 'Bicicleta aro 26',
    priceLabel: priceLabel(30000, null, 'procura')
  }))
  t.ok(html.includes('<h1>Procura-se: Bicicleta aro 26</h1>'))
  t.ok(html.includes('<p class="price">Até R$ 300,00</p>'))
  t.ok(html.includes('>Entrar para oferecer</a>'))
  t.absent(html.includes('Entrar para conversar'))
})

test('unit label, place, seller and enter href', (t) => {
  const v = view()
  const html = renderListingPage(v)
  t.ok(html.includes('<p class="price">R$ 50,00/hora</p>'))
  t.ok(html.includes('Pinheiros, São Paulo/SP'))
  t.ok(html.includes('Ana Souza @ana'))
  t.ok(html.includes('<a class="enter" href="' + v.enterUrl + '">Entrar para conversar</a>'))
  t.ok(html.includes('fora do aplicativo'))
  t.ok(html.includes('class="text">Aulas para iniciantes.\nTraga seu violão.'))
  t.absent(/estrela|avalia/i.test(html), 'no ratings')
  t.absent(html.includes('\u2014'), 'no em dash')
})

test('the app link appears only in its exact shape', (t) => {
  const app = 'varanda:///anuncio/' + HEX + '/7'
  t.ok(renderListingPage(view({ appUrl: app })).includes('<a class="app" href="' + app + '">Já tem o app? Abrir no app</a>'), 'iOS keeps same-host links in Safari: the scheme link opens the app')
  for (const bad of ['javascript:alert(1)', 'varanda:///anuncio/' + HEX.toUpperCase() + '/7', 'varanda:///anuncio/' + HEX + '/0', 'varanda://evil/anuncio/' + HEX + '/7', app + '"><script>', 'https://evil.example/anuncio/' + HEX + '/7']) {
    t.absent(renderListingPage(view({ appUrl: bad })).includes('class="app"'), bad)
  }
  t.absent(renderListingPage(view()).includes('class="app"'), 'no link without the field')
})

test('og:description: price, place and a 160 code point cut of the text', (t) => {
  const html = renderListingPage(view({ text: 'é'.repeat(400) }))
  const m = html.match(/<meta property="og:description" content="([^"]*)">/)
  t.ok(m)
  t.ok(m[1].startsWith('R$ 50,00/hora · Pinheiros, São Paulo/SP · '))
  const cut = m[1].split(' · ')[2]
  t.is(Array.from(cut).length, 160)
})

test('no external resources and no script', (t) => {
  const html = renderListingPage(view({ photoUrls: [photo(0), photo(1)] }))
  t.absent(/<script|<link rel="stylesheet"|@import|url\(/i.test(html))
  t.absent(/src="https?:/i.test(html))
})

test('null or bad view -> null, never throws', (t) => {
  t.is(renderListingPage(null), null)
  t.is(renderListingPage(undefined), null)
  t.is(renderListingPage('x'), null)
  const trap = { get title () { throw new Error('boom') } }
  t.is(renderListingPage(trap), null)
  t.ok(renderListingPage({}), 'an empty view still renders a shell')
})

test('renderNotFound has no listing data', (t) => {
  const html = renderNotFound()
  t.ok(html.includes('Anúncio não encontrado'))
  t.is(robots(html), 'noindex,follow')
  t.absent(html.includes('/f/'))
  t.absent(html.includes('canonical'))
  t.absent(html.includes('og:'))
  t.absent(/<script/i.test(html))
})

test('renderSitemap escapes and lists exactly the given urls', (t) => {
  const urls = [PAGE, 'https://bora.varanda.app/f/' + HEX + '/8?a=1&b=<2>']
  const xml = renderSitemap(urls)
  t.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
  t.ok(xml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'))
  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1])
  t.alike(locs, [PAGE, 'https://bora.varanda.app/f/' + HEX + '/8?a=1&amp;b=&lt;2&gt;'])
  t.is((xml.match(/<url>/g) || []).length, 2)
  t.is([...renderSitemap([]).matchAll(/<url>/g)].length, 0)
  t.is([...renderSitemap(null).matchAll(/<url>/g)].length, 0)
})
