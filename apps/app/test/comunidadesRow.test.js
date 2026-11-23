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
  t.ok(communities.includes("const h = indexImageRow(hit.row, hit.open === 'community' ? searchCommunityImages : searchImages)"), 'search applies the map')
  t.ok(communities.includes('item = indexImageRow(item, communityImages)'), 'community list applies the map')
  t.ok(communities.includes("saveGroupSnapshot('comunidades', binding, rows, gen)"), 'snapshot still takes only node rows')
  const box = source('ui/CommunitiesBox.js')
  t.ok(box.includes('const picture = pictureProps(item)') && /<Avatar[^>]*\{\.\.\.picture\}/.test(box), 'Mark passes the validated picture')
  t.ok(box.includes("if (picture.picture === null) return <Icon name='gente'"), 'no image keeps the people icon')
  t.is((box.match(/<Mark item=\{item\}/g) || []).length, 2, 'strip and full list')
})

const key = (n) => n.toString(16).padStart(64, '0')
const OPEN_BLOCKS = { loadState: 'ok', keys: new Set(), refresh: async () => {} }
const EMPTY_LIST = { rows: [], loaded: true }
const image = { core: key(90), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1000, sha256: key(91), width: 512, height: 512 }
const author = key(92)

async function imageHarness (fetchGroupImages, fetchDiscoverSearch = async () => ({ ok: true, value: { groups: [], communities: [] } })) {
  const { pictureProps } = await import('../src/groupImage.js')
  const { GROUP_LIST_LIMIT, GROUP_LIST_PAGES, visibleRows } = await import('../src/groupShelves.js')
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
  const body = source.slice(source.indexOf('function indexImageKey ('), source.indexOf('function communityTitle (')).replace(/export /g, '')
  const searchBody = source.slice(source.indexOf('const IDLE_SEARCH = '), source.indexOf('// Nova comunidade: community.create')).replace(/export /g, '')
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
  const helpers = new Function('useState', 'useEffect', 'useRef', 'useCallback', 'fetchGroupImages', 'fetchDiscoverSearch', 'pictureProps', 'HEX64', 'GROUP_LIST_LIMIT', 'GROUP_LIST_PAGES', 'queryPath', 'SEARCH_DELAY_MS', 'SEARCH_UNAVAILABLE_TEXT', 'setTimeout', 'clearTimeout', 'visibleRows', body + searchBody + '\nreturn { indexImageRow, useIndexGroupImages, useGroupSearch, searchSections, shownSearch, shownGroupShelves, heldSearchCommunities, heldSearchRows: typeof heldSearchRows === "function" ? heldSearchRows : null }')(
    useState, useEffect, useRef, useCallback, fetchGroupImages, fetchDiscoverSearch, pictureProps, /^[0-9a-f]{64}$/, GROUP_LIST_LIMIT, GROUP_LIST_PAGES,
    (text) => text || null, 400, 'A busca ainda não está disponível.', (fn) => { timers.add(fn); return fn }, (fn) => timers.delete(fn), visibleRows
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
    // As the screen wires it: the shown search (blocks applied, community
    // hits reconciled with `list`) feeds the image hooks and the sections.
    renderSearch (text, blocks = OPEN_BLOCKS, list = EMPTY_LIST, groups = true) {
      return settle(() => {
        const raw = helpers.useGroupSearch(node, text)
        const search = helpers.shownSearch(raw, typeof blocks === 'function' ? blocks() : blocks, list, groups)
        const images = helpers.useIndexGroupImages(node, search.rows, raw.groups, search.status === 'done')
        const communityImages = helpers.useIndexGroupImages(node, search.communities, raw.communities, search.status === 'done')
        return { search, raw, rows: search.rows, images, communityImages }
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
  }, async () => ({ ok: true, value: { groups: hits, communities: [] } })).then((h) => {
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
  t.ok(source.includes("useIndexGroupImages(node, search.rows, rawSearch.groups, search.status === 'done')"), 'image hook takes reconciled, unblocked hits')
  t.ok(source.includes('const search = shownSearch(rawSearch, blocks, list, pageKey === null)'), 'the screen shows only the filtered search')
  t.ok(source.includes('const blocks = useBlocks()'), 'the screen reads the block list')
  t.absent(source.includes('useIndexGroupImages(node, search.groups,') || source.includes('useIndexGroupImages(node, rawSearch.rows') || source.includes('useIndexGroupImages(node, rawSearch.communities'), 'raw index hits never feed image requests')
  t.ok(source.includes("rows.map((g) => ({ key: 'g' + g.group") && source.includes('searchSections(search)'), 'rendering uses the same reconciliation')
  t.ok(source.includes("const h = indexImageRow(hit.row, hit.open === 'community' ? searchCommunityImages : searchImages)") && source.includes('image={h.image}') && source.includes('imageAuthor={h.imageAuthor}'), 'node or index image reaches the existing avatar path')
  t.ok(source.includes("useIndexGroupImages(node, search.communities, rawSearch.communities, search.status === 'done')"), 'community hits ask for their own images')
})

test('a community search hit shows its index photo, asked once on its own page', async (t) => {
  const communities = [{ community: key(7), name: 'Bairro', members: 4 }]
  const calls = []
  const h = await imageHarness(async (keys) => { calls.push(keys); return new Map(keys.map((k) => [k, { image, author }])) }, async () => ({ ok: true, value: { groups: [], communities, moreGroups: false, moreCommunities: false, indexing: false, complete: true } }))
  h.node.request = async () => ({ groups: [], total: 0 })
  await h.renderSearch('bairro')
  const result = await h.renderSearch('bairro')
  await h.renderSearch('bairro')
  t.alike(calls, [[key(7)]], 'the community key is asked once')
  const hit = h.searchSections(result.search)[0].hits[0]
  t.alike(h.pictureProps(h.indexImageRow(hit.row, result.communityImages)), { picture: image, mediaAuthor: author }, 'the photo reaches the avatar')
  h.unmount()
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

test('search shows Comunidades then Grupos, each hit routed to its own screen', async (t) => {
  const communities = [{ community: key(7), name: 'Bairro', members: 4 }]
  const groups = [{ group: key(8), name: 'Horta', writerCount: 2 }]
  const h = await imageHarness(async () => new Map(), async (path) => ({ ok: true, value: { groups, communities, moreGroups: true, moreCommunities: false, indexing: false, complete: true } }))
  h.node.request = async () => ({ groups: [], total: 0 })
  const { search } = await h.renderSearch('bairro')
  const sections = h.searchSections(search)
  t.alike(sections.map((s) => s.title), ['Comunidades', 'Grupos'], 'communities first')
  t.alike(sections.map((s) => s.more), [false, true], 'each list has its own more note')
  t.alike(sections[0].hits.map((x) => [x.open, x.id, x.count]), [['community', key(7), 4]])
  t.alike(sections[1].hits.map((x) => [x.open, x.id, x.count]), [['group', key(8), 2]])
  t.alike(h.searchSections({ communities: [], rows: [], moreCommunities: true, moreGroups: true }), [], 'no empty headed list')
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
  t.ok(source.includes("onPress={() => (hit.open === 'community' ? openCommunity : openGroup)(hit.id)}"), 'a community hit opens Comunidade, a group hit opens Grupo')
  h.unmount()
})

test('a 404 from the discover search says the search is not available yet', async (t) => {
  const h = await imageHarness(async () => new Map(), async () => ({ ok: false, reason: 'not-found' }))
  const { search } = await h.renderSearch('bairro')
  t.is(search.status, 'error')
  t.is(search.unavailable, true)
  t.is(search.error, 'A busca ainda não está disponível.')
  const other = await imageHarness(async () => new Map(), async () => ({ ok: false, reason: 'status' }))
  const res = await other.renderSearch('bairro')
  t.is(res.search.unavailable, false, 'another failure stays retryable')
  h.unmount()
  other.unmount()
})

// Hits as validDiscoverSearch returns them, with the root's creator.
function blockHarness (groups, communities, nodeGroups = []) {
  const calls = []
  return imageHarness(async (keys) => {
    calls.push(keys)
    return new Map(keys.map((k) => [k, { image, author }]))
  }, async () => ({ ok: true, value: { groups, communities, moreGroups: false, moreCommunities: false, indexing: false, complete: true } })).then((h) => {
    h.node.request = async () => ({ groups: nodeGroups, total: nodeGroups.length })
    return { ...h, calls }
  })
}

test('blocked keys and creators leave the search before sections and image requests', async (t) => {
  const groups = [
    { group: key(11), name: 'Horta', creator: key(50), writerCount: 3 },
    { group: key(12), name: 'Horta azul', creator: key(51), writerCount: 2 },
    { group: key(13), name: 'Horta nova', creator: key(52), writerCount: 2 },
    { group: key(14), name: 'Horta velha', creator: key(53), writerCount: 1 }
  ]
  const communities = [
    { community: key(21), name: 'Horta', creator: key(54), members: 5 },
    { community: key(22), name: 'Horta da vila', creator: key(56), members: 4 },
    { community: key(23), name: 'Horta da praia', creator: key(55), members: 3 }
  ]
  const blocked = new Set([key(51), key(13), key(22), key(55)])
  let blocks = { loadState: 'ok', keys: blocked, refresh: async () => {} }
  const h = await blockHarness(groups, communities)
  await h.renderSearch('horta', () => blocks)
  let result = await h.renderSearch('horta', () => blocks)
  let sections = h.searchSections(result.search)
  t.alike(sections.map((s) => [s.id, s.hits.map((x) => x.id)]), [['communities', [key(21)]], ['groups', [key(11), key(14)]]], 'a blocked group key, group creator, community key and community creator are left out')
  const asked = h.calls.flat()
  for (const k of [key(12), key(13), key(22), key(23)]) t.absent(asked.includes(k), 'never asks an image for blocked hit ' + k.slice(-2))
  t.alike(asked.slice().sort(), [key(11), key(14), key(21)], 'only the shown hits are asked')

  blocks = { ...blocks, keys: new Set([...blocked, key(53), key(54)]) }
  result = await h.renderSearch('horta', () => blocks)
  sections = h.searchSections(result.search)
  t.alike(sections.map((s) => [s.id, s.hits.map((x) => x.id)]), [['groups', [key(11)]]], 'a block made while results show hides those hits at once')
  h.unmount()
})

test('no search result shows while the block list is loading, and a failed read shows an error', async (t) => {
  const groups = [{ group: key(11), name: 'Horta', creator: key(50), writerCount: 3 }]
  const communities = [{ community: key(21), name: 'Horta', creator: key(54), members: 5 }]
  let refreshed = 0
  let blocks = { loadState: 'pending', keys: new Set(), refresh: async () => { refreshed++ } }
  const h = await blockHarness(groups, communities)
  await h.renderSearch('horta', () => blocks)
  let result = await h.renderSearch('horta', () => blocks)
  t.is(result.raw.status, 'done', 'the index answered')
  t.is(result.search.status, 'loading', 'the screen keeps the loading state')
  t.alike(h.searchSections(result.search), [], 'no section while blocks load')
  t.alike(h.calls, [], 'no image request while blocks load')
  t.absent(Object.hasOwn(result.search, 'groups'), 'the raw lists never reach the screen')

  blocks = { ...blocks, loadState: 'failed' }
  result = await h.renderSearch('horta', () => blocks)
  t.is(result.search.status, 'error', 'a failed block read is an error, never unfiltered hits')
  t.is(result.search.error, 'Não foi possível buscar agora.')
  t.is(result.search.unavailable, false, 'retryable')
  t.alike(h.searchSections(result.search), [])
  t.alike(h.calls, [], 'no image request after a failed block read')
  result.search.retry()
  t.is(refreshed, 1, 'retry reads the block list again')

  blocks = { ...blocks, loadState: 'ok' }
  await h.renderSearch('horta', () => blocks)
  result = await h.renderSearch('horta', () => blocks)
  t.alike(h.searchSections(result.search).map((s) => s.hits.map((x) => x.id)), [[key(21)], [key(11)]], 'the read list shows the hits')
  h.unmount()
})

test('a community hit the node holds shows the node image and never asks the index', async (t) => {
  const ownImage = { ...image, core: key(95) }
  const ownAuthor = key(96)
  const hits = [
    { community: key(31), name: 'Vila', creator: key(50), members: 2 },
    { community: key(32), name: 'Vila alta', creator: key(50), members: 2 },
    { community: key(33), name: 'Vila baixa', creator: key(50), members: 2 }
  ]
  const pure = await imageHarness(async () => new Map())
  const held = pure.heldSearchCommunities
  pure.unmount()
  const list = { loaded: true, rows: [{ community: key(31), role: 'member', image: ownImage, imageAuthor: ownAuthor }, { community: key(32), role: 'member', image: null }] }
  t.alike(held(hits, list), [
    { ...hits[0], image: ownImage, imageAuthor: ownAuthor },
    { ...hits[1], image: null, imageAuthor: null },
    hits[2]
  ], 'held with an image, held with none, not held')
  t.alike(held(hits, { ...list, loaded: false }), hits.map((x) => ({ ...x, image: null, imageAuthor: null })), 'an unread list asks nothing')
  t.alike(held(hits, null), hits.map((x) => ({ ...x, image: null, imageAuthor: null })), 'no list asks nothing')
  t.absent(Object.hasOwn(hits[0], 'image'), 'does not mutate the hits')
  const pageList = { loaded: true, rows: [{ community: key(31), role: 'member', state: 'ready' }] }
  t.alike(held(hits.slice(0, 1), pageList), hits.slice(0, 1), 'a Página row with no image field keeps the index hint')
  const pendingList = { loaded: true, rows: [{ community: key(31), role: 'member', state: 'pending', image: null, imageAuthor: null }] }
  t.alike(held(hits.slice(0, 1), pendingList), hits.slice(0, 1), 'a pending row keeps the index hint')

  const h = await blockHarness([], hits)
  await h.renderSearch('vila', OPEN_BLOCKS, list)
  const result = await h.renderSearch('vila', OPEN_BLOCKS, list)
  t.alike(h.calls, [[key(33)]], 'only the community the node does not hold is asked')
  const stale = new Map(hits.map((x) => [x.community, { image, author }]))
  const shown = h.searchSections(result.search)[0].hits.map((x) => h.pictureProps(h.indexImageRow(x.row, stale)))
  t.alike(shown, [{ picture: ownImage, mediaAuthor: ownAuthor }, { picture: null, mediaAuthor: null }, { picture: image, mediaAuthor: author }], 'node image, removed image kept removed, index image for the unheld one')
  h.unmount()

  const unread = await blockHarness([], hits)
  await unread.renderSearch('vila', OPEN_BLOCKS, { loaded: false, rows: list.rows })
  await unread.renderSearch('vila', OPEN_BLOCKS, { loaded: false, rows: list.rows })
  t.alike(unread.calls, [], 'no index request while community.list is unread or failed')
  unread.unmount()
})

test('an empty query heads the community shelves "Comunidades" and the group shelves "Grupos"', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
  const communityHead = source.indexOf("{query.trim() === '' && communityShelves.length > 0 ? <SectionHeader>Comunidades</SectionHeader> : null}")
  const communityShelves = source.indexOf('communityShelves.map((s) => <CommunityShelf')
  const groupHead = source.indexOf("{query.trim() === '' && shelves.length > 0 ? <SectionHeader>Grupos</SectionHeader> : null}")
  const groupShelves = source.indexOf('shelves.map((s) => <GroupShelf', communityShelves + 1)
  t.ok(communityHead > 0 && communityHead < communityShelves, 'Comunidades heading, only over a community shelf, above them')
  t.ok(groupHead > communityShelves && groupHead < groupShelves, 'Grupos heading, only over a group shelf, above them')
})

test('acting as a Página, Descobrir shows no group shelf and no group hit', async (t) => {
  const pure = await imageHarness(async () => new Map())
  const shelves = [{ id: 'members', items: [] }]
  t.is(pure.shownGroupShelves(shelves, null), shelves, 'the member sees the group shelves')
  t.alike(pure.shownGroupShelves(shelves, key(70)), [], 'a Página sees none')
  pure.unmount()
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
  t.ok(source.includes('const shelves = shownGroupShelves(groupShelves, pageKey)'), 'the screen renders the page-aware shelves')
  t.ok(source.includes('const search = shownSearch(rawSearch, blocks, list, pageKey === null)'), 'the screen leaves group hits out for a Página')

  const groups = [{ group: key(11), name: 'Horta', creator: key(50), writerCount: 3 }]
  const communities = [{ community: key(21), name: 'Horta', creator: key(54), members: 5 }]
  const h = await blockHarness(groups, communities)
  await h.renderSearch('horta', OPEN_BLOCKS, EMPTY_LIST, false)
  const result = await h.renderSearch('horta', OPEN_BLOCKS, EMPTY_LIST, false)
  t.alike(h.searchSections(result.search).map((s) => [s.id, s.hits.map((x) => x.id)]), [['communities', [key(21)]]], 'only community hits')
  t.alike(h.calls.flat(), [key(21)], 'no image asked for a group hit')
  h.unmount()
})

test('an empty query shows the community shelves before the group shelves', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
  const community = source.indexOf('communityShelves.map((s) => <CommunityShelf')
  const group = source.indexOf('shelves.map((s) => <GroupShelf', community + 1)
  t.ok(community > 0, 'community shelves render')
  t.ok(group > community, 'group shelves come after')
  t.ok(source.includes('onOpen={openCommunity} />) : null}'), 'a community card opens Comunidade')
  t.absent(source.includes('fetchGroupSearch'), 'no legacy search')
})

function sheetNodes (node) {
  if (Array.isArray(node)) return node.flatMap(sheetNodes)
  if (!node || typeof node !== 'object') return []
  return [node, ...sheetNodes(node.props.children)]
}

async function createHarness (options = {}) {
  const { transformSync } = require('@babel/core')
  const { imageAfterCreate, words: imageWords } = await import('../src/groupImageCreate.js')
  const avatar = await import('../src/media/avatar.js')
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
  const sheet = source.slice(source.indexOf('export function NovaComunidade ('), source.indexOf('export function Comunidades (')).replace('export ', '')
  const ui = fs.readFileSync(path.join(__dirname, '../src/ui/index.js'), 'utf8')
  const action = ui.slice(ui.indexOf('export function useAction ('), ui.indexOf('// Runs the latest')).replace('export ', '')
  const { code } = transformSync(action + sheet, {
    babelrc: false,
    configFile: false,
    plugins: [[require.resolve('@babel/plugin-transform-react-jsx'), { pragma: 'element', pragmaFrag: 'Fragment' }]]
  })
  const slots = []
  const effects = []
  const calls = []
  const created = []
  const encodes = []
  let cursor = 0
  let dirty = false
  let released = 0
  let uncertain = 0
  let closed = 0
  let writes = 0
  const encoded = { bytes: new Uint8Array([255, 216, 255, 192, 0, 11, 8, 2, 0, 2, 0, 1, 1, 17, 0]), mime: 'image/jpeg' }
  const handle = {
    uri: 'local-photo',
    width: 512,
    height: 512,
    encode: async (...args) => { encodes.push(args); return options.encode ? options.encode() : encoded },
    release: () => { released++ }
  }
  const node = {
    hosted: true,
    online: true,
    request: async (method, params) => {
      calls.push([method, params])
      if (options.request) return options.request(method, params)
      return method === 'community.create' ? { community: key(1) } : {}
    },
    media: { upload: async (params) => { calls.push(['upload', params]); return options.upload ? options.upload() : image } },
    ...options.node
  }
  const useState = (initial) => {
    const slot = (slots[cursor++] ??= { value: initial })
    return [slot.value, (value) => { slot.value = typeof value === 'function' ? value(slot.value) : value; dirty = true; writes++ }]
  }
  const useRef = (initial) => (slots[cursor++] ??= { current: initial })
  const useEffect = (effect, deps) => {
    const slot = (slots[cursor++] ??= {})
    if (slot.deps && deps.every((value, i) => Object.is(value, slot.deps[i]))) return
    slot.deps = deps
    effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() })
  }
  const components = Object.fromEntries(['Sheet', 'View', 'ScrollView', 'Field', 'ErrorText', 'Choice', 'Soft', 'Btn', 'Label', 'AvatarEditor'].map((name) => [name, name]))
  const context = {
    ...components,
    ...avatar,
    useState,
    useRef,
    useEffect,
    useCallback: (fn) => fn,
    useStyles: () => ({}),
    makeStyles: () => ({}),
    useNode: () => node,
    useEscapeClose: () => {},
    errorText: (err) => err.message,
    refusalOf: () => '',
    nameLength: (text) => Array.from(text).length,
    NAME_MAX: 80,
    HEX64: /^[0-9a-f]{64}$/,
    UNCERTAIN: 'Não foi possível confirmar',
    imageAfterCreate,
    imageWords,
    pickImage: async () => options.pick ? options.pick() : options.cancelPick ? null : { uri: 'local-photo' },
    openImage: async () => options.open ? options.open(handle) : handle,
    element: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: 'Fragment'
  }
  // eslint-disable-next-line no-new-func
  const renderSheet = new Function(...Object.keys(context), code + '\nreturn NovaComunidade')(...Object.values(context))
  const props = { visible: true, onClose: () => { closed++ }, onCreated: (...args) => created.push(args), onUncertain: () => { uncertain++ } }
  const render = () => {
    let tree
    do {
      dirty = false
      cursor = 0
      tree = renderSheet(props)
      for (const effect of effects.splice(0)) effect()
    } while (dirty)
    return sheetNodes(tree)
  }
  const find = (type, label) => render().find((n) => n.type === type && (label === undefined || n.props.label === label))?.props
  render()
  find('Field', 'Nome').onChangeText('  Jardim  ')
  return {
    calls,
    created,
    encoded,
    encodes,
    node,
    props,
    find,
    render,
    imageWords,
    released: () => released,
    uncertain: () => uncertain,
    closed: () => closed,
    writes: () => writes,
    visible (value) { props.visible = value; return render() },
    async pick () {
      await find('Btn', 'Escolher foto')?.onPress()
      await find('AvatarEditor')?.onConfirm({ x: 0, y: 0, width: 512, height: 512 })
    },
    unmount () { for (const slot of slots) slot.cleanup?.() }
  }
}

test('community creation with a cropped photo sends create, upload and community.image once', async (t) => {
  const h = await createHarness()
  t.ok(h.find('Btn', 'Escolher foto'), 'optional photo row')
  await h.pick()
  t.alike(h.calls, [], 'choosing and cropping send nothing')
  t.alike(h.encodes, [[{ x: 0, y: 0, width: 512, height: 512 }, 262144, { format: 'jpeg' }]])
  t.is(h.released(), 1, 'crop handle released')
  const create = h.find('Btn', 'Criar comunidade').onPress
  await create()
  await create()
  t.alike(h.calls, [
    ['community.create', { name: 'Jardim', join: 'open' }],
    ['upload', { ...h.encoded, width: 512, height: 512 }],
    ['community.image', { community: key(1), image }]
  ], 'unchanged create params, public upload and one image write')
  t.alike(h.created, [[key(1), '']])
  h.unmount()
})

test('failed, uncertain and keyless community creates never upload a chosen photo', async (t) => {
  for (const result of ['failed', 'uncertain', 'keyless']) {
    const h = await createHarness({
      request: async () => {
        if (result === 'keyless') return {}
        throw Object.assign(new Error('create failed'), { uncertain: result === 'uncertain' })
      }
    })
    await h.pick()
    const create = h.find('Btn', 'Criar comunidade').onPress
    await create()
    if (result === 'uncertain') await create()
    t.alike(h.calls.map(([method]) => method), ['community.create'], result)
    t.alike(h.created, [])
    t.is(h.uncertain(), result === 'uncertain' ? 1 : 0)
    h.unmount()
  }
})

test('photo failures preserve the created community and never repeat create, upload or image', async (t) => {
  for (const stage of ['upload', 'community.image']) {
    for (const uncertain of [false, true]) {
      const fail = () => { throw Object.assign(new Error('photo failed'), { uncertain }) }
      const h = await createHarness({
        upload: stage === 'upload' ? fail : undefined,
        request: async (method) => method === 'community.create' ? { community: key(1) } : fail()
      })
      await h.pick()
      const create = h.find('Btn', 'Criar comunidade').onPress
      await create()
      await create()
      t.alike(h.calls.map(([method]) => method), stage === 'upload' ? ['community.create', 'upload'] : ['community.create', 'upload', 'community.image'])
      t.alike(h.created, [[key(1), h.imageWords.communityFailed]])
      t.is(h.uncertain(), 0, 'photo uncertainty is not create uncertainty')
      h.unmount()
    }
  }
})

test('photo upload holds the create lock and blocks closing the sheet', async (t) => {
  let finish
  const h = await createHarness({ upload: () => new Promise((resolve) => { finish = resolve }) })
  await h.pick()
  const create = h.find('Btn', 'Criar comunidade').onPress
  const running = create()
  await new Promise((resolve) => setImmediate(resolve))
  await create()
  h.find('Sheet').onClose()
  t.is(h.closed(), 0)
  t.is(h.find('Sheet').dismissable, false)
  t.is(h.find('Btn', 'Criar comunidade').pending, true)
  t.alike(h.calls.map(([method]) => method), ['community.create', 'upload'])
  finish(image)
  await running
  t.is(h.created.length, 1)
  t.is(h.find('Sheet').dismissable, true)
  h.unmount()
})

test('failed community create keeps the sheet open and releases dismissal', async (t) => {
  let fail
  const h = await createHarness({ request: () => new Promise((resolve, reject) => { fail = reject }) })
  const work = h.find('Btn', 'Criar comunidade').onPress()
  t.is(h.find('Sheet').dismissable, false)
  h.find('Sheet').onClose()
  t.is(h.closed(), 0)
  fail(new Error('create failed'))
  await work
  t.is(h.find('Sheet').dismissable, true)
  t.ok(h.render().some((n) => n.type === 'ErrorText' && n.props.children.includes('create failed')), 'failure stays visible')
  t.is(h.find('Field', 'Nome').value, '  Jardim  ')
  t.is(h.find('Btn', 'Criar comunidade').pending, false)
  t.alike(h.calls.map(([method]) => method), ['community.create'], 'no automatic retry')
  h.unmount()
})

test('community photo selection follows capabilities and remains optional', async (t) => {
  for (const node of [{ hosted: false }, { media: {} }, { online: false }]) {
    const h = await createHarness({ node })
    const choose = h.find('Btn', 'Escolher foto')
    if (node.online === false) t.is(choose?.disabled, true)
    else t.absent(choose)
    h.unmount()
  }
  for (const mode of ['none', 'cancel', 'remove']) {
    const h = await createHarness({ cancelPick: mode === 'cancel' })
    if (mode !== 'none') await h.pick()
    if (mode === 'remove') h.find('Btn', 'Tirar foto').onPress()
    await h.find('Btn', 'Criar comunidade').onPress()
    t.alike(h.calls, [['community.create', { name: 'Jardim', join: 'open' }]], mode)
    t.alike(h.created, [[key(1), '']])
    h.unmount()
  }
})

test('bad crops send nothing and closing releases an open community crop', async (t) => {
  const h = await createHarness({ encode: () => ({ bytes: new Uint8Array([1]), mime: 'image/jpeg' }) })
  await h.pick()
  t.ok(h.find('AvatarEditor').error, 'invalid image stays in the crop with an error')
  t.absent(h.find('Btn', 'Criar comunidade'), 'only the crop editor is shown')
  t.alike(h.calls, [])
  h.find('AvatarEditor').onCancel()
  t.is(h.released(), 1)
  await h.find('Btn', 'Escolher foto').onPress()
  h.unmount()
  t.is(h.released(), 2)
})

test('new community crop editor replaces the entire form at the top of the sheet', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
  const fields = src.match(/const fields = editor !== null\s*\? (<AvatarEditor[^]*?\/>)\s*:\s*\(\s*<>([^]*?)<\/>\s*\)/)
  t.ok(fields, 'editor and form are exclusive branches')
  t.absent(/<Field\b|<Choice\b|<Btn\b/.test(fields?.[1] || ''), 'editor branch has no form controls')
  for (const label of ['Nome', 'Entrada', 'Criar comunidade']) {
    t.ok(fields?.[2].includes("label='" + label + "'"), label + ' is in the form branch')
  }
  t.ok(/<Sheet\b[^>]*>\s*(?:\{\/\*[^]*?\*\/\}\s*)?<ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle=\{styles.sheet\}>\s*\{fields\}\s*<\/ScrollView>\s*<\/Sheet>/.test(src), 'sheet body scrolls and contains only the selected branch')
})

test('new community sheet disables dismissal throughout pending work', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
  t.ok(/<Sheet\b[^>]*dismissable=\{!pending\}/.test(src), 'native swipe and drag follow pending work')
  t.ok(src.includes('if (sessionRef.current?.busy) return'), 'close callback also checks the execution lock')
})

test('both community sheet callers keep partial success visible before navigation', async (t) => {
  const { words } = await import('../src/groupImageCreate.js')
  for (const file of ['Comunidades.js', 'Conversas.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/screens', file), 'utf8')
    const callback = source.match(/onCreated=\{(\(community, note\) => \{[\s\S]*?)\}\}/)?.[1] + '}'
    const opened = []
    let notice
    let creating = true
    let composing = true
    // eslint-disable-next-line no-new-func
    const created = new Function('setCreating', 'load', 'groupsLoad', 'setCreatedNotice', 'openCommunity', 'onOpenCommunity', 'closeCompose', 'return ' + callback)(
      (value) => { creating = value }, () => {}, () => {}, (value) => { notice = value },
      (key) => opened.push(key), (key) => opened.push(key), () => { composing = false }
    )
    created(key(1), words.communityFailed)
    t.is(creating, false, file + ' closes the create sheet')
    t.alike(notice, { community: key(1), note: words.communityFailed })
    t.alike(opened, [], 'partial result remains on the caller')
    if (file === 'Conversas.js') t.is(composing, false, 'compose sheet cannot cover the notice')
    const noticeAt = source.indexOf('      {createdNotice')
    const root = source.slice(noticeAt, source.indexOf('<RefreshableList', noticeAt))
    t.ok(root.includes('<Soft>{createdNotice.note}</Soft>'), file + ' shows the note outside the list')
    t.ok(root.includes("label='Abrir comunidade'"), 'explicit navigation after reading the note')
    created(key(2), '')
    t.alike(opened, [key(2)], 'complete success still navigates')
    t.is(notice, null)
  }
})

for (const stage of ['pick', 'open', 'encode', 'create', 'create failed', 'create uncertain']) {
  test('reopened community sheet ignores a previous ' + stage, async (t) => {
    let finish
    let firstCreate = true
    const h = await createHarness({
      pick: stage === 'pick' ? () => new Promise((resolve) => { finish = () => resolve({ uri: 'old-photo' }) }) : undefined,
      open: stage === 'open' ? (handle) => new Promise((resolve) => { finish = () => resolve(handle) }) : undefined,
      encode: stage === 'encode' ? () => new Promise((resolve) => { finish = () => resolve(h.encoded) }) : undefined,
      request: async () => {
        if (stage.startsWith('create') && firstCreate) {
          firstCreate = false
          return new Promise((resolve, reject) => {
            finish = () => stage === 'create'
              ? resolve({ community: key(1) })
              : reject(Object.assign(new Error('old create failed'), { uncertain: stage === 'create uncertain' }))
          })
        }
        return { community: key(2) }
      }
    })
    let work
    if (stage.startsWith('create')) {
      await h.pick()
      work = h.find('Btn', 'Criar comunidade').onPress()
    } else {
      work = h.find('Btn', 'Escolher foto').onPress()
      if (stage === 'encode') {
        await work
        work = h.find('AvatarEditor').onConfirm({ x: 0, y: 0, width: 512, height: 512 })
      }
    }
    await new Promise((resolve) => setImmediate(resolve))
    t.ok(finish, 'first opening has pending work')
    h.visible(false)
    h.visible(true)
    h.find('Field', 'Nome').onChangeText('Segundo')
    h.find('Choice', 'Entrada').onChange('approval')
    t.is(h.find('Btn', 'Criar comunidade').pending, false, 'new opening has its own lock')
    const form = () => JSON.stringify(h.render(), (key, value) => key === 'children' ? undefined : value)
    const before = form()
    const writes = h.writes()
    const calls = h.calls.slice()
    finish()
    await work
    t.is(h.writes(), writes, 'stale continuation never updates the new form')
    t.is(form(), before, 'name, entry, photo, error and pending state stay unchanged')
    t.alike(h.calls, calls, 'old create never uploads or sets an image')
    t.alike(h.created, [], 'no stale completion reaches the caller')
    t.is(h.uncertain(), 0, 'old uncertainty cannot affect the new opening')
    t.is(h.released(), stage === 'pick' ? 0 : 1, 'old handle released once')
    await h.find('Btn', 'Criar comunidade')?.onPress()
    t.alike(h.calls.at(-1), ['community.create', { name: 'Segundo', join: 'approval' }])
    t.absent(h.calls.some(([method]) => method === 'upload' || method === 'community.image'), 'old picked photo was discarded')
    t.alike(h.created, [[key(2), '']], 'new opening can create independently')
    h.unmount()
  })
}

test('community upload finishing after hiding or unmounting never sets the image', async (t) => {
  for (const end of ['hide', 'reopen', 'unmount']) {
    let finish
    const h = await createHarness({ upload: () => new Promise((resolve) => { finish = () => resolve(image) }) })
    await h.pick()
    const work = h.find('Btn', 'Criar comunidade').onPress()
    await new Promise((resolve) => setImmediate(resolve))
    t.ok(finish, end + ' reached the upload')
    if (end === 'unmount') h.unmount()
    else h.visible(false)
    if (end === 'reopen') h.visible(true)
    const writes = h.writes()
    finish()
    await work
    t.alike(h.calls.map(([method]) => method), ['community.create', 'upload'], end + ' never writes the image or retries')
    t.alike(h.created, [], 'ended session never notifies the caller')
    t.is(h.writes(), writes, 'no state update from the ended upload')
    t.is(h.released(), 1, 'photo handle released once')
    h.unmount()
  }
})

function noticeCaller (file, sheet) {
  const { parseSync, transformSync } = require('@babel/core')
  const traverse = require('@babel/traverse').default
  const source = fs.readFileSync(path.join(__dirname, '../src/screens', file), 'utf8')
  const groupPicker = file === 'Conversas.js' && sheet === 'NovoGrupo'
  const noticeName = groupPicker ? 'createdGroupNotice' : sheet === 'NovoGrupo' ? 'createNote' : 'createdNotice'
  const setter = groupPicker ? 'setGroupForm' : sheet === 'NovoGrupo' ? 'setNewGroup' : 'setCreating'
  const openSetter = groupPicker ? 'setPickingGroupCommunity' : setter
  const openings = []
  let noticeExpression
  let createdExpression
  const ast = parseSync(source, { babelrc: false, configFile: false, parserOpts: { plugins: ['jsx'] } })
  traverse(ast, {
    JSXExpressionContainer ({ node }) {
      if (node.expression.type === 'ConditionalExpression' && node.expression.test.name === noticeName) {
        noticeExpression = source.slice(node.expression.start, node.expression.end)
      }
    },
    JSXAttribute ({ node, parent }) {
      if (parent.name.name === sheet && node.name.name === 'onCreated') {
        createdExpression = source.slice(node.value.expression.start, node.value.expression.end)
      }
    },
    ArrowFunctionExpression (path) {
      let opens = false
      path.traverse({
        CallExpression ({ node }) {
          if (node.callee.name === openSetter && node.arguments[0]?.value === true) opens = true
        }
      })
      if (opens) openings.push(source.slice(path.node.start, path.node.end))
    }
  })
  let notice = null
  let creating = true
  let picking = false
  const opened = []
  const context = () => ({
    [noticeName]: notice,
    groupForm: { community: null },
    setCreateNote: (value) => { notice = value },
    setCreatedNotice: (value) => { notice = value },
    setCreatedGroupNotice: (value) => { notice = value },
    [setter]: (value) => { creating = groupPicker ? value !== null : value },
    setPickingGroupCommunity: (value) => { picking = value },
    HEX64: /^[0-9a-f]{64}$/,
    load: () => {},
    groupsLoad: () => {},
    closeCompose: () => {},
    openGroup: (value) => opened.push(value),
    onOpenGroup: (value) => opened.push(value),
    openCommunity: (value) => opened.push(value),
    onOpenCommunity: groupPicker ? undefined : (value) => opened.push(value),
    styles: {},
    View: 'View',
    Soft: 'Soft',
    Btn: 'Btn',
    element: (type, props, ...children) => ({ type, props: { ...props, children } })
  })
  const evaluate = (expression) => {
    const { code } = transformSync('const value = (' + expression + ')', {
      babelrc: false,
      configFile: false,
      plugins: [[require.resolve('@babel/plugin-transform-react-jsx'), { pragma: 'element' }]]
    })
    const values = context()
    // eslint-disable-next-line no-new-func
    return new Function(...Object.keys(values), code + '\nreturn value')(...Object.values(values))
  }
  return {
    opened,
    openings: () => openings.map(evaluate),
    created: (...args) => evaluate(createdExpression)(...args),
    render: () => sheetNodes(evaluate(noticeExpression)),
    creating: () => creating,
    reopened: () => groupPicker ? picking : creating
  }
}

for (const [file, sheet, entryPoints] of [
  ['Comunidade.js', 'NovoGrupo', 2],
  ['Comunidades.js', 'NovaComunidade', 2],
  ['Conversas.js', 'NovaComunidade', 4],
  ['Conversas.js', 'NovoGrupo', 1]
]) {
  test(file + ' ' + sheet + ' partial success notice opens the entity and clears on opening another create', async (t) => {
    const { words } = await import('../src/groupImageCreate.js')
    const h = noticeCaller(file, sheet)
    const group = sheet === 'NovoGrupo'
    const note = group ? words.groupFailed : words.communityFailed
    h.created(key(1), note)
    t.is(h.creating(), false, 'sheet closes')
    t.alike(h.opened, [], 'partial success stays on the caller')
    t.ok(h.render().some((n) => n.type === 'Soft' && n.props.children.includes(note)), 'line remains visible after closing')
    const button = h.render().find((n) => n.type === 'Btn' && n.props.label === (group ? 'Abrir grupo' : 'Abrir comunidade'))
    t.ok(button, 'notice offers the created entity')
    button?.props.onPress()
    t.alike(h.opened, [key(1)], 'button navigates to the created key')
    t.alike(h.render(), [], 'line is gone when returning from the entity')
    const openings = h.openings()
    t.is(openings.length, entryPoints, 'covers every create entry point')
    for (const open of openings) {
      h.created(key(1), note)
      open()
      t.is(h.reopened(), true, 'entry point reopens creation')
      t.alike(h.render(), [], 'reopening clears the line')
    }
    h.created(key(1), note)
    h.created(key(2), '')
    t.alike(h.opened, [key(1), key(2)], 'a later successful create still navigates')
    t.alike(h.render(), [], 'a later successful create clears the line')
  })
}

test('a held catalogue row says Entrar only to a community member', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidade.js'), 'utf8')
  const line = source.split('\n').find((l) => l.trim().startsWith('const detail = line !== \'\' ? line :'))
  t.ok(line, 'detail line found')
  // eslint-disable-next-line no-new-func
  const detail = new Function('line', 'g', 'visibilityText', 'roleLabel', 'isMember', line + '\nreturn detail')
  const roleLabel = (r) => 'papel ' + r
  const row = { general: false }
  t.is(detail('', row, 'público', roleLabel, true), 'público · Entrar', 'a member is offered the group')
  t.is(detail('', row, 'público', roleLabel, false), 'público', 'anyone else joins the community first')
  t.is(detail('', { general: true }, 'público', roleLabel, false), 'grupo principal · público')
  t.is(detail('', { general: false, role: 'left' }, 'público', roleLabel, false), 'público · papel left', 'a known group role still shows')
  t.is(detail('oi', row, 'público', roleLabel, false), 'oi', 'a last line wins')
})
