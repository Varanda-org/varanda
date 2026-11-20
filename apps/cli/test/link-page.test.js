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
