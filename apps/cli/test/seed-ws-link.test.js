'use strict'

const test = require('brittle')
const http = require('node:http')
const { createHash } = require('node:crypto')
const { Seeder } = require('@varanda/core/lib/seeder')
const { sealMedia } = require('@varanda/core/lib/group-media')
const { startSeedWs } = require('../lib/seed-ws')
const { renderLinkPage } = require('../lib/link-page')

const ORIGIN = 'https://varanda.example'
const KEY = 'ab'.repeat(32)
const AUTHOR = 'cd'.repeat(32)
const CORE = 'ef'.repeat(32)
const UNKNOWN = 'ff'.repeat(32)
const ROUTES = [['g', KEY, '/p/g/' + KEY], ['c', KEY, '/p/c/' + KEY], ['m', KEY, '/p/m/' + KEY], ['u', 'padaria', '/p/@PaDaRiA']]

function jpeg (width = 512, height = 512) {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3,
    1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9
  ])
}

function webp () {
  const bytes = Buffer.alloc(32)
  bytes.write('RIFF')
  bytes.writeUInt32LE(24, 4)
  bytes.write('WEBPVP8 ', 8)
  bytes.writeUInt32LE(12, 16)
  bytes.set([0x10, 2, 0, 0x9d, 1, 0x2a, 0, 2, 0, 2, 0, 0], 20)
  return bytes
}

function descriptor (bytes = jpeg(), mime = 'image/jpeg') {
  return { core: CORE, start: 1, blocks: 1, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mime, width: 512, height: 512 }
}

function shown (image = descriptor()) {
  return { author: AUTHOR, name: 'Padaria & Café', bio: 'Pão do bairro', image, avatar: image }
}

function media (bytes) {
  return { bytes: bytes.length, blocks: (async function * () { yield bytes.subarray(0, 10); yield bytes.subarray(10) })() }
}

async function server (t, seeder, options = {}) {
  const listener = await startSeedWs({ port: 0, seeder, postsOrigin: ORIGIN, linkLimits: { burst: 1000 }, ...options })
  t.teardown(() => listener.close(), { force: true })
  return listener.port
}

function get (port, path, { method = 'GET', host = 'localhost:' + port } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: host }, agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('tempo esgotado')))
    req.end()
  })
}

function generic (kind, id = KEY, origin = ORIGIN) {
  return renderLinkPage({ origin, kind, id, data: null })
}

function post () {
  return { record: { type: 'post', text: 'Publicação compartilhada', at: '2026-03-01T12:00:00.000Z', replyTo: null }, name: 'Padaria', username: null, shareSeq: 3 }
}

test('link pages: every kind, tags, HEAD and configured origin', async (t) => {
  const calls = []
  const port = await server(t, { linkPublic: async (...args) => { calls.push(args); return shown() } })
  for (const [kind, id, path] of ROUTES) {
    const res = await get(port, path + '?mensageiro=1')
    const html = res.body.toString()
    const appPath = kind === 'u' ? '/@padaria' : '/' + kind + '/' + KEY
    t.is(res.status, 200, kind)
    t.ok(html.includes('<meta property="og:title" content="Padaria &amp; Café na Varanda">'))
    t.ok(html.includes('<meta property="og:url" content="' + ORIGIN + appPath + '">'))
    t.ok(html.includes('<meta property="og:image" content="' + ORIGIN + '/p' + appPath + '/imagem">'))
    t.ok(html.includes('<meta property="og:image:width" content="512">'))
    t.ok(html.includes('<meta property="og:image:height" content="512">'))
    t.is(html.includes('Pão do bairro'), kind === 'm' || kind === 'u', 'only pages show bio')
    t.absent(html.includes('localhost'), 'Host never builds a URL')
    t.absent(html.includes(AUTHOR), 'the image owner is not exposed')
    t.is(res.headers['content-type'], 'text/html; charset=utf-8')
    t.is(res.headers['content-length'], String(res.body.length))
    t.is(res.headers['cache-control'], 'no-store')
    t.is(res.headers['referrer-policy'], 'no-referrer')
    t.is(res.headers['x-content-type-options'], 'nosniff')
    t.is(res.headers['x-robots-tag'], 'noindex, nofollow, noarchive')
    t.ok(res.headers['content-security-policy'].includes("default-src 'none'"))
    t.ok(res.headers['content-security-policy'].includes("base-uri 'none'; form-action 'none'"))
    const head = await get(port, path, { method: 'HEAD' })
    t.is(head.status, 200)
    t.is(head.body.length, 0)
    t.is(head.headers['content-length'], res.headers['content-length'])
    t.alike(calls.splice(0), [[kind, id], [kind, id]], 'username lowercased for lookup')
  }
  const wrongHost = await get(port, ROUTES[0][2], { host: 'attacker.example' })
  t.is(wrongHost.status, 421)
  t.absent(wrongHost.body.toString().includes('attacker.example'))
  t.is(calls.length, 0)
})

test('link pages: null, absent lookup, exception and disabled origin stay generic', async (t) => {
  for (const seeder of [{ linkPublic: async () => null }, {}, { linkPublic: async () => { throw new Error('não deve aparecer') } }]) {
    const port = await server(t, seeder)
    for (const [kind, id, path] of ROUTES) {
      const res = await get(port, path)
      t.is(res.status, 200)
      t.is(res.body.toString(), generic(kind, id))
      t.absent(res.body.toString().includes('og:url'))
    }
  }
  let calls = 0
  const port = await server(t, { linkPublic: async () => { calls++; return shown() } }, { postsOrigin: null })
  for (const [kind, id, path] of ROUTES) {
    const page = await get(port, path)
    t.is(page.status, 200)
    t.is(page.body.toString(), generic(kind, id, null))
    t.absent(page.body.toString().includes('og:image'))
    t.absent(page.body.toString().includes('og:url'))
    t.is((await get(port, path + '/imagem')).status, 404)
  }
  t.is(calls, 0, 'disabled origin does not look up anything')
})

test('link pages: real private gate makes a sealed group indistinguishable from an unknown key', async (t) => {
  const sealed = sealMedia(jpeg(), { plainMime: 'image/jpeg', w: 512, h: 512 })
  const item = { core: CORE, start: 1, ...sealed.item }
  const header = { kind: 'group', visibility: 'private', diary: AUTHOR, name: 'Nome selado' }
  const seeder = {
    linkPublic: Seeder.prototype.linkPublic,
    _isBlocked: () => false,
    _groupCoreVisible: (key) => key === KEY,
    _groupIndex: { header: () => header, nameOf: () => 'Nome selado' },
    _rootBound: () => true,
    _rootScanBehind: () => false,
    _rootGap: () => false,
    groupImagePublic: () => ({ image: item }),
    groupAboutPublic: () => 'Descrição selada',
    mediaRead: async (diary, core, start, blocks) => {
      t.alike([diary, core, start, blocks], [AUTHOR, item.core, item.start, item.blocks])
      return media(sealed.cipher)
    }
  }
  const port = await server(t, seeder)
  const privatePage = await get(port, '/p/g/' + KEY)
  const unknown = await get(port, '/p/g/' + UNKNOWN)
  t.is(privatePage.status, 200)
  t.alike(privatePage.body, unknown.body)
  t.is(privatePage.body.toString(), generic('g'))
  t.absent(privatePage.body.toString().includes('Nome selado'))
  t.absent(privatePage.body.toString().includes('Descrição selada'))
  t.is((await get(port, '/p/g/' + KEY + '/imagem')).status, 404)
  const raw = await get(port, '/media/' + AUTHOR + '/' + item.core + '/' + item.start + '/' + item.blocks)
  t.is(raw.status, 200)
  t.alike(raw.body, sealed.cipher, 'media serves the uploaded ciphertext')
  t.absent(raw.body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), 'no JPEG magic')
  for (const body of [privatePage.body, unknown.body, raw.body]) {
    t.absent(body.includes(item.key))
    t.absent(body.includes(item.nonce))
  }
  header.visibility = 'public'
  const publicPage = (await get(port, '/p/g/' + KEY)).body.toString()
  t.ok(publicPage.includes('Nome selado'), 'the fixture reaches the visibility gate')
  t.ok(publicPage.includes('<meta property="og:description" content="Descrição selada">'), 'and the description gate')
})

test('link pages: a public group or community description is the escaped og:description', async (t) => {
  const about = 'Feira "livre" <i>aos sábados</i> & domingos'
  const escaped = 'Feira &quot;livre&quot; &lt;i&gt;aos sábados&lt;/i&gt; &amp; domingos'
  for (const kind of ['g', 'c']) {
    let current = about
    const header = { kind: kind === 'g' ? 'group' : 'community', visibility: 'public', diary: AUTHOR }
    const seeder = {
      linkPublic: Seeder.prototype.linkPublic,
      _isBlocked: () => false,
      _groupCoreVisible: (key) => key === KEY,
      _groupIndex: { header: () => header, nameOf: () => 'Feira', communityNameOf: () => 'Feira' },
      _rootBound: () => true,
      _rootScanBehind: () => false,
      _rootGap: () => false,
      groupImagePublic: () => null,
      groupAboutPublic: () => current
    }
    const port = await server(t, seeder)
    const html = (await get(port, '/p/' + kind + '/' + KEY)).body.toString()
    t.ok(html.includes('<meta property="og:description" content="' + escaped + '">'), kind)
    t.ok(html.includes('<meta name="description" content="' + escaped + '">'))
    t.ok(html.includes('<p>' + escaped + '</p>'))
    t.absent(html.includes('<i>'))
    t.is((await get(port, '/p/' + kind + '/' + UNKNOWN)).body.toString(), generic(kind, UNKNOWN), 'an unknown key stays generic')
    current = null
    const fallback = (await get(port, '/p/' + kind + '/' + KEY)).body.toString()
    t.ok(fallback.includes('<meta property="og:description" content="' + (kind === 'g' ? 'Grupo' : 'Comunidade') + ' na Varanda.">'), 'no description keeps the category text')
    current = 'Segredo'
    header.visibility = 'private'
    const hidden = (await get(port, '/p/' + kind + '/' + KEY)).body.toString()
    t.is(hidden, generic(kind), 'a private target keeps the generic page')
    t.absent(hidden.includes('Segredo'))
  }
})

test('link images: exact JPEG bytes and owner for every route; WebP avatar through @nome', async (t) => {
  for (const [bytes, mime] of [[jpeg(), 'image/jpeg'], [webp(), 'image/webp']]) {
    const calls = []
    const reads = []
    const port = await server(t, {
      linkPublic: async (...args) => { calls.push(args); return shown(descriptor(bytes, mime)) },
      mediaRead: async (...args) => { reads.push(args); return media(bytes) }
    })
    for (const [kind, id, path] of ROUTES) {
      const res = await get(port, path + '/imagem')
      t.is(res.status, 200, path + ' ' + mime)
      t.alike(res.body, bytes)
      t.is(res.headers['content-type'], mime)
      t.is(res.headers['content-length'], String(bytes.length))
      t.is(res.headers['cache-control'], 'no-store')
      t.is(res.headers['referrer-policy'], 'no-referrer')
      t.is(res.headers['x-content-type-options'], 'nosniff')
      t.is(res.headers['x-robots-tag'], 'noindex, nofollow, noarchive')
      t.alike(calls.splice(0), [[kind, id], [kind, id]])
      t.alike(reads.splice(0), [[AUTHOR, CORE, 1, 1]], 'media belongs to linkPublic author, not route id')
    }
    const head = await get(port, '/p/@padaria/imagem', { method: 'HEAD' })
    t.is(head.status, 200)
    t.is(head.body.length, 0)
    t.is(head.headers['content-length'], String(bytes.length))
    const html = (await get(port, '/p/@padaria')).body.toString()
    t.ok(html.includes('<meta property="og:image:type" content="' + mime + '">'))
  }
})

test('link images: every miss is 404, including wrong hash, frame, MIME and descriptor', async (t) => {
  const cases = [
    ['unknown', null, jpeg()],
    ['no image', shown(null), jpeg()],
    ['hash mismatch', shown({ ...descriptor(), sha256: '00'.repeat(32) }), jpeg()],
    ['wrong frame', shown(descriptor(jpeg(256, 512))), jpeg(256, 512)],
    ['wrong descriptor size', shown({ ...descriptor(jpeg(256, 512)), width: 256 }), jpeg(256, 512)],
    ['wrong MIME', shown({ ...descriptor(), mime: 'image/png' }), jpeg()],
    ['wrong magic', shown(descriptor(webp())), webp()],
    ['wrong byte count', shown(descriptor()), jpeg().subarray(1)],
    ['invalid author', { ...shown(), author: 'invalid' }, jpeg()]
  ]
  for (const [label, data, bytes] of cases) {
    const port = await server(t, { linkPublic: async () => data, mediaRead: async () => media(bytes) })
    for (const path of ['/p/g/' + KEY + '/imagem', '/p/@padaria/imagem']) {
      const res = await get(port, path)
      t.is(res.status, 404, label)
      t.is(res.body.toString(), 'não encontrado\n', label)
    }
  }
})

test('link images: recheck rejects withdrawal, another owner and every changed descriptor field', async (t) => {
  const changes = {
    withdrawn: () => null,
    author: (data) => ({ ...data, author: UNKNOWN }),
    core: (data) => { data.avatar.core = UNKNOWN; return data },
    start: (data) => { data.avatar.start++; return data },
    blocks: (data) => { data.avatar.blocks++; return data },
    bytes: (data) => { data.avatar.bytes++; return data },
    sha256: (data) => { data.avatar.sha256 = UNKNOWN; return data },
    mime: (data) => { data.avatar.mime = 'image/webp'; return data },
    width: (data) => { data.avatar.width++; return data },
    height: (data) => { data.avatar.height++; return data }
  }
  for (const [label, change] of Object.entries(changes)) {
    for (const path of ['/p/g/' + KEY + '/imagem', '/p/@padaria/imagem']) {
      let data = shown()
      let calls = 0
      const port = await server(t, {
        linkPublic: async () => { calls++; return data },
        mediaRead: async () => { data = change(data); return media(jpeg()) }
      })
      const res = await get(port, path)
      t.is(res.status, 404, label)
      t.is(calls, 2, 'permission checked after the bytes')
    }
  }
})

test('link routing: POST is 405, malformed paths never look up, post pages still work', async (t) => {
  let calls = 0
  const port = await server(t, { linkPublic: async () => { calls++; return shown() }, postPublic: async () => post() })
  for (const [, , path] of ROUTES) {
    for (const suffix of ['', '/imagem']) {
      const res = await get(port, path + suffix, { method: 'POST' })
      t.is(res.status, 405)
      t.is(res.headers.allow, 'GET, HEAD')
    }
  }
  for (const path of ['/p/@ab', '/p/@' + 'a'.repeat(21), '/p/@a-b', '/p/@a%62c', '/p/g/' + KEY + '/extra', '/p/g/' + KEY.toUpperCase(), '/p/@padaria/imagem?x=1']) {
    t.is((await get(port, path)).status, 404, path)
  }
  t.is(calls, 0)
  for (const name of ['abc', 'a'.repeat(20), '123', '_ab']) t.is((await get(port, '/p/@' + name)).status, 200, 'route grammar: ' + name)
  const res = await get(port, '/p/' + KEY + '/2')
  t.is(res.status, 200)
  t.ok(res.body.toString().includes('Publicação compartilhada'))
})

test('link budget: exhausted bucket or cap answers before lookup, independent of posts', async (t) => {
  for (const linkLimits of [{ rate: 0, burst: 0 }, { maxInFlight: 0 }]) {
    let calls = 0
    const port = await server(t, { linkPublic: async () => { calls++; return shown() } }, { linkLimits })
    t.is((await get(port, '/p/g/' + KEY)).body.toString(), generic('g'))
    t.is((await get(port, '/p/@padaria/imagem')).status, 404)
    t.is(calls, 0)
  }
  let calls = 0
  const port = await server(t, { linkPublic: async () => { calls++; return shown() }, postPublic: async () => post() }, { linkLimits: { rate: 0, burst: 1 } })
  t.ok((await get(port, '/p/g/' + KEY)).body.toString().includes('Padaria'))
  t.is((await get(port, '/p/g/' + KEY)).body.toString(), generic('g'))
  t.is((await get(port, '/p/@padaria/imagem')).status, 404, 'images share the link budget')
  t.is(calls, 1)
  t.is((await get(port, '/p/' + KEY + '/2')).status, 200, 'post budget untouched')
})

test('link deadline: generic page or image 404, pending work holds its slot', async (t) => {
  for (const path of ['/p/g/' + KEY, '/p/@padaria/imagem']) {
    let release
    const pending = new Promise((resolve) => { release = resolve })
    t.teardown(() => release(null), { force: true })
    let calls = 0
    const port = await server(t, { linkPublic: () => { calls++; return pending } }, { linkLimits: { maxInFlight: 1, deadlineMs: 30 } })
    const res = await get(port, path)
    if (path.endsWith('/imagem')) t.is(res.status, 404)
    else {
      t.is(res.status, 200)
      t.is(res.body.toString(), generic('g'))
    }
    t.is((await get(port, '/p/g/' + KEY)).body.toString(), generic('g'))
    t.is(calls, 1, 'a timed-out lookup still occupies the only slot')
    release(null)
  }
})
