'use strict'

// The installation origin (src/installation.js). It is an ES module bundled
// by Metro; import() loads it here through Node's module syntax detection.
const test = require('brittle')

test('setInstallation accepts an https origin', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, installationOrigin } = await load()
  try {
    t.is(setInstallation('https://example.test'), true)
    t.is(installationOrigin(), 'https://example.test')
    // A default port is not part of the origin.
    t.is(setInstallation('https://example.test:443'), true)
    t.is(installationOrigin(), 'https://example.test')
  } finally {
    t.is(setInstallation(null), true)
  }
})

test('setInstallation drops a trailing slash', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, installationOrigin } = await load()
  try {
    t.is(setInstallation('https://example.test/'), true)
    t.is(installationOrigin(), 'https://example.test')
  } finally {
    t.is(setInstallation(null), true)
  }
})

test('setInstallation refuses a value that is not an installation origin', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, installationOrigin } = await load()
  try {
    t.is(setInstallation('https://example.test'), true)
    const refused = [
      'http://example.test',
      'https://ada:secret@example.test',
      'https://example.test/a',
      'https://example.test?q=1',
      'https://example.test#top',
      'https://Example.test',
      42,
      ''
    ]
    for (const value of refused) {
      t.is(setInstallation(value), false, 'refuses ' + JSON.stringify(value))
      t.is(installationOrigin(), 'https://example.test', 'keeps origin after ' + JSON.stringify(value))
    }
  } finally {
    t.is(setInstallation(null), true)
  }
})

test('setInstallation accepts http on localhost and 127.0.0.1', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, installationOrigin } = await load()
  try {
    t.is(setInstallation('http://localhost:8080'), true)
    t.is(installationOrigin(), 'http://localhost:8080')
    t.is(setInstallation('http://127.0.0.1:8080'), true)
    t.is(installationOrigin(), 'http://127.0.0.1:8080')
  } finally {
    t.is(setInstallation(null), true)
  }
})

test('setInstallation(null) clears the origin', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, installationOrigin } = await load()
  try {
    t.is(setInstallation('https://example.test'), true)
    t.is(setInstallation(null), true)
    t.is(installationOrigin(), null)
    t.is(setInstallation(null), true)
    t.is(installationOrigin(), null)
  } finally {
    t.is(setInstallation(null), true)
  }
})

test('setInstallation is idempotent', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, installationOrigin } = await load()
  try {
    t.is(setInstallation('https://example.test'), true)
    t.is(setInstallation('https://example.test'), true)
    t.is(installationOrigin(), 'https://example.test')
  } finally {
    t.is(setInstallation(null), true)
  }
})

test('resolveUrl returns the path when no installation is set', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, installationOrigin, resolveUrl } = await load()
  t.is(setInstallation(null), true)
  t.is(installationOrigin(), null)
  t.is(resolveUrl('/account/start'), '/account/start')
  t.is(resolveUrl('/index/search?q=a%20b'), '/index/search?q=a%20b')
  for (const path of ['x', '//evil.test/a', 42, '/\\evil.test/a', '/\t/evil.test/a', '/\n/evil.test', '/a b']) {
    let err = null
    try { resolveUrl(path) } catch (e) { err = e }
    t.is(err instanceof TypeError, true, 'TypeError for ' + JSON.stringify(path))
  }
})

test('resolveUrl prefixes the installation origin', async (t) => {
  const load = () => import('../src/installation.js')
  const { setInstallation, resolveUrl } = await load()
  try {
    t.is(setInstallation('https://example.test'), true)
    t.is(resolveUrl('/account/start'), 'https://example.test/account/start')
    t.is(resolveUrl('/'), 'https://example.test/')
    for (const path of ['x', '//evil.test/a', 42, '/\\evil.test/a', '/\t/evil.test/a']) {
      let err = null
      try { resolveUrl(path) } catch (e) { err = e }
      t.is(err instanceof TypeError, true, 'TypeError for ' + JSON.stringify(path))
    }
  } finally {
    t.is(setInstallation(null), true)
  }
})

test('rpIdOf is the host, without a port', async (t) => {
  const load = () => import('../src/installation.js')
  const { rpIdOf } = await load()
  t.is(rpIdOf('https://example.test'), 'example.test')
  t.is(rpIdOf('https://example.test:8443'), 'example.test')
  t.is(rpIdOf('http://localhost:8080'), 'localhost')
  t.is(rpIdOf('https://Example.TEST'), 'example.test')
})

test('rpIdOf refuses an IP literal and a bad character', async (t) => {
  const load = () => import('../src/installation.js')
  const { rpIdOf } = await load()
  for (const origin of ['https://127.0.0.1', 'https://[::1]', 'https://bad_host.test']) {
    let err = null
    try { rpIdOf(origin) } catch (e) { err = e }
    t.is(err instanceof TypeError, true, 'TypeError for ' + origin)
  }
})

test('hostOf keeps a non-default port', async (t) => {
  const load = () => import('../src/installation.js')
  const { hostOf } = await load()
  t.is(hostOf('https://example.test'), 'example.test')
  t.is(hostOf('https://example.test:8443'), 'example.test:8443')
  t.is(hostOf('http://localhost:8080'), 'localhost:8080')
  let err = null
  try { hostOf('https://example.test/a') } catch (e) { err = e }
  t.is(err instanceof TypeError, true)
})
