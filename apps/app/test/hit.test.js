'use strict'

// hitSlopFor lifts a small target to 44 pt without moving it. The wiring
// checks read PostRow.js from disk.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/hit.js')
const total = (slop, axis) => axis === 'y' ? slop.top + slop.bottom : slop.left + slop.right

test('hitSlopFor splits the deficit evenly, and a target already 44 pt gets none', async (t) => {
  const { hitSlopFor, HIT } = await load()
  t.is(HIT, 44)
  t.alike(hitSlopFor({ width: 40, height: 40 }), { top: 2, bottom: 2, left: 2, right: 2 })
  t.alike(hitSlopFor({ width: 44, height: 20 }, { left: 0, right: 0 }), { top: 12, bottom: 12, left: 0, right: 0 })
  t.alike(hitSlopFor({ width: 60, height: 44 }), { top: 0, bottom: 0, left: 0, right: 0 })
  t.alike(hitSlopFor({ width: 80, height: 60 }), { top: 0, bottom: 0, left: 0, right: 0 })
})

test('hitSlopFor never reaches past a side with no room', async (t) => {
  const { hitSlopFor } = await load()
  const none = hitSlopFor({ height: 20 }, { left: 0, right: 0, top: 4, bottom: 8 })
  t.alike(none, { top: 4, bottom: 8, left: 0, right: 0 }, 'both sides capped, so the target stays short of 44 rather than steal')
  const spill = hitSlopFor({ height: 20 }, { left: 0, right: 0, top: 16, bottom: 8 })
  t.alike(spill, { top: 16, bottom: 8, left: 0, right: 0 }, 'what the tight side cannot take goes to the other one')
  t.is(total(spill, 'y') + 20, 44)
  t.alike(hitSlopFor({ height: 20 }, { top: 0, bottom: 0, left: 0, right: 0 }), { top: 0, bottom: 0, left: 0, right: 0 })
  t.alike(hitSlopFor({ height: 20 }, { top: -3, bottom: 5 }), { top: 0, bottom: 5, left: 0, right: 0 }, 'a negative room is no room')
})

test('hitSlopFor ignores an unknown size', async (t) => {
  const { hitSlopFor } = await load()
  t.alike(hitSlopFor({}), { top: 0, bottom: 0, left: 0, right: 0 })
  t.alike(hitSlopFor({ width: NaN, height: undefined }), { top: 0, bottom: 0, left: 0, right: 0 })
})

test('PostRow head targets take their hit area from hitSlopFor, never a fixed 4 or 6', (t) => {
  const post = fs.readFileSync(path.join(__dirname, '../src/ui/PostRow.js'), 'utf8')
  const head = post.slice(post.indexOf('return (\n    <View style={styles.row}'), post.indexOf('<View style={[styles.headActions'))
  const slops = [...head.matchAll(/hitSlop=\{([^}]*)\}/g)].map((m) => m[1])
  t.alike(slops, ['repostedSlop', 'repostedFollowSlop', 'repostedSlop', 'avatarSlop', 'nameSlop', 'metaSlop', 'metaSlop'], 'reposted line, seguir, comentou line, avatar, name, @handle, date')
  t.ok(post.includes("import { hitSlopFor } from '../hit'"))
  t.is(post.split('hitSlopFor(').length - 1, 5, 'one computed slop per target kind')
  t.ok(post.includes('paddingTop: ROW_PAD_TOP') && post.includes('marginBottom: REPOSTED_GAP'), 'the room the slop may use is the same value the layout uses')
  t.ok(post.includes('const headRoom = { left: 0, right: 0, top: headAbove, bottom: HEAD_ROOM_BELOW }'), 'name, handle and date grow up and down only')
})

test('PostRow head slop below stops at the caption margin it is derived from', (t) => {
  const post = fs.readFileSync(path.join(__dirname, '../src/ui/PostRow.js'), 'utf8')
  t.ok(post.includes('const HEAD_ROOM_BELOW = CAPTION_GAP'), 'the room under the head is the caption margin')
  t.ok(post.includes('text: { ...type.postText, color: colors.ink, marginTop: CAPTION_GAP }'), 'the caption uses the same value')
  t.is(post.split('CAPTION_GAP').length - 1, 3, 'declared once, read by the room and by the caption style')
  t.ok(!/HEAD_ROOM_BELOW = \d/.test(post), 'no separate number to drift from the style')
})

test('PostRow "republicou" link pads to 28 pt and hitSlop lifts it to 44 pt', async (t) => {
  const { hitSlopFor, HIT } = await load()
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/PostRow.js'), 'utf8')
  t.ok(src.includes('marginTop: -REPOSTED_PAD_TOP') && src.includes('marginBottom: -REPOSTED_PAD_BOTTOM'), 'padding is cancelled by margins, nothing moves')
  const slop = hitSlopFor({ height: 18 + 8 + 2 }, { top: 16, bottom: 0 })
  t.is(28 + total(slop, 'y'), HIT, 'the box reaches 44 pt')
})

test('EmojiPicker group tabs are 44 pt tall', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/EmojiPicker.js'), 'utf8')
  t.ok(/tab: \{[^}]*minHeight: 44/.test(src))
})
