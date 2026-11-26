'use strict'

// MediaView can show a photo whole over a blurred, dimmed copy of itself.
// Source-text pins, like mediaFade.test.js.

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const backdrop = fs.readFileSync(path.join(__dirname, '../src/ui/MediaBackdrop.js'), 'utf8')
const src = fs.readFileSync(path.join(__dirname, '../src/ui/MediaView.js'), 'utf8')

test('the backdrop is a blurred, dimmed, hidden, cover-fitted copy', (t) => {
  t.absent(backdrop.includes('—'), 'no em dash')
  t.ok(backdrop.includes('const BACKDROP_BLUR = 24'), 'named blur constant')
  t.ok(backdrop.includes('blurRadius={BACKDROP_BLUR}'), 'the image is blurred')
  t.ok(backdrop.includes("resizeMode='cover'"), 'the copy fills the tile')
  t.ok(backdrop.includes("resizeMethod='resize'"), 'Android decodes at view size')
  t.ok(backdrop.includes('transform: [{ scale: 1.2 }]'), 'scaled so the soft edge is clipped')
  t.ok(backdrop.includes("backgroundColor: 'rgba(0,0,0,0.35)'"), 'dimmed')
  t.ok(backdrop.includes('accessibilityElementsHidden'), 'hidden from VoiceOver')
  t.ok(backdrop.includes("importantForAccessibility='no-hide-descendants'"), 'hidden from TalkBack')
  t.ok(backdrop.includes('aria-hidden'), 'hidden from the web tree')
  t.absent(backdrop.includes('pointerEvents='), 'no pointerEvents: TalkBack would skip the parent button')
  t.ok(backdrop.includes("Platform.OS === 'android' ? { fadeDuration: 0 } : null"), 'Android fade off')
})

test('MediaView renders the backdrop only for a shown photo, behind it', (t) => {
  t.ok(src.includes('backdrop = false'), 'backdrop is an opt-in prop')
  const view = src.slice(src.indexOf('export function MediaView'), src.indexOf('const makeStyles'))
  t.is(view.split('<MediaBackdrop').length - 1, 1, 'rendered once')
  const ok = view.indexOf("if (state === 'ok' ||")
  const loading = view.indexOf("} else if (state === 'loading')")
  const at = view.indexOf('<MediaBackdrop url={url} />')
  t.ok(view.includes("{state === 'ok' && backdrop && <MediaBackdrop url={url} />}"), 'only when asked for, over a shown photo')
  t.ok(ok >= 0 && at > ok && at < loading, 'inside the ok branch')
  t.ok(at < view.indexOf('<FadingPhoto key={url}'), 'before the photo')
})

test('the fading photo knows nothing of the backdrop', (t) => {
  const child = src.slice(src.indexOf('function FadingPhoto'), src.indexOf('export function MediaView'))
  t.absent(child.includes('MediaBackdrop'), 'no backdrop in FadingPhoto')
  t.absent(child.includes('blurRadius'), 'no blur in FadingPhoto')
})
