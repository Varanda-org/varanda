'use strict'

// The sign-in URL rule (src/authorizeUrl.js). ES module loaded through import().
const test = require('brittle')

const load = () => import('../src/authorizeUrl.js')

test('https without userinfo passes for any account origin', async (t) => {
  const { acceptableAuthorizeUrl } = await load()
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?state=x'
  t.ok(acceptableAuthorizeUrl(url, 'https://varanda.example'))
  t.ok(acceptableAuthorizeUrl(url, 'http://localhost:8080'))
  t.ok(acceptableAuthorizeUrl(url, null))
  t.ok(acceptableAuthorizeUrl(url, undefined))
})

test('loopback http passes only with a loopback http account origin', async (t) => {
  const { acceptableAuthorizeUrl } = await load()
  for (const url of ['http://127.0.0.1:41234/authorize?state=x', 'http://localhost:41234/authorize']) {
    t.ok(acceptableAuthorizeUrl(url, 'http://localhost:8080'), url + ' with localhost')
    t.ok(acceptableAuthorizeUrl(url, 'http://127.0.0.1:8080'), url + ' with 127.0.0.1')
    t.ok(acceptableAuthorizeUrl(url, 'http://localhost'), url + ' with port 80')
    t.absent(acceptableAuthorizeUrl(url, 'https://varanda.example'), url + ' with an https origin')
    t.absent(acceptableAuthorizeUrl(url, 'https://localhost:8080'), url + ' with https localhost')
    t.absent(acceptableAuthorizeUrl(url, 'http://varanda.example'), url + ' with a non-loopback http origin')
    t.absent(acceptableAuthorizeUrl(url, 'http://localhost.evil.example:8080'), url + ' with a look-alike origin')
    t.absent(acceptableAuthorizeUrl(url, null), url + ' with no origin')
    t.absent(acceptableAuthorizeUrl(url, ''), url + ' with an empty origin')
    t.absent(acceptableAuthorizeUrl(url, 'not a url'), url + ' with a malformed origin')
  }
})

test('everything else is refused', async (t) => {
  const { acceptableAuthorizeUrl } = await load()
  const lab = 'http://localhost:8080'
  const bad = [
    'http://evil.example/authorize',
    'http://localhost.evil.example:1/authorize',
    'http://127.0.0.2:1/authorize',
    'http://[::1]:1/authorize',
    'https://user:pass@accounts.google.com/',
    'https://user@accounts.google.com/',
    'http://user@127.0.0.1:1/authorize',
    'javascript:alert(1)',
    'data:text/html,hi',
    'ftp://127.0.0.1/x',
    'https://',
    'https:accounts.google.com',
    '//accounts.google.com/',
    '/authorize',
    'not a url',
    'https://accounts.google.com/\tx',
    'https://accounts.google.com\\@evil.example/',
    '',
    null,
    undefined,
    42,
    {}
  ]
  for (const url of bad) {
    t.absent(acceptableAuthorizeUrl(url, lab), String(url) + ' with the lab origin')
    t.absent(acceptableAuthorizeUrl(url, 'https://varanda.example'), String(url) + ' with an https origin')
  }
})
