'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '../src/ui/ListingPhotoGrid.js'), 'utf8')

test('empty grid is a dashed add target', (t) => {
  t.ok(src.includes('if (list.length === 0)'), 'empty branch')
  t.ok(src.includes("borderStyle: 'dashed'"), 'dashed')
  t.ok(src.includes('Adicionar fotos'), 'label')
})

test('first photo is the cover', (t) => {
  t.ok(src.includes('i === 0 ? <Text style={styles.cover}>Capa</Text>'), 'Capa on index 0 only')
})

test('moves use the existing helper and report the new list', (t) => {
  t.ok(src.includes("import { moveById } from '../photoOrder'"), 'import')
  t.ok(src.includes('moveById(list, id, delta)'), 'call')
  t.ok(src.includes('move(p.id, -1)') && src.includes('move(p.id, 1)'), 'earlier and later')
  t.ok(src.includes('if (moveById(list, id, delta) !== list && typeof onMove === \'function\') onMove(id, delta)'), 'reports the photo and the step, only for a real move')
  t.absent(/onChange\(/.test(src), 'never reports a list computed from this render')
})

test('every control has a 44 pt target and a pt-BR label', (t) => {
  t.ok(src.includes('width: layout.hit, height: layout.hit'), 'hit target')
  for (const label of ['para antes', 'para depois', "'Remover foto '", "'Adicionar fotos'"]) t.ok(src.includes(label), label)
})

test('controls are overlays inside the photo square, never a row of three targets', (t) => {
  t.ok(src.includes("position: 'absolute', width: layout.hit"), 'absolute hit target')
  t.absent(/actions:/.test(src), 'no action row')
  const photo = src.slice(src.indexOf('<View style={styles.photo}>'), src.indexOf('{!full && canAdd'))
  t.ok(photo.includes('styles.topRight') && photo.includes('styles.bottomLeft') && photo.includes('styles.bottomRight'), 'three corners inside the photo')
})

test('a kept photo with no local thumb shows the atual placeholder, never an empty square', (t) => {
  const photo = src.slice(src.indexOf('<View style={styles.photo}>'), src.indexOf('{i === 0 ?'))
  t.ok(photo.includes('p.thumb'), 'branches on the thumb')
  t.ok(photo.includes("<Icon name='imagem'") && photo.includes('>atual</Text>'), 'placeholder icon and label')
  t.absent(/p\.thumb \? <Image[^\n]*\/> : null/.test(src), 'no empty branch')
})

test('no drag, camera, platform branch or em dash', (t) => {
  t.absent(/PanResponder|expo-camera|Platform\.OS/.test(src), 'none')
  t.absent(src.includes('\u2014'), 'no em dash')
})
