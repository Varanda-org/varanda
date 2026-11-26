'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const { pushCandidates } = require('../../../packages/core/lib/push-events')
const { tagOf } = require('../../../packages/core/lib/notice-tags')
const vectors = require('./notice-tag-vectors.json')
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const source = (file) => readFileSync(join(__dirname, '..', file), 'utf8')

// Run the production callbacks without loading JSX or a platform runtime.
function sourceCallback (file, marker, context) {
  const text = source(file)
  const at = text.indexOf(marker)
  if (at < 0) throw new Error('Callback not found: ' + marker)
  const start = text.indexOf('(', at) + 1
  const end = text.indexOf('\n  }, [', start)
  if (end < start) throw new Error('Callback end not found: ' + marker)
  return vm.runInNewContext('(' + text.slice(start, end) + '\n  })', context)
}

async function shell (pageKey = null) {
  const { createSeenNoticeSync } = await import('../src/account.js')
  const { settleGroups } = await import('../src/conversasDot.js')
  const { reportAvisosSeen } = await import('../src/seenSync.js')
  const sync = createSeenNoticeSync()
  const closed = []
  const dots = []
  const wakes = []
  const groupsReportEpoch = { current: pageKey === null ? 1 : null }
  const avisosSeenRef = { current: { own: [], pages: {} } }
  const context = {
    noticeReads: { current: sync },
    createSeenNoticeSync,
    acting: pageKey === null ? { kind: 'me' } : { kind: 'page', key: pageKey },
    dmReady: true,
    closeNotices: (tags) => closed.push([...tags]),
    nodeEpoch: 1,
    groupsReportEpoch,
    setGroupsDot: (fn) => dots.push(fn(dots.at(-1))),
    settleGroups,
    pageKey,
    ownKey: B,
    avisosSeenRef,
    avisosMergedRef: { current: null },
    avisosDeliveredRef: { current: new Set() },
    seenSchedulerRef: { current: { wake: (reason) => wakes.push(reason) } },
    reportAvisosSeen
  }
  let previousDeps = []
  context.useLayoutEffect = (effect, deps) => {
    if (deps.some((dep, i) => dep !== previousDeps[i])) effect()
    previousDeps = deps
  }
  const appSource = source('App.js')
  const resetSource = appSource.slice(appSource.indexOf('  useLayoutEffect(() => {\n    noticeReads.current'), appSource.indexOf('  const closeReadNotices'))
  const renderIdentity = (key) => {
    context.pageKey = key
    context.acting = key === null ? { kind: 'me' } : { kind: 'page', key }
    groupsReportEpoch.current = key === null ? 1 : null
    vm.runInNewContext(resetSource, context)
  }
  renderIdentity(pageKey)
  context.closeReadNotices = sourceCallback('App.js', 'const closeReadNotices = useCallback(', context)
  return {
    get sync () { return context.noticeReads.current },
    context,
    renderIdentity,
    closeReadNotices: context.closeReadNotices,
    closed,
    dots,
    wakes,
    groupsReportEpoch,
    avisosSeenRef,
    onGroupsUnread: sourceCallback('App.js', 'const onGroupsUnread = useCallback(', context),
    onSeenState: sourceCallback('App.js', 'const onAvisosSeen = useCallback(', context)
  }
}

async function conversas (app, groups, pageKey = null) {
  const { groupReadState } = await import('../src/noticeReads.js')
  const { groupsUnread } = await import('../src/conversasDot.js')
  const { mergeRows } = await import('../src/conversas.js')
  sourceCallback('src/screens/Conversas.js', 'useEffect(() => {\n    if (pageKey !== null) return', {
    pageKey,
    groups: { loaded: true, loading: false, failed: false, error: '', partial: false, ...groups },
    onGroupsUnread: app.onGroupsUnread,
    groupReadState,
    groupsUnread,
    mergeRows
  })()
}

async function avisos (app, { ids = [], namespace = B, active = false, remote = [] } = {}) {
  const notices = await import('../src/notices.js')
  const { avisoReadRows } = await import('../src/noticeReads.js')
  const badges = []
  let unread = new Set()
  const seenRef = { current: { ids } }
  const settle = sourceCallback('src/screens/Avisos.js', 'const settle = useCallback(', {
    ...notices,
    avisoReadRows,
    // A live list has loaded and every row is confirmed: the cached-paint
    // guards of settle (T16) pass through.
    stateRef: { current: { loadedAt: 1, unverified: [] } },
    heldRef: { current: [] },
    confirmedNotices: (items) => items,
    seenNamespace: namespace,
    seenNamespaceRef: { current: namespace },
    settleRef: { current: null },
    activeRef: { current: active },
    lastListRef: { current: null },
    shownListRef: { current: null },
    seenRef,
    remoteSeenRef: { current: null },
    remoteFor: () => remote,
    ownKeyRef: { current: B },
    followsSetRef: { current: null },
    randomBytes: null,
    badge: (value) => badges.push(value),
    setUnread: (fn) => { unread = fn(unread) },
    onSeenStateRef: { current: app.onSeenState }
  })
  return { settle, badges, unread: () => [...unread], seenRef }
}

test('Conversas settles public and private rows through App into readTags and closeNotices', async (t) => {
  const app = await shell()
  const vector = vectors.payloads.find(({ payload }) => payload.kind === 'group')
  const publicRow = { group: vector.payload.group, visibility: 'public', unread: 0 }
  const privateRow = { group: A, visibility: 'private', unread: 0 }
  await conversas(app, { rows: [publicRow, privateRow] })
  t.alike(app.sync.tags(), [vector.tag, 'varanda-group-private'])
  t.alike(app.closed.at(-1), app.sync.tags(), 'local close follows the update')
  t.alike(app.dots, [false])
  await conversas(app, { rows: [publicRow, { ...privateRow, unread: 1 }] })
  t.alike(app.sync.tags(), [vector.tag], 'private unread keeps its notice')
  t.is(app.dots.at(-1), true)
  await conversas(app, { rows: [{ ...publicRow, unread: 1 }, privateRow] })
  t.alike(app.sync.tags(), ['varanda-group-private'], 'public unread keeps its notice')
  await conversas(app, { rows: [{ ...publicRow, unread: 1 }, { ...privateRow, unread: 1 }] })
  t.alike(app.sync.tags(), [])
  t.alike(app.closed.at(-1), [])
})

test('Conversas ignores loading snapshots and cannot close from failed or unknown counts', async (t) => {
  const app = await shell()
  const row = { group: A, visibility: 'public', unread: 0 }
  for (const state of [{ loaded: false }, { loading: true }]) await conversas(app, { rows: [row], ...state })
  t.alike(app.closed, [])
  for (const state of [{ failed: true }, { error: 'failed' }]) {
    await conversas(app, { rows: [row], ...state })
    t.alike(app.sync.tags(), [])
  }
  await conversas(app, { rows: [row], partial: true })
  t.alike(app.sync.tags(), ['varanda-group-' + A], 'partial lists cannot clear the private total')
  t.is(app.dots.at(-1), false, 'the existing dot still accepts an incomplete answer')
  await conversas(app, { rows: [{ ...row, unread: undefined }] })
  t.alike(app.sync.tags(), [], 'display normalization cannot make an unknown count read')
  app.groupsReportEpoch.current = 2
  await conversas(app, { rows: [row] })
  t.alike(app.sync.tags(), [], 'an obsolete shell epoch accepts nothing')
})

test('Avisos settled seen rows reach the push tags for every shared social vector', async (t) => {
  for (const { record, seq, payload, tag } of vectors.payloads.filter((vector) => vector.record)) {
    const [event] = pushCandidates({ author: payload.actor, seq, record, now: 1, isMember: () => true, isBlocked: () => false, holders: () => [payload.recipient] })
    const pushTag = tagOf({ v: 1, kind: event.kind, actor: event.actor, recipient: event.recipient, ref: event.ref, body: payload.body })
    const app = await shell()
    const row = { kind: payload.kind, key: payload.actor, seq, post: B + ':7', seen: 'c'.repeat(32) }
    const screen = await avisos(app)
    screen.settle([row], false)
    t.alike(app.sync.tags(), [], payload.kind + ' unread stays open')
    t.is(screen.badges.at(-1), true)
    screen.settle([row], true)
    t.is(pushTag, tag)
    t.alike(app.sync.tags(), [pushTag], payload.kind)
    t.alike(app.closed.at(-1), [pushTag])
    t.alike(app.avisosSeenRef.current.own, [row.seen], 'tokens still reach the existing sync')
    t.alike(app.wakes, ['changed'])
    t.is(screen.badges.at(-1), false)
    t.alike(screen.unread(), [row.seen], 'the existing first-show row dot is unchanged')
    if (payload.kind === 'reply') {
      t.not(pushTag, 'varanda-reply-' + row.key + ':' + row.seq, 'reply closes its target, not itself')
      screen.settle([{ ...row, post: undefined }], false)
      t.alike(app.sync.tags(), [], 'missing target never guesses a tag')
    }
  }
})

test('Avisos preserves unread rows sharing a tag and reports hidden read snapshots', async (t) => {
  const app = await shell()
  const row = { kind: 'reply', key: A, seq: 3, post: B + ':7', seen: 'c'.repeat(32) }
  const screen = await avisos(app, { ids: [row.seen] })
  screen.settle([row], false, false)
  t.alike(app.closed.at(-1), ['varanda-reply-' + B + ':7'])
  screen.settle([row], false)
  t.alike(app.sync.tags(), ['varanda-reply-' + B + ':7'])
  screen.settle([row, { ...row, seq: 4, seen: 'd'.repeat(32) }], false)
  t.alike(app.sync.tags(), [], 'one unread reply prevents closing the shared target tag')
  t.is(screen.badges.at(-1), true)
})

test('Avisos recognizes remote reads already displayed as seen', async (t) => {
  const app = await shell()
  const row = { kind: 'follow', key: A, seq: 3, seen: 'c'.repeat(32) }
  const screen = await avisos(app, { remote: [row.seen] })
  screen.settle([row], false)
  t.alike(app.sync.tags(), ['varanda-follow-' + A])
  t.alike(screen.unread(), [])
  t.is(screen.badges.at(-1), false)
})

test('acting as a Pagina reports neither group nor social read rows', async (t) => {
  const app = await shell(A)
  const rows = [{ group: A, visibility: 'public', unread: 0 }]
  await conversas(app, { rows }, A)
  t.alike(app.closed, [])
  const pageReports = []
  const onSeenState = (...args) => { pageReports.push(args); app.onSeenState(...args) }
  const screen = await avisos({ onSeenState }, { namespace: 'page:' + A, active: true })
  const row = { kind: 'follow', key: A, seq: 3, seen: 'c'.repeat(32) }
  screen.settle([row])
  t.is(pageReports.length, 1)
  t.is(pageReports[0][2], undefined, 'page tokens carry no member read rows')
  t.alike(app.avisosSeenRef.current.pages['page:' + A], [row.seen], 'page tokens keep their namespace')
  t.alike(app.sync.tags(), [])
  t.alike(app.closed, [])
  app.onSeenState(B, [row.seen], [{ ...row, read: true }])
  app.onGroupsUnread(false, { groups: rows, privateUnread: 0 })
  t.alike(app.sync.tags(), [], 'late member reports cannot close while acting as a page')
  const ownApp = await shell()
  ownApp.onSeenState(A, [row.seen], [{ ...row, read: true }])
  t.alike(ownApp.sync.tags(), [], 'another member namespace cannot supply read rows')
})

test('a successful remote seen pass preserves notices despite cached local reads', async (t) => {
  const app = await shell()
  const { cleanAvisos } = await import('../src/seenSync.js')
  const { withOnceTokens } = await import('../src/onceMarks.js')
  app.sync.update({ dm: { unread: 0, requests: false } })
  t.alike(app.sync.tags(), ['varanda-dm'])
  const result = { error: null }
  let run
  sourceCallback('App.js', 'useEffect(() => {\n    if (seenMember === null) return\n    const member = seenMember\n    const appearance', {
    ...app.context,
    seenMember: B,
    seenMemberRef: { current: B },
    seenAppearanceRef: { current: 1 },
    seenRequestRef: { current: async () => {} },
    cleanAvisos,
    withOnceTokens,
    onceRegistry: { unsynced: () => [] },
    runSeenPass: async () => result,
    stepFirstPass: () => {},
    createSeenScheduler: (options) => { run = options.run; return {} }
  })()
  t.is(await run('remote'), result, 'the remote pass succeeds')
  t.alike(app.closed, [], 'cached reads cannot close a newer delivered notice')
  t.is(await run('changed'), result, 'the local pass succeeds')
  t.alike(app.closed, [['varanda-dm']], 'other wake reasons still close local read notices')
})

test('the rendered screens receive the shell callbacks and import the pure adapters', (t) => {
  const app = source('App.js')
  t.ok(/<Conversas\b[^>]*onGroupsUnread=\{onGroupsUnread\}/.test(app))
  t.ok(/<Avisos\b[^>]*onSeenState=\{onAvisosSeen\}/.test(app))
  t.ok(app.includes('const http = noticeReads.current.http(seenRequestRef.current)'))
  t.ok(/runSeenPass\(\{\s*member,\s*request: http.request,\s*http,/.test(app))
  t.ok(source('src/screens/Conversas.js').includes("import { groupReadState } from '../noticeReads'"))
  t.ok(source('src/screens/Avisos.js').includes("import { avisoReadRows } from '../noticeReads'"))
})

async function refreshDm (app, inboxes) {
  const { badgeListParams } = await import('../src/conversasDot.js')
  const calls = []
  Object.assign(app.context, {
    dmDotGen: { current: 0 },
    dmDotRetry: { current: null },
    clearTimeout,
    setTimeout: () => { throw new Error('unexpected DM retry') },
    badgeListParams,
    dmRequest: async (method, params) => {
      calls.push({ method, params })
      return inboxes.get(params.page || null)
    },
    setDmDotState: () => {}
  })
  sourceCallback('App.js', 'const readDmDot = useCallback(', app.context)()
  await new Promise((resolve) => setImmediate(resolve))
  return calls
}

test('an empty Pagina inbox cannot close the shared tag while another Pagina is unread', async (t) => {
  const app = await shell(A)
  const inboxes = new Map([
    [A, { inboxUnread: false, requests: false }],
    [B, { inboxUnread: true, requests: false }]
  ])
  const calls = await refreshDm(app, inboxes)
  t.is(calls.length, 1)
  t.is(calls[0].params.page, A, 'the answer covers only A')
  t.absent(app.sync.tags().includes('varanda-dm-page'))
  t.ok(app.closed.every((tags) => !tags.includes('varanda-dm-page')))
})

test('switching from member to Pagina drops read tags for every close trigger and an in-flight pass', async (t) => {
  const app = await shell()
  const reads = {
    dm: { unread: 0, requests: false },
    groups: [{ group: A, unread: 0 }],
    privateUnread: 0,
    avisos: [{ kind: 'like', post: B + ':7', read: true }]
  }
  const tags = app.sync.update(reads)
  t.is(tags.length, 4)
  const http = app.sync.http()
  const realFetch = globalThis.fetch
  t.teardown(() => { globalThis.fetch = realFetch })
  const writes = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const data = body.action === 'read'
      ? { hash: null, blob: null, outstanding: tags, asOf: 10 }
      : { ok: true, hash: A }
    if (body.action === 'write') writes.push(body)
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(data) }
  }
  await http.seenFinish({ action: 'read' })
  app.renderIdentity(A)
  t.alike(app.sync.tags(), [], 'acting identity invalidates all member snapshots')
  await refreshDm(app, new Map([[A, { inboxUnread: false, requests: false }]]))
  for (const trigger of ['visible', 'open', 'pass']) {
    app.closeReadNotices()
    t.alike(app.closed.at(-1), [], trigger)
  }
  app.onSeenState(B, [], reads.avisos)
  app.onGroupsUnread(false, reads)
  t.alike(app.sync.tags(), [], 'late member callbacks stay excluded')
  t.alike(app.sync.update(reads), [], 'a member snapshot cannot enter while acting as a Pagina')
  await http.seenFinish({ action: 'write', blob: 'x' })
  t.alike(writes.at(-1).close, [], 'a pass started as the member cannot close after the switch')
  const pageHttp = app.sync.http()
  await pageHttp.seenFinish({ action: 'read' })
  await pageHttp.seenFinish({ action: 'write', blob: 'x' })
  t.alike(writes.at(-1).close, [], 'a pass started as a Pagina cannot close member tags')
  app.renderIdentity(null)
  t.alike(app.sync.tags(), [], 'returning to the member needs fresh answers')
})

test('a hidden poll removes a read like tag when another like on the same post arrives', async (t) => {
  const app = await shell()
  const screen = await avisos(app)
  const row = { kind: 'like', key: A, seq: 3, post: B + ':7', seen: 'c'.repeat(32) }
  screen.settle([row], true)
  t.alike(app.sync.tags(), ['varanda-like-' + B + ':7'])
  screen.settle([row, { ...row, seq: 4, seen: 'd'.repeat(32) }], false, false)
  t.is(screen.badges.at(-1), true)
  t.alike(app.sync.tags(), [], 'the unread row invalidates the shared tag even while hidden')
  app.closeReadNotices()
  t.alike(app.closed.at(-1), [])
  t.alike([...screen.seenRef.current.ids], [row.seen], 'the poll does not mark the new row')
  t.alike(app.wakes, ['changed'], 'the poll supplies no new read tokens')
})
