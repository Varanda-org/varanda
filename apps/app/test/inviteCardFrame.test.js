'use strict'

// The invite card frame (src/ui/InviteCardFrame.js) and card shell
// (src/ui/InviteCard.js) read from source: both import react-native, which
// does not load on Node.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { DESIGNS } = require('@varanda/rpc')

const read = (rel) => fs.readFileSync(path.join(__dirname, '../src', rel), 'utf8')
const FRAME = read('ui/InviteCardFrame.js')
const CARD = read('ui/InviteCard.js')
const ART = read('inviteCardArt.js')
const staticColors = /import\s*\{[^}]*\bcolors\b[^}]*\}\s*from/

test('InviteCardFrame: every design id is drawn from the shared art', async (t) => {
  t.ok(FRAME.includes("from '../inviteCardArt'"), 'reads the art module')
  t.ok(FRAME.includes('artFor(design)'), 'picks the art by design id')
  t.ok(FRAME.includes('layoutArt('), 'lays the art out on its width')
  const { ART: art, artFor } = await import('../src/inviteCardArt.js')
  const neutral = artFor('nao-existe')
  for (const id of DESIGNS) {
    t.ok(new RegExp('^  ' + id + ': \\{', 'm').test(ART), id + ': has its own entry')
    t.not(artFor(id), neutral, id + ': not the neutral frame')
    t.ok(art[id].shapes.length > 0, id + ': has shapes')
  }
})

test('InviteCardFrame: plain Views only', (t) => {
  for (const [name, src] of [['frame', FRAME], ['card', CARD], ['art', ART]]) {
    t.absent(src.includes('react-native-svg'), name + ': no svg')
    t.absent(/\bImage\b/.test(src), name + ': no image')
    t.absent(/fontFamily|expo-font|useFonts/.test(src), name + ': no font')
    t.absent(src.includes('Platform'), name + ': no Platform')
    t.absent(/\b(window\.|document\.|navigator\.|globalThis)/.test(src), name + ': no browser global')
    t.absent(staticColors.test(src), name + ': no static colors import')
    t.absent(src.includes('\u2014'), name + ': no em dash')
  }
  t.ok(FRAME.includes('rotate: \'45deg\''), 'diamonds are turned squares')
  t.ok(FRAME.includes("borderLeftColor: 'transparent'"), 'triangles use the border trick')
})

test('InviteCardFrame: colors follow the active scheme', (t) => {
  t.ok(FRAME.includes('useTheme()'), 'reads the scheme')
  t.ok(FRAME.includes('const makeStyles = (colors) => StyleSheet.create('), 'styles per scheme')
  t.ok(CARD.includes('const makeStyles = (colors) => StyleSheet.create('), 'card styles per scheme')
  t.ok(FRAME.includes('backgroundColor: colors.card'), 'text sits on the card panel')
  const bgPairs = ART.match(/bg: pair\('#[0-9a-f]{6}', '#[0-9a-f]{6}'\)/g) || []
  t.ok(bgPairs.length >= DESIGNS.length, 'every design has a light and a dark background')
  t.ok(/light/.test(ART) && /dark/.test(ART), 'light and dark keys')
})

test('InviteCardFrame: decoration is hidden from screen readers and responsive', (t) => {
  t.ok(FRAME.includes('accessible={false}'))
  t.ok(FRAME.includes("importantForAccessibility='no-hide-descendants'"))
  t.ok(FRAME.includes("pointerEvents='none'"), 'shapes never take a touch')
  t.ok(FRAME.includes('INVITE_CARD_MAX_WIDTH = 420'))
  t.ok(FRAME.includes('maxWidth: INVITE_CARD_MAX_WIDTH'))
  t.ok(FRAME.includes('onLayout={onLayout}'), 'laid out on its measured width')
})

test('InviteCard: peer text goes through displayText', (t) => {
  t.ok(CARD.includes("import { displayText } from '@varanda/rpc'"))
  t.ok(CARD.includes("'Pra ' + displayText(name)"))
  t.ok(CARD.includes('displayText(message, { multiline: true })'))
  t.ok(CARD.includes("typeof username === 'string' && username !== ''"), 'username only when given')
  t.ok(CARD.includes("'@' + displayText(username)"))
  t.ok(CARD.includes('{expiryText}'))
  t.ok(/<InviteCardFrame design=\{design\}>[\s\S]*\{children\}[\s\S]*<\/InviteCardFrame>/.test(CARD), 'action slot inside the card')
  t.absent(/pointerEvents/.test(CARD), 'the action works during the motion')
})
