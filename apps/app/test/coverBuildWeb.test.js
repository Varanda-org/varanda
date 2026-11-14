'use strict'

// previewBuild.web.js sends the account service the canonical YouTube watch
// address, the only form the service builds a thumbnail from; every other
// link goes as given.

const test = require('brittle')

const web = () => import('../src/previewBuild.web.js')
const MEMBER = 'a'.repeat(64)

function recorder () {
  const sent = []
  const account = {
    previewPolicy: async () => true,
    previewFetch: async (url) => {
      sent.push(url)
      return { url, host: new URL(url).hostname, title: 'T', desc: '', imageBytes: null, imageMime: null }
    }
  }
  return { sent, account }
}

test('a youtu.be link is sent as the canonical watch address', async (t) => {
  const { buildPreview } = await web()
  const { sent, account } = recorder()
  const p = await buildPreview('https://youtu.be/dQw4w9WgXcQ', { member: MEMBER, request: async () => ({}), account })
  t.alike(sent, ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'])
  t.is(p.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  t.is(p.host, 'www.youtube.com')
})

test('a link with no YouTube cover target is sent unchanged', async (t) => {
  const { buildPreview } = await web()
  const { sent, account } = recorder()
  const request = async () => ({})
  const links = ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', 'https://example.com/a', 'https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG']
  for (const url of links) await buildPreview(url, { member: MEMBER, request, account })
  t.alike(sent, links)
})
