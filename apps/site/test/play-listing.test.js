'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const FILE = path.join(__dirname, '..', 'artwork', 'play', 'listing.pt-BR.json')
const listing = JSON.parse(fs.readFileSync(FILE, 'utf8'))

test('play listing: text limits of the Play Console', (t) => {
  t.ok(listing.title.length > 0 && listing.title.length <= 30, 'title ' + listing.title.length + ' <= 30')
  t.ok(listing.shortDescription.length > 0 && listing.shortDescription.length <= 80, 'short ' + listing.shortDescription.length + ' <= 80')
  t.ok(listing.fullDescription.length > 0 && listing.fullDescription.length <= 4000, 'full ' + listing.fullDescription.length + ' <= 4000')
})

test('play listing: the three URLs are https://varanda.app/ pages that exist', (t) => {
  const urls = { privacyPolicyUrl: 'privacidade', accountDeletionUrl: 'excluir-conta', childSafetyUrl: 'seguranca-infantil' }
  for (const [key, dir] of Object.entries(urls)) {
    t.is(listing[key], 'https://varanda.app/' + dir + '/', key)
    t.ok(fs.existsSync(path.join(__dirname, '..', 'public', dir, 'index.html')), dir + ' page exists')
  }
})

test('play listing: no em dash and no keys beyond the expected ones', (t) => {
  t.absent(JSON.stringify(listing).includes(String.fromCharCode(0x2014)), 'no U+2014')
  t.alike(Object.keys(listing).sort(), ['accountDeletionUrl', 'childSafetyUrl', 'fullDescription', 'privacyPolicyUrl', 'shortDescription', 'title'])
})
