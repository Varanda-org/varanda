'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')
const diario = read('screens/Diario.js')
const membro = read('screens/Membro.js')
const grid = read('ui/MuralGrid.js')
const header = read('ui/ProfileHeader.js')

const count = (src, text) => src.split(text).length - 1

test('both screens import Segmented, the Mural row pieces and the mural module', (t) => {
  for (const [name, src] of [['Diario', diario], ['Membro', membro]]) {
    t.ok(/import \{ Segmented \} from '\.\.\/ui\/Segmented'/.test(src), name + ' Segmented')
    t.ok(/import \{[^}]*MuralRow[^}]*\} from '\.\.\/ui\/MuralGrid'/.test(src), name + ' MuralRow')
    t.ok(/import \{[^}]*MuralFooter[^}]*\} from '\.\.\/ui\/MuralGrid'/.test(src), name + ' MuralFooter')
    t.ok(/from '\.\.\/mural'/.test(src), name + ' mural module')
    t.ok(src.includes("{ id: 'mural', label: 'Mural' }"), name + ' tab')
  }
})

test('each screen feeds the Mural from data it already has', (t) => {
  t.ok(diario.includes('tilesFromLog('), 'Diario tilesFromLog')
  t.ok(membro.includes('tilesFromItems(') && membro.includes('applyCut('), 'Membro tilesFromItems and applyCut')
  t.ok(membro.includes('movedView.cut'), 'Membro uses the moved cut')
  t.ok(diario.includes('fillState(') && membro.includes('fillState('), 'bounded fill')
  // One way to publish: the compose button. The empty own Mural says where
  // published photos appear instead of a second publish pill.
  t.absent(diario.includes('Publicar foto'), 'no second publish entry')
  t.ok(diario.includes("emptyBody='As fotos que você publicar aparecem aqui.'"), 'own empty Mural line')
})

test('a tile opens the thread with an object entry', (t) => {
  // An object, never a bare ref (nav.js refuses it), seeded with the loaded
  // post so the thread shows it offline too.
  for (const src of [diario, membro]) t.ok(src.includes('onOpenThread({ ref: tile.ref, seed: muralSeed(tile) })'), 'object seeded with the tile post')
})

test('one RefreshableList per screen and the header takes the tabs', (t) => {
  t.is(count(diario, '<RefreshableList'), 1, 'Diario')
  t.is(count(membro, '<RefreshableList'), 1, 'Membro')
  t.absent(/<MuralGrid\b/.test(diario) || /<MuralGrid\b/.test(membro), 'no nested MuralGrid list')
  t.ok(header.includes('tabs'), 'ProfileHeader tabs')
})

test('the empty Mural text lives only in MuralGrid.js', (t) => {
  t.ok(grid.includes('Nenhuma foto ainda'), 'MuralGrid')
  t.absent(diario.includes('Nenhuma foto ainda'), 'Diario')
  t.absent(membro.includes('Nenhuma foto ainda'), 'Membro')
})

test('a short list can still scroll the profile band away', (t) => {
  // Without a minimum height a short Mural rests with the profile bar half
  // faded (the scroll cannot reach the point where the bar takes over).
  t.ok(diario.includes('minHeight: windowHeight + bandHeight + 8'), 'Diario')
  t.ok(membro.includes('minHeight: windowHeight + insets.top + BAND + 8'), 'Membro')
})
