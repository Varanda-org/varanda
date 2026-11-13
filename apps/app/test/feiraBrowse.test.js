'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { feira, displayText } = require('@varanda/rpc')
const load = () => import('../src/feiraBrowse.js')
const read = (file) => readFileSync(join(__dirname, '..', 'src', file), 'utf8')
const row = (id, price, kind = 'produto') => Object.freeze({ id, price, kind })
const ids = (rows) => rows.map((row) => row.id)
const rows = Object.freeze([
  row('wanted', 100, 'procura'),
  row('high', 2000),
  row('unknown', null),
  row('free', 0),
  row('low-a', 100),
  row('unknown-service', null, 'servico'),
  row('low-b', 100, 'servico'),
  row('wanted-free', 0, 'procura'),
  row('wanted-unknown', null, 'procura')
])

test('browse keeps recent input order and never mutates rows', async (t) => {
  const { browseListings } = await load()
  const recent = browseListings(rows, { sort: 'recentes' })
  t.alike(recent, rows)
  t.not(recent, rows)
  t.alike(browseListings(rows), rows)
  t.alike(browseListings([], { sort: 'maior' }), [])
  for (const sort of ['menor', 'maior']) {
    const result = browseListings(rows, { sort })
    t.is(result.length, rows.length)
    for (const item of result) t.is(item, rows.find((r) => r.id === item.id))
  }
})

test('price sorts are stable, free is lowest, null and procura stay last', async (t) => {
  const { browseListings } = await load()
  const tail = ['unknown', 'unknown-service', 'wanted-unknown']
  t.alike(ids(browseListings(rows, { sort: 'menor' })), ['free', 'low-a', 'low-b', 'high', 'wanted-free', 'wanted', ...tail])
  t.alike(ids(browseListings(rows, { sort: 'maior' })), ['high', 'low-a', 'low-b', 'free', 'wanted', 'wanted-free', ...tail])
  const equal = [row('one', 50), row('two', 50), row('three', 50)]
  for (const sort of ['recentes', 'menor', 'maior']) t.alike(browseListings(equal, { sort }), equal)
})

test('procura sorts by ceiling with stable ties and null prices last', async (t) => {
  const { browseListings } = await load()
  const wanted = [
    row('unknown-a', null, 'procura'),
    row('mid-a', 100, 'procura'),
    row('free', 0, 'procura'),
    row('high', 2000, 'procura'),
    row('unknown-b', null, 'procura'),
    row('mid-b', 100, 'procura')
  ]
  t.alike(ids(browseListings(wanted, { sort: 'menor' })), ['free', 'mid-a', 'mid-b', 'high', 'unknown-a', 'unknown-b'])
  t.alike(ids(browseListings(wanted, { sort: 'maior' })), ['high', 'mid-a', 'mid-b', 'free', 'unknown-a', 'unknown-b'])
})

test('price bounds are inclusive and exclude null even for a zero bound', async (t) => {
  const { browseListings } = await load()
  t.alike(ids(browseListings(rows, { minCents: 0 })), ['wanted', 'high', 'free', 'low-a', 'low-b', 'wanted-free'])
  t.alike(ids(browseListings(rows, { maxCents: 0 })), ['free', 'wanted-free'])
  t.alike(ids(browseListings(rows, { minCents: 100, maxCents: 100 })), ['wanted', 'low-a', 'low-b'])
  t.alike(ids(browseListings(rows, { minCents: 100, maxCents: 2000, sort: 'maior' })), ['high', 'low-a', 'low-b', 'wanted'])
  t.alike(ids(browseListings(rows, { minCents: 2000 })), ['high'])
  t.alike(browseListings(rows, { minCents: 2001 }), [])
  t.alike(browseListings(rows, { minCents: 100, maxCents: 0 }), [])
  t.alike(browseListings(rows, { minCents: null, maxCents: null }), rows)
})

test('grid rows retain the remainder and item references', async (t) => {
  const { gridRows } = await load()
  const items = Object.freeze([1, 2, 3, 4, 5])
  t.alike(gridRows(items, 2), [[1, 2], [3, 4], [5]])
  t.alike(gridRows(items, 3), [[1, 2, 3], [4, 5]])
  t.alike(gridRows(items, 1), [[1], [2], [3], [4], [5]])
  t.alike(gridRows(items, 8), [[1, 2, 3, 4, 5]])
  t.alike(gridRows([1, 2, 3, 4], 2), [[1, 2], [3, 4]])
  t.alike(gridRows([], 2), [])
  t.is(gridRows(rows, 2)[0][0], rows[0])
  for (const cols of [0, -1, 1.5, NaN, Infinity, undefined]) await t.exception.all(() => gridRows(items, cols), /cols must be a positive integer/)
})

test('columns follow width thresholds and Android large text rounding', async (t) => {
  const { columnsFor } = await load()
  const theme = read('ui/theme.js')
  const largeText = Number(/export const LARGE_TEXT = ([0-9.]+)/.exec(theme)[1])
  const androidScale = 1.2999999523
  const normalScale = 1.28
  t.is(largeText, 1.29)
  for (const [width, count] of [[0, 1], [359, 1], [360, 2], [599, 2], [600, 3], [899, 3], [900, 4], [1200, 4]]) {
    t.is(columnsFor(width, false), count)
    t.is(columnsFor(width, true), 1)
    t.is(columnsFor(width, androidScale >= largeText), 1)
  }
  t.is(columnsFor(900, normalScale >= largeText), 4)
})

test('columns default to one when width is not a finite number', async (t) => {
  const { columnsFor } = await load()
  for (const width of [undefined, NaN, '500', Infinity]) {
    t.is(columnsFor(width), 1, String(width))
  }
})

test('place labels sanitize peer strings and category icons cover the RPC set', async (t) => {
  const { placeLabel, CATEGORY_ICONS, PARTIAL_NOTE } = await load()
  t.is(placeLabel({ city: 'São Paulo', uf: 'SP' }), 'São Paulo, SP')
  t.is(placeLabel({ city: 'Recife' }), 'Recife')
  t.is(placeLabel({ uf: 'PE' }), 'PE')
  t.is(placeLabel(), '')
  t.is(placeLabel({ city: 7, uf: {} }), '')
  t.is(placeLabel({ city: 'São\u202e Paulo', uf: 'S\u0000P' }), [displayText('São\u202e Paulo'), displayText('S\u0000P')].join(', '))
  t.alike(Object.keys(CATEGORY_ICONS), feira.CATS)
  t.is(Object.keys(CATEGORY_ICONS).length, 12)
  t.ok(Object.isFrozen(CATEGORY_ICONS))
  const icons = read('ui/Icon.js')
  for (const id of feira.CATS) {
    t.is(CATEGORY_ICONS[id], 'cat_' + id)
    t.ok(icons.includes(CATEGORY_ICONS[id] + ':'))
  }
  t.is(PARTIAL_NOTE, 'Ordem e faixa de preço valem para os anúncios já carregados')
})

test('browse stays pure and storefront blocks use shared mobile primitives', (t) => {
  const pure = read('feiraBrowse.js')
  t.absent(/from ['"](?:react|react-native|.*ui\/theme|node:)/.test(pure))
  for (const file of ['ListingTile', 'CategoryTiles', 'FeiraFilters', 'PlaceSheet']) {
    const src = read('ui/' + file + '.js')
    t.absent(src.includes('Platform.OS'), file + ' uses shared behavior')
    t.absent(src.includes('numColumns'), file + ' does not change list columns')
    t.absent(src.includes('\u2014'))
    t.ok(src.includes('useStyles(makeStyles)'), file + ' follows the active theme')
  }
  const tile = read('ui/ListingTile.js')
  t.ok(tile.includes('<PressScale') && tile.includes("accessibilityRole='button'"))
  t.ok(tile.includes('[title, price, city, text(badge)].filter(Boolean).join(\', \')'))
  t.ok(tile.includes('text(listing.title)') && tile.includes('text(priceLabel(listing.price, listing.unit, listing.kind))'))
  t.ok(tile.includes('placeLabel(listing.place || {})'))
  t.ok(tile.includes('aspectRatio: 1') && tile.includes('...type.price') && tile.includes('numberOfLines={2}'))
  t.ok(tile.includes("listing.kind === 'procura' ? 'Procura'"))
  t.ok(tile.includes('persist={false} tapRetry={false}'))
  t.ok(tile.includes("importantForAccessibility='no-hide-descendants' aria-hidden"))
  const categories = read('ui/CategoryTiles.js')
  t.ok(categories.includes("[{ id: 'todas', label: 'Todas' }, ...Object.entries(CAT_LABELS)"))
  t.ok(categories.includes('<ScrollView horizontal'))
  t.ok(categories.includes('minWidth: layout.hit, minHeight: layout.hit'))
  t.ok(categories.includes('accessibilityState={{ selected: value === id }}'))
  const filters = read('ui/FeiraFilters.js')
  t.absent(filters.includes('decimal-pad'), 'price fields keep the comma reachable on the default keyboard')
  for (const label of ['Recentes', 'Menor preço', 'Maior preço', 'De', 'Até', 'Aplicar', 'Limpar']) t.ok(filters.includes("'" + label + "'"))
  t.ok(filters.includes('parsePriceText(draft.min)') && filters.includes('parsePriceText(draft.max)'))
  t.ok(filters.includes('minCents > maxCents') && filters.includes('minCents === null') && filters.includes('maxCents === null'))
  t.ok(filters.includes('options={KIND_OPTIONS}') && filters.includes('{PARTIAL_NOTE}'))
  const place = read('ui/PlaceSheet.js')
  t.ok(place.includes('options={UF_OPTIONS}'))
  t.is(feira.UFS.length, 27)
  t.ok(place.includes("label='Cidade'") && place.includes("label='Ver anúncios'"))
  t.ok(place.includes('if (!searchQuery(place))'))
  for (const src of [filters, place]) {
    t.ok(src.includes('<Sheet open={open} onClose={onClose}'))
    t.ok(src.includes("<ScrollView keyboardShouldPersistTaps='handled'"))
    t.ok(src.includes('if (!open) return'), 'draft resets on opening')
  }
})
