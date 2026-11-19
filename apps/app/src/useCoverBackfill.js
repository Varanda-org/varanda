import { useEffect, useLayoutEffect, useRef } from 'react'
import { fetch as expoFetch } from 'expo/fetch'
import { createBackfillPlanner } from './coverBackfill'
import * as store from './coverBackfillStore'
import { listBackfillPages, runBackfillPass } from './coverBackfillPass'
import { addCover } from './postShare'
import { coverAsPage } from './pageShare'
import { actAs, pagesPostCover, pagesUploadEncoded } from './pages'
import { diaryPeekSlots } from './engagement'
import { encodeThumbnail } from './media/encode'
import { fetchMedia } from './media/fetch'
import { nativeSubtle } from './media/hash'
import { isAppClient } from './appClient'
import { isVisible, subscribeVisible } from './visibility'
import { isOnline, subscribeOnline } from './online'

export function useCoverBackfill ({ node, identity, enabled }) {
  const latest = useRef(null)
  const generation = node.passkey?.generation
  const unlocked = node.passkey?.status?.unlocked === true && node.passkey.status.publicKey === identity
  // Vitrine has no configuration, as in App's snapshot gate.
  const allowed = enabled && unlocked && node.hosted === true && node.config != null &&
    node.online !== false && node.visible !== false
  latest.current = { allowed, identity, epoch: node.epoch, generation }
  const turn = useRef(0)
  useLayoutEffect(() => {
    turn.current++
    return () => { turn.current++ }
  }, [allowed, identity, node.epoch, generation])

  const { epoch, request, whenIdle, media, accountOrigin } = node
  useEffect(() => {
    if (!allowed || typeof whenIdle !== 'function') return
    let live = true
    const mine = turn.current
    const ctrl = new AbortController()
    const alive = () => {
      const now = latest.current
      return live && turn.current === mine && now.allowed && now.identity === identity &&
        now.epoch === epoch && now.generation === generation && isVisible() && isOnline()
    }
    const stop = () => {
      live = false
      ctrl.abort()
    }
    const offVisible = subscribeVisible((visible) => { if (!visible) stop() })
    const offOnline = subscribeOnline((online) => { if (!online) stop() })
    // A signature arriving after cleanup must not reach a page HTTP write.
    const guardedRequest = async (...args) => {
      if (!alive()) throw new Error('Passagem encerrada.')
      const answer = await request(...args)
      if (!alive()) throw new Error('Passagem encerrada.')
      return answer
    }
    const source = { hosted: true, accountOrigin, request: guardedRequest }
    const pageRead = (action, page = '') => actAs(source, { member: identity, action, page, op: {} })
    const wait = whenIdle(4000)
    wait.promise.then(async () => {
      if (!alive()) return
      await runBackfillPass({
        planner: createBackfillPlanner({ store, identity }),
        identity,
        alive,
        listOwn: () => guardedRequest('post.uncovered', {}),
        listPages: (page) => listBackfillPages({
          list: () => pageRead('list'),
          status: (key) => pageRead('status', key),
          identity,
          alive
        }, page),
        readPost: async ({ author, seq }) => {
          const peek = await diaryPeekSlots.run(() => guardedRequest('diary.peek', { author, seqs: [seq] }))
          const entry = peek && Array.isArray(peek.entries) ? peek.entries.find((e) => e && e.seq === seq) : null
          return entry?.record?.type === 'post' ? entry.record : null
        },
        buildDeps: ({ kind, author, seq, ref }) => ({
          fetchStill: (image) => fetchMedia(author, image, {
            subtle: nativeSubtle,
            fetch: isAppClient() ? expoFetch : undefined,
            persist: false,
            signal: ctrl.signal
          }),
          encodeThumbnail,
          upload: kind === 'page'
            ? (encoded) => pagesUploadEncoded(source, { member: identity, page: author, encoded })
            : (b) => media.upload({ bytes: b.bytes, mime: b.mime, width: b.width, height: b.height }),
          setCover: kind === 'page'
            ? (image) => coverAsPage((op) => pagesPostCover(source, { member: identity, page: author, op }), seq, image)
            : (image) => addCover(guardedRequest, ref, image)
        })
      })
    }).catch(() => {})
    return () => {
      stop()
      wait.cancel()
      offVisible()
      offOnline()
    }
  }, [allowed, identity, epoch, generation, request, whenIdle, media, accountOrigin])
}
