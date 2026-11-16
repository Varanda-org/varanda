'use strict'

// Stand-in for the GIF provider where the hosted lab must not reach one: a
// Giphy-compatible search on a loopback socket, reached through the account
// service's real GIF routes (lib/account/gif-routes.js) with a transport
// that resolves only the stub's name to 127.0.0.1. Every result is a 1x1
// GIF of one color made here: no key, no external host, and any search
// text answers the same page.

const http = require('node:http')
const { parseGifConfig } = require('../lib/account/gif-routes')

const STUB_HOST = 'gif.lab'
const STUB_KEY = 'laboratorio'
const COLORS = [
  [0xd9, 0x7b, 0x4a],
  [0x2f, 0x6f, 0x5e],
  [0xe8, 0xc5, 0x47],
  [0x3a, 0x5a, 0x8c],
  [0xb5, 0x4a, 0x6d],
  [0x7a, 0x9a, 0x3c]
]

// GIF89a, a 1x1 screen with a two-color table, one image whose only pixel
// is color 0, and the trailer.
function solidGif ([r, g, b]) {
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
    r, g, b, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
    0x3b
  ])
}

const ITEMS = COLORS.map((c, i) => ({ id: 'lab' + i, gif: solidGif(c) }))

function enotfound () {
  const err = new Error('ENOTFOUND')
  err.code = 'ENOTFOUND'
  return err
}

// -> { config, transport, close }: `config` for createAccountServer's `gif`,
// `transport` for its `gifTransport`.
async function createGifStub () {
  let port = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://' + STUB_HOST)
    if (req.method === 'GET' && url.pathname === '/v1/gifs/search') {
      const offset = Number(url.searchParams.get('offset')) || 0
      const base = 'https://' + STUB_HOST + ':' + port + '/media/'
      const image = (id, gif, name) => ({ url: base + id + '/' + name + '.gif', width: '1', height: '1', size: String(gif.length) })
      const data = offset > 0
        ? []
        : ITEMS.map(({ id, gif }) => ({ id, images: { fixed_width_small: image(id, gif, 'tiny'), original: image(id, gif, 'full') } }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ data, pagination: { offset, count: data.length, total_count: ITEMS.length } }))
    }
    const m = url.pathname.match(/^\/media\/([a-z0-9]+)\/(tiny|full)\.gif$/)
    const item = m ? ITEMS.find((it) => it.id === m[1]) : undefined
    if (req.method === 'GET' && item !== undefined) {
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': item.gif.length })
      return res.end(item.gif)
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
  const config = parseGifConfig({ apiUrl: 'https://' + STUB_HOST + ':' + port + '/v1', apiKey: STUB_KEY })
  const transport = {
    request: (opts) => http.request(opts),
    lookup: (host, opts, cb) => (host === STUB_HOST ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(enotfound())),
    allowAddress: (ip) => ip === '127.0.0.1'
  }
  const close = () => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  return { config, transport, close }
}

module.exports = { createGifStub, STUB_HOST }
