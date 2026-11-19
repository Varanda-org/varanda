'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

test('a community list row title wraps to two lines under large text', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Comunidades.js'), 'utf8')
  t.ok(src.includes('dot && styles.nameUnread]} numberOfLines={2}>{title}'), 'two title lines')
  t.absent(src.includes('styles.nameUnread]} numberOfLines={1}'), 'not cut to one')
})

test('group and community surfaces pass validated image props to their avatars', (t) => {
  const source = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8')
  for (const file of ['screens/Grupo.js', 'screens/Comunidade.js']) {
    const header = source(file).split('<ChatHeader')[1].split('/>')[0]
    t.ok(header.includes(file.endsWith('/Comunidade.js') ? '{...pictureProps(needIndex ? indexImageRow({ ...info, community }, indexImages) : info)}' : '{...pictureProps(info)}'), file + ' real header')
  }
  const communities = source('screens/Comunidades.js')
  t.ok(communities.includes('image={item.image}'))
  t.ok(communities.includes('imageAuthor={item.imageAuthor}'))
  t.ok(communities.includes('{...pictureProps({ image, imageAuthor })}'))
  const community = source('screens/Comunidade.js')
  t.ok(community.includes('publicKey={group} {...pictureProps({ visibility, image, imageAuthor })}'))
  const rows = community.match(/<GroupRow\b[^>]*>/g)
  t.is(rows.filter((row) => !row.includes('catalogue') && row.includes('image={g.image}') && row.includes('imageAuthor={g.imageAuthor}') && row.includes('visibility={g.visibility}')).length, 3, 'all three live group row branches carry their own image and visibility')
  t.absent(rows.some((row) => row.includes('info.image')), 'never inherits the community image')
  t.ok(rows[0].includes('catalogue') && rows[0].includes('image={g.image}'), 'index catalogue receives its own image')
  t.ok(community.includes("catalogue && visibility === 'private'\n        ? <Icon name='cadeira'"), 'private catalogue rows keep the chair')
  t.ok(community.includes('useIndexGroupImages(node, [...idx.groups, { ...info, community }], idx,'), 'header and catalogue share one page')
  t.ok(community.includes('const g = indexImageRow(row, indexImages)'), 'catalogue applies the map')
  t.ok(communities.includes('const h = indexImageRow(hit, searchImages)'), 'search applies the map')
  t.ok(communities.includes('item = indexImageRow(item, communityImages)'), 'community list applies the map')
  t.ok(communities.includes("saveGroupSnapshot('comunidades', binding, rows, gen)"), 'snapshot still takes only node rows')
  const box = source('ui/CommunitiesBox.js')
  t.ok(box.includes('const picture = pictureProps(item)') && /<Avatar[^>]*\{\.\.\.picture\}/.test(box), 'Mark passes the validated picture')
  t.ok(box.includes("if (picture.picture === null) return <Icon name='gente'"), 'no image keeps the people icon')
  t.is((box.match(/<Mark item=\{item\}/g) || []).length, 2, 'strip and full list')
})

const key = (n) => n.toString(16).padStart(64, '0')
const image = { core: key(90), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1000, sha256: key(91), width: 512, height: 512 }
const author = key(92)

async function imageHarness (fetchGroupImages, fetchGroupSearch = async () => ({ ok: true, value: { groups: [] } })) {
  const { pictureProps } = await import('../src/groupImage.js')
  const { GROUP_LIST_LIMIT, GROUP_LIST_PAGES } = await import('../src/groupShelves.js')
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
  const body = source.slice(source.indexOf('function indexImageKey ('), source.indexOf('function communityTitle (')).replace(/export /g, '')
  const searchBody = source.slice(source.indexOf('function useGroupSearch ('), source.indexOf('// The community name of each search row:'))
  const slots = []
  const effects = []
  const timers = new Set()
  let cursor = 0
  let dirty = false
  let writes = 0
  const useState = (initial) => {
    const slot = (slots[cursor++] ??= { value: initial })
    return [slot.value, (value) => {
      writes++
      if (typeof value === 'function') value = value(slot.value)
      if (slot.value !== value) {
        slot.value = value
        dirty = true
      }
    }]
  }
  const useRef = (initial) => (slots[cursor++] ??= { current: initial })
  const useCallback = (fn, deps) => {
    const slot = (slots[cursor++] ??= {})
    if (!slot.deps || !deps.every((value, i) => Object.is(value, slot.deps[i]))) {
      slot.deps = deps
      slot.fn = fn
    }
    return slot.fn
  }
  const useEffect = (effect, deps) => {
    const slot = (slots[cursor++] ??= {})
    if (slot.deps && deps.every((value, i) => Object.is(value, slot.deps[i]))) return
    slot.deps = deps
    effects.push(() => {
      slot.cleanup?.()
      slot.cleanup = effect()
    })
  }
  // eslint-disable-next-line no-new-func
  const helpers = new Function('useState', 'useEffect', 'useRef', 'useCallback', 'fetchGroupImages', 'fetchGroupSearch', 'pictureProps', 'HEX64', 'GROUP_LIST_LIMIT', 'GROUP_LIST_PAGES', 'queryPath', 'SEARCH_DELAY_MS', 'setTimeout', 'clearTimeout', body + searchBody + '\nreturn { indexImageRow, useIndexGroupImages, useGroupSearch, heldSearchRows: typeof heldSearchRows === "function" ? heldSearchRows : null }')(
    useState, useEffect, useRef, useCallback, fetchGroupImages, fetchGroupSearch, pictureProps, /^[0-9a-f]{64}$/, GROUP_LIST_LIMIT, GROUP_LIST_PAGES,
    (text) => text || null, 400, (fn) => { timers.add(fn); return fn }, (fn) => timers.delete(fn)
  )
  const rpcCalls = []
  const node = { hosted: true, online: true, request: (method) => { rpcCalls.push(method) } }
  async function settle (render) {
    let result
    do {
      dirty = false
      cursor = 0
      result = render()
      for (const effect of effects.splice(0)) effect()
      for (const timer of [...timers]) { timers.delete(timer); timer() }
      await new Promise((resolve) => setImmediate(resolve))
    } while (dirty)
    return result
  }
  return {
    ...helpers,
    pictureProps,
    node,
    rpcCalls,
    writes: () => writes,
    render (rows, page = rows, enabled = true) {
      return settle(() => helpers.useIndexGroupImages(node, rows, page, enabled))
    },
    renderSearch (text) {
      return settle(() => {
        const search = helpers.useGroupSearch.length === 1 ? helpers.useGroupSearch(text) : helpers.useGroupSearch(node, text)
        const rows = search.rows || search.groups
        const images = helpers.useIndexGroupImages(node, rows, search.groups, search.status === 'done')
        return { search, rows, images }
      })
    },
    unmount () { for (const slot of slots) slot.cleanup?.() }
  }
}

test('an index hit supplies picture and mediaAuthor without changing the original row', async (t) => {
  const h = await imageHarness(async () => new Map())
  const row = { group: key(1), name: 'Jardim' }
  const map = new Map([[row.group, { image, author }]])
  t.alike(h.pictureProps(h.indexImageRow(row, map)), { picture: image, mediaAuthor: author })
  t.absent(Object.hasOwn(row, 'image'), 'no index image is added to snapshot input')
  for (const images of [new Map(), new Map([[row.group, { image, author: 'invalid' }]]), new Map([[row.group, { image: { ...image, width: 1 }, author }]])]) {
    t.is(h.indexImageRow(row, images), row)
    t.alike(h.pictureProps(h.indexImageRow(row, images)), { picture: null, mediaAuthor: null }, 'initials')
  }
})

test('image pages skip node answers and private rows, deduplicate keys and never join', async (t) => {
  const calls = []
  const h = await imageHarness(async (keys) => {
    calls.push(keys)
    return new Map(keys.map((key) => [key, { image, author }]))
  })
  const rows = [
    { group: key(1), visibility: 'public' },
    { group: key(1) },
    { community: key(2) },
    { group: key(3), image, imageAuthor: author },
    { community: key(4), image: null, imageAuthor: null },
    { group: key(5), visibility: 'private' }
  ]
  const images = await h.render(rows)
  await h.render(rows)
  t.alike(calls, [[key(1), key(2)]], 'once for this page')
  for (const row of rows.slice(3)) {
    t.is(h.indexImageRow(row, new Map([[row.group || row.community, { image, author }]])), row, 'node answer or private row retained')
  }
  t.alike(h.pictureProps(h.indexImageRow(rows[2], images)), { picture: image, mediaAuthor: author }, 'community rows use their key')
  t.alike(h.rpcCalls, [], 'neither group.join nor community.join nor any RPC')
  h.unmount()
})

test('32 public catalogue groups plus the header fetch all 33 images in batches of at most 32', async (t) => {
  const calls = []
  const h = await imageHarness(async (keys) => {
    calls.push(keys)
    return new Map(keys.map((key) => [key, { image, author }]))
  })
  const groups = Array.from({ length: 32 }, (_, i) => ({ group: key(i + 1), visibility: 'public' }))
  const header = { community: key(33), state: 'pending', image: null, imageAuthor: null }
  const rows = [...groups, header, groups[0], header]
  const images = await h.render(rows)
  t.alike(calls.map((batch) => batch.length), [32, 1])
  t.alike(calls.flat(), Array.from({ length: 33 }, (_, i) => key(i + 1)))
  t.is(images.size, 33)
  for (const row of [...groups, header]) t.alike(h.pictureProps(h.indexImageRow(row, images)), { picture: image, mediaAuthor: author })
  h.unmount()
})

test('failed image fetches keep initials silently and do not repeat on render', async (t) => {
  for (const fail of [async () => { throw new Error('offline') }, async () => new Map()]) {
    let calls = 0
    const h = await imageHarness(async () => { calls++; return fail() })
    const rows = [{ group: key(1) }]
    const images = await h.render(rows)
    t.alike(h.pictureProps(h.indexImageRow(rows[0], images)), { picture: null, mediaAuthor: null })
    await h.render(rows)
    t.is(calls, 1)
    t.alike(h.rpcCalls, [])
    h.unmount()
  }
})

test('image fetching requires hosted and online and an active page', async (t) => {
  const calls = []
  const h = await imageHarness(async (keys) => { calls.push(keys); return new Map() })
  const rows = [{ group: key(1) }]
  h.node.hosted = false
  await h.render(rows)
  h.node.hosted = true
  h.node.online = false
  await h.render(rows)
  h.node.online = true
  await h.render(rows, rows, false)
  t.alike(calls, [])
  await h.render(rows)
  t.alike(calls, [[key(1)]])
  h.unmount()
})

test('a stale page stops before its next batch and cannot replace the new page', async (t) => {
  let finish
  const calls = []
  const h = await imageHarness(async (keys) => {
    calls.push(keys)
    if (calls.length === 1) return new Promise((resolve) => { finish = resolve })
    return new Map(keys.map((key) => [key, { image, author }]))
  })
  const old = Array.from({ length: 33 }, (_, i) => ({ group: key(i + 1) }))
  await h.render(old)
  const rows = [{ group: key(40) }]
  await h.render(rows)
  finish(new Map([[key(1), { image, author }]]))
  const images = await h.render(rows)
  t.alike(calls.map((batch) => batch.length), [32, 1], 'no second batch for the stale catalogue')
  t.alike([...images.keys()], [key(40)])
  h.unmount()
})

test('unmount and going offline discard an in-flight image answer', async (t) => {
  for (const unmount of [true, false]) {
    let finish
    const h = await imageHarness(() => new Promise((resolve) => { finish = resolve }))
    const rows = [{ group: key(1) }]
    await h.render(rows)
    if (unmount) h.unmount()
    else { h.node.online = false; await h.render(rows) }
    const writes = h.writes()
    finish(new Map([[key(1), { image, author }]]))
    await new Promise((resolve) => setImmediate(resolve))
    t.is(h.writes(), writes, 'no late state update')
    h.unmount()
  }
})

function searchHarness (hits, answer) {
  const calls = []
  const rpcCalls = []
  return imageHarness(async (keys) => {
    calls.push(keys)
    return new Map(keys.map((key) => [key, { image, author }]))
  }, async () => ({ ok: true, value: { groups: hits } })).then((h) => {
    h.node.request = async (method, params) => {
      rpcCalls.push({ method, ...params })
      return answer(params)
    }
    return { ...h, calls, rpcCalls }
  })
}

test('search keeps a held public group removal or missing image despite a stale index image', async (t) => {
  for (const fields of [{ image: null, imageAuthor: null }, {}]) {
    const hits = [{ group: key(1), name: 'Jardim', writerCount: 2 }]
    const nodeRows = [{ group: key(1), role: 'member', visibility: 'public', ...fields }]
    const h = await searchHarness(hits, () => ({ groups: nodeRows, total: 1 }))
    const { rows } = await h.renderSearch('jardim')
    t.alike(h.calls, [], 'held key is never asked from the index')
    t.alike(h.pictureProps(h.indexImageRow(rows[0], new Map([[key(1), { image, author }]]))), { picture: null, mediaAuthor: null }, 'keeps initials even with a stale map')
    t.is(rows[0].image, null, 'missing image is also an explicit node answer')
    t.is(typeof h.heldSearchRows, 'function', 'exports a pure reconciliation helper')
    if (h.heldSearchRows) t.alike(h.heldSearchRows(hits, nodeRows), rows, 'pure helper reconciles raw search hits')
    t.absent(Object.hasOwn(hits[0], 'image'), 'does not mutate search input')
    t.alike(nodeRows[0], { group: key(1), role: 'member', visibility: 'public', ...fields }, 'does not mutate node input')
    h.unmount()
  }
})

test('search keeps a held group image and never asks for a held private group key', async (t) => {
  const ownImage = { ...image, core: key(93) }
  const ownAuthor = key(94)
  const hits = [{ group: key(1), name: 'Jardim', writerCount: 2 }, { group: key(2), name: 'Casa', writerCount: 1 }]
  const h = await searchHarness(hits, () => ({
    groups: [
      { group: key(1), role: 'member', visibility: 'public', image: ownImage, imageAuthor: ownAuthor },
      { group: key(2), role: 'member', visibility: 'private' }
    ],
    total: 2
  }))
  const { rows } = await h.renderSearch('jardim')
  const stale = new Map(hits.map(({ group }) => [group, { image, author }]))
  t.alike(h.calls, [], 'neither held public nor held private keys leave for index images')
  t.alike(h.pictureProps(h.indexImageRow(rows[0], stale)), { picture: ownImage, mediaAuthor: ownAuthor })
  t.alike(h.pictureProps(h.indexImageRow(rows[1], stale)), { picture: null, mediaAuthor: null })
  h.unmount()
})

test('search waits for the node list before asking and drawing an unheld hit from the index', async (t) => {
  let finish
  const hits = [{ group: key(1), name: 'Jardim', writerCount: 2 }]
  const h = await searchHarness(hits, () => new Promise((resolve) => { finish = resolve }))
  let result = await h.renderSearch('jardim')
  t.is(result.search.status, 'done', 'search hits can show while the node list is pending')
  t.alike(h.calls, [], 'no index image request before group.list answers')
  t.alike(h.pictureProps(h.indexImageRow(result.rows[0], result.images)), { picture: null, mediaAuthor: null })
  finish?.({ groups: [], total: 0 })
  result = await h.renderSearch('jardim')
  await h.renderSearch('jardim')
  t.alike(h.calls, [[key(1)]], 'unheld hit is asked once')
  t.alike(h.pictureProps(h.indexImageRow(result.rows[0], result.images)), { picture: image, mediaAuthor: author })
  t.alike(h.rpcCalls.map(({ method }) => method), ['group.list'], 'one list read, no join or save')
  h.unmount()
})

test('failed or malformed group.list leaves every search hit at initials without retry', async (t) => {
  const bad = [null, {}, { groups: {}, total: 0 }, { groups: [], total: -1 }, { groups: [], total: 0.5 }, { groups: [], total: '0' }, { groups: [null], total: 1 }, { groups: [{ group: key(1) }], total: 1 }, { groups: [{ group: 1, role: 'member' }], total: 1 }]
  const answers = [() => { throw new Error('offline') }, ...bad.map((page) => () => page)]
  for (const answer of answers) {
    const h = await searchHarness([{ group: key(1), name: 'Jardim', writerCount: 2 }], answer)
    const { search, rows, images } = await h.renderSearch('jardim')
    await h.renderSearch('jardim')
    t.alike(h.calls, [], 'no index image request')
    t.alike(h.pictureProps(h.indexImageRow(rows[0], images)), { picture: null, mediaAuthor: null })
    t.is(search.error, '', 'silent fallback')
    t.is(h.rpcCalls.length, 1, 'no retry')
    h.unmount()
  }
})

test('search image requests and rendered avatars use reconciled rows', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
  t.ok(source.includes('rows: heldSearchRows(state.groups, state.nodeRows)'), 'pure helper reconciles node and search rows')
  t.ok(source.includes("useIndexGroupImages(node, search.rows, search.groups, search.status === 'done')"), 'image hook takes reconciled hits')
  t.absent(source.includes('useIndexGroupImages(node, search.groups,'), 'raw index hits never feed image requests')
  t.ok(source.includes('const hits = search.rows.map((hit) => {'), 'rendering uses the same reconciliation')
  t.ok(source.includes('const h = indexImageRow(hit, searchImages)') && source.includes('image={h.image}') && source.includes('imageAuthor={h.imageAuthor}'), 'node or index image reaches the existing avatar path')
})

test('search group.list uses the shelf page bounds and validates every page', async (t) => {
  const { GROUP_LIST_LIMIT, GROUP_LIST_PAGES } = await import('../src/groupShelves.js')
  const hits = [{ group: key(GROUP_LIST_LIMIT + 1), name: 'Jardim', writerCount: 2 }]
  const h = await searchHarness(hits, ({ offset, limit }) => ({
    groups: Array.from({ length: limit }, (_, i) => ({ group: key(offset + i + 1), role: 'member', image, imageAuthor: author })),
    total: 1000
  }))
  const { rows, images } = await h.renderSearch('jardim')
  t.alike(h.rpcCalls, Array.from({ length: GROUP_LIST_PAGES }, (_, i) => ({ method: 'group.list', offset: i * GROUP_LIST_LIMIT, limit: GROUP_LIST_LIMIT })))
  t.alike(h.calls, [], 'a held group from the second page is not asked')
  t.alike(h.pictureProps(h.indexImageRow(rows[0], images)), { picture: image, mediaAuthor: author })
  h.unmount()

  const broken = await searchHarness(hits, ({ offset }) => offset === 0 ? { groups: [{ group: key(1), role: 'member' }], total: 2 } : { groups: [], total: null })
  await broken.renderSearch('jardim')
  t.is(broken.rpcCalls.length, 2)
  t.alike(broken.calls, [], 'bad later page discards the whole node answer')
  broken.unmount()
})

test('a new search generation or unmount discards the old node list before the next page', async (t) => {
  for (const unmount of [true, false]) {
    let finish
    const h = await searchHarness([{ group: key(1), name: 'Jardim', writerCount: 2 }], () => {
      if (!finish) return new Promise((resolve) => { finish = resolve })
      return { groups: [{ group: key(1), role: 'member', image: null }], total: 1 }
    })
    await h.renderSearch('jardim')
    if (unmount) h.unmount()
    else await h.renderSearch('outro jardim')
    const writes = h.writes()
    finish?.({ groups: [{ group: key(2), role: 'member' }], total: 100 })
    await new Promise((resolve) => setImmediate(resolve))
    t.is(h.writes(), writes, 'stale list cannot replace the current answer')
    t.is(h.rpcCalls.length, unmount ? 1 : 2, 'no next page for the old generation')
    t.alike(h.calls, [], 'no stale list can enable index image requests')
    h.unmount()
  }
})

test('an empty search does not read group.list', async (t) => {
  const h = await searchHarness([], () => { throw new Error('unexpected request') })
  await h.renderSearch('jardim')
  t.alike(h.rpcCalls, [])
  t.alike(h.calls, [])
  h.unmount()
})
