'use strict'

const test = require('brittle')
const { renderLinkPage } = require('../lib/link-page')

const ORIGIN = 'https://bora.varanda.app'
const KEY = 'ab'.repeat(32)
const LABELS = { g: 'Grupo', c: 'Comunidade', m: 'Perfil', u: 'Perfil' }

function page (over = {}) {
  return renderLinkPage({ origin: ORIGIN, kind: 'g', id: KEY, data: { name: 'Jardim' }, ...over })
}

function meta (html, key, attr = 'property') {
  const match = html.match(new RegExp('<meta ' + attr + '="' + key + '" content="([^"]*)">'))
  return match ? match[1] : null
}

function safe (t, html) {
  t.ok(html.startsWith('<!doctype html>\n<html lang="pt-BR">'))
  t.ok(html.endsWith('</html>\n'))
  t.is((html.match(/<a\s/g) || []).length, 1)
  t.absent(/<script|<img|<iframe|<link\s|<style/i.test(html))
  const tags = (html.match(/<[a-z][^>]*>/gi) || []).map(tag => tag.replace(/"[^"]*"/g, '""'))
  t.absent(tags.some(tag => /\son[a-z]+\s*=/i.test(tag)))
  t.is(meta(html, 'robots', 'name'), 'noindex')
  t.is(meta(html, 'og:type'), 'website')
  t.is(meta(html, 'og:site_name'), 'Varanda')
}

for (const kind of ['g', 'c', 'm', 'u']) {
  const id = kind === 'u' ? 'JaRdim' : KEY
  const path = kind === 'u' ? '/@jardim' : '/' + kind + '/' + KEY
  test(kind + ': public data with and without an image', t => {
    for (const mime of [null, 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']) {
      const descriptor = mime ? { mime } : null
      const data = { name: 'Jardim', bio: 'Flores e histórias', image: descriptor, avatar: descriptor }
      const html = page({ kind, id, data })
      safe(t, html)
      t.ok(html.includes('<title>Jardim na Varanda</title>'))
      t.is(meta(html, 'og:title'), 'Jardim na Varanda')
      t.ok(meta(html, 'og:description').startsWith(kind === 'g' || kind === 'c' ? LABELS[kind] : 'Página'))
      t.is(meta(html, 'description', 'name'), meta(html, 'og:description'))
      t.is(meta(html, 'og:url'), ORIGIN + path)
      t.ok(html.includes('<a href="' + ORIGIN + path + '">'))
      t.is(meta(html, 'og:image'), ORIGIN + (mime ? '/p' + path + '/imagem' : '/og/convite.png'))
      t.is(meta(html, 'og:image:type'), mime || 'image/png')
      t.is(meta(html, 'og:image:width'), mime ? '512' : '1200')
      t.is(meta(html, 'og:image:height'), mime ? '512' : '630')
      t.is(meta(html, 'og:image:alt'), mime ? 'Jardim na Varanda' : 'Varanda')
      t.is(meta(html, 'twitter:card', 'name'), mime ? 'summary' : 'summary_large_image')
    }
  })
  test(kind + ': unknown targets have identical generic pages', t => {
    const html = page({ kind, id, data: null })
    safe(t, html)
    t.is(html, page({ kind, id: kind === 'u' ? 'outronome' : 'cd'.repeat(32), data: null }))
    t.is(meta(html, 'og:title'), LABELS[kind] + ' na Varanda')
    t.is(meta(html, 'og:url'), null)
    t.is(meta(html, 'og:image'), ORIGIN + '/og/convite.png')
    t.ok(html.includes('<a href="/">'))
    t.absent(html.includes(id))
    t.is(html, page({ kind, id: '../invalid', data: { name: 'Hidden' } }))
  })
}

for (const kind of ['m', 'u']) {
  test(kind + ': page descriptions include a valid lowercase username and keep the bio cap', t => {
    const id = kind === 'u' ? 'jardim' : KEY
    for (const username of ['JaRdim', 'abc', 'a'.repeat(20)]) {
      for (const bio of ['', 'Flores e histórias', '🌻'.repeat(250)]) {
        const html = page({ kind, id, data: { name: 'Jardim', username, bio } })
        const prefix = 'Página @' + username.toLowerCase() + ' na Varanda.'
        const description = Array.from(prefix + (bio ? ' ' + bio : '')).slice(0, 200).join('')
        t.is(meta(html, 'og:title'), 'Jardim na Varanda')
        t.ok(html.includes('<title>Jardim na Varanda</title>'))
        t.is(meta(html, 'og:description'), description)
        t.is(meta(html, 'description', 'name'), description)
        t.ok(html.includes('<p>' + description + '</p>'))
      }
    }
  })

  test(kind + ': missing, invalid and hostile usernames keep the page description', t => {
    const id = kind === 'u' ? 'jardim' : KEY
    for (const username of [undefined, null, 12, '', 'ab', 'abcdef', 'a'.repeat(21), '1jardim', '@jardim', 'has space', '<script>jardim</script>', 'jar\u202edim']) {
      for (const bio of ['', 'Flores e histórias']) {
        const html = page({ kind, id, data: { name: 'Jardim', username, bio } })
        t.is(html, page({ kind, id, data: { name: 'Jardim', bio } }))
        t.is(meta(html, 'og:description'), 'Página na Varanda.' + (bio ? ' ' + bio : ''))
      }
    }
  })
}

for (const kind of ['g', 'c']) {
  test(kind + ': a public description becomes the page description, escaped and capped', t => {
    const label = LABELS[kind]
    const about = 'Mudas "raras" <b>hoje</b> & amanhã'
    const escaped = 'Mudas &quot;raras&quot; &lt;b&gt;hoje&lt;/b&gt; &amp; amanhã'
    const html = page({ kind, data: { name: 'Jardim', about } })
    safe(t, html)
    t.is(meta(html, 'og:description'), escaped)
    t.is(meta(html, 'description', 'name'), escaped)
    t.ok(html.includes('<p>' + escaped + '</p>'))
    t.absent(html.includes('<b>'))
    t.is(meta(html, 'og:title'), 'Jardim na Varanda')
    const long = page({ kind, data: { name: 'Jardim', about: '🌻'.repeat(250) } })
    t.is(meta(long, 'og:description'), '🌻'.repeat(200))
    const hostile = page({ kind, data: { name: 'Jardim', about: '\u202ejar\u0000dim\ufffd' } })
    t.absent(['\u202e', '\u0000', '\ufffd'].some(ch => hostile.includes(ch)))
    t.is(meta(hostile, 'og:description'), 'jardim')
    for (const missing of [undefined, null, '', '   ', 12, {}, ['a'], '\u0000\ufffd']) {
      const fallback = page({ kind, data: { name: 'Jardim', about: missing } })
      t.is(fallback, page({ kind, data: { name: 'Jardim' } }))
      t.is(meta(fallback, 'og:description'), label + ' na Varanda.')
    }
    t.is(page({ kind, data: { name: 'Jardim', bio: 'Flores' } }), page({ kind, data: { name: 'Jardim' } }), 'groups ignore bio')
  })

  test(kind + ': the generic page keeps its exact bytes and never shows a description', t => {
    const label = LABELS[kind]
    const description = label + ' na Varanda. Abra a Varanda para ver mais.'
    const generic = '<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + label + ' na Varanda</title>\n' +
      '<meta name="description" content="' + description + '">\n' +
      '<meta name="robots" content="noindex">\n' +
      '<meta property="og:title" content="' + label + ' na Varanda">\n' +
      '<meta property="og:description" content="' + description + '">\n' +
      '<meta property="og:type" content="website">\n' +
      '<meta property="og:site_name" content="Varanda">\n' +
      '<meta name="twitter:card" content="summary_large_image">\n' +
      '<meta property="og:image" content="' + ORIGIN + '/og/convite.png">\n' +
      '<meta property="og:image:type" content="image/png">\n' +
      '<meta property="og:image:width" content="1200">\n' +
      '<meta property="og:image:height" content="630">\n' +
      '<meta property="og:image:alt" content="Varanda">\n' +
      '</head>\n<body>\n<h1>' + label + ' na Varanda</h1>\n<p>' + description + '</p>\n' +
      '<p><a href="/">Ver na Varanda</a></p>\n</body>\n</html>\n'
    t.is(page({ kind, data: null }), generic)
    const hidden = page({ kind, id: '../invalid', data: { name: 'Jardim', about: 'Segredo' } })
    t.is(hidden, generic)
    t.absent(hidden.includes('Segredo'))
  })
}

test('peer text is cleaned, escaped and capped by code points', t => {
  const hostile = '<script>"\'&\u202e\u0000\ufffd'
  for (const kind of ['g', 'c', 'm', 'u']) {
    const html = page({ kind, id: kind === 'u' ? 'jardim' : KEY, data: { name: hostile, bio: hostile } })
    safe(t, html)
    t.is(meta(html, 'og:title'), '&lt;script&gt;&quot;&#39;&amp; na Varanda')
    t.absent(['\u202e', '\u0000', '\ufffd'].some(ch => html.includes(ch)))
  }
  const html = page({ kind: 'm', data: { name: '🌻'.repeat(100), bio: 'a'.repeat(300) } })
  t.is(meta(html, 'og:title'), '🌻'.repeat(80) + ' na Varanda')
  t.is(Array.from(meta(html, 'og:description')).length, 200)
})

test('only bare HTTPS origins produce absolute metadata', t => {
  for (const origin of [undefined, null, 12, '', 'http://example.org', '//example.org', 'https://x.test/path', 'https://u:p@x.test', 'https://x.test/?x=1', 'https://x.test/#x', 'https://x.test/ bad']) {
    for (const data of [null, { name: 'Jardim', image: { mime: 'image/png' } }]) {
      const html = page({ origin, data })
      safe(t, html)
      t.is(meta(html, 'og:url'), null)
      t.is(meta(html, 'og:image'), null)
    }
  }
  t.is(meta(page({ origin: ORIGIN + '/' }), 'og:url'), ORIGIN + '/g/' + KEY)
})

test('malformed arguments never throw or disclose the target', t => {
  const explosive = { get name () { throw new Error('private reason') } }
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  for (const args of [undefined, null, [], 1, revoked.proxy, { get origin () { throw new Error('private reason') } }]) {
    const html = renderLinkPage(args)
    safe(t, html)
    t.ok(html.includes('<a href="/">'))
    t.absent(html.includes('private reason'))
  }
  for (const id of [null, 12, '', KEY.toUpperCase(), '../bad', 'abc123']) {
    t.is(page({ id }), page({ data: null }))
  }
  t.is(page({ data: explosive }), page({ data: null }))
  t.is(page({ kind: '__proto__' }), page({ kind: 'm', data: null }))
  for (const id of ['ab', 'abcdef', 'has space', '@jardim', 'jardim/evil']) {
    t.is(page({ kind: 'u', id }), page({ kind: 'u', data: null }))
  }
})
