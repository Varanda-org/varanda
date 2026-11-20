'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')

test('the profile header takes moments, cornerActions and link', (t) => {
  const src = read('ui/ProfileHeader.js')
  t.ok(/corner, cornerActions, moments = null, link, theme/.test(src), 'three props')
  t.ok(src.includes("<PressScale accessibilityRole='button' accessibilityLabel={moments.label} onPress={() => moments.onPress()}>"), 'the avatar is a button')
  t.ok(src.includes('<MomentRing size={avatarSize} unseen={moments.unseen}>'), 'ring around the avatar')
  t.ok(src.includes('<Avatar name={a.name} publicKey={a.publicKey} size={avatarSize} picture={a.picture} persist={a.persist} ring />'), 'no moments: the usual ring')
  t.ok(src.includes('<Avatar name={a.name} publicKey={a.publicKey} size={avatarSize} picture={a.picture} persist={a.persist} />'), 'inside the ring: no own ring')
})

test('corner icons sit beside the corner and join the actions when stacked', (t) => {
  const src = read('ui/ProfileHeader.js')
  t.ok(src.includes('Array.isArray(cornerActions) ? cornerActions.filter(Boolean) : []'), 'filtered')
  t.ok(src.includes('const shownActions = stacked ? [...shownCorner, ...baseActions] : baseActions'), 'prepended when stacked')
  t.ok(src.includes('!stacked && shownCorner.length > 0'), 'drawn in the corner otherwise')
  t.ok(/cornerRow: \{ flexDirection: 'row', alignItems: 'center', gap: space.sm \}/.test(src), 'row')
})

test('the link renders after the mood and before the counts', (t) => {
  const src = read('ui/ProfileHeader.js')
  const at = src.indexOf('{link || null}')
  t.ok(at > src.indexOf('{mood || null}'))
  t.ok(at < src.indexOf('shownCounts.length > 0\n'))
})

test('MomentRing reuses the strip ring bands', (t) => {
  const src = read('ui/MomentosStrip.js')
  const ring = src.slice(src.indexOf('export function MomentRing'), src.indexOf('// data: useMoments()'))
  t.ok(ring.includes('RING_BANDS.map'))
  t.ok(ring.includes('collapsable={false}'))
  t.ok(ring.includes('const outer = size + 8') && ring.includes('const gap = size + 4'))
  t.ok(src.includes("import { sunsetStops, type } from './theme'\n"), 'theme import unchanged')
})

test('the profile header no longer takes or renders about and top', (t) => {
  const src = read('ui/ProfileHeader.js')
  const props = src.match(/export function ProfileHeader \(\{([^}]+)\}/)[1]
  t.absent(/\b(?:about|top)\b/.test(props), 'no unused props')
  t.absent(/\{\s*(?:about|top)\s*(?:\?|\|\||\})/.test(src), 'no unused slots rendered')
})
