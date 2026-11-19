export const SHELF_IDS = Object.freeze(['followed', 'trending', 'members', 'recent'])

export const SHELF_TITLES = Object.freeze({
  followed: 'Grupos de quem você segue',
  trending: 'Em alta',
  members: 'Mais membros',
  recent: 'Criados recentemente'
})

export const ORDER_TEXT = Object.freeze({
  followed: 'Calculado neste aparelho: grupos públicos abertos em que estão pessoas que você segue, começando pelos que têm mais delas. Olhamos até 24 pessoas da sua lista por vez.',
  trending: 'Em ordem de quantas pessoas diferentes escreveram no grupo nos últimos 7 dias, contadas nas mensagens recentes que este semeador leu. Cada pessoa conta uma vez, Páginas não contam e só entram grupos abertos com pelo menos 2.',
  members: 'Do grupo com mais membros para o com menos, entre os grupos públicos que este semeador guarda.',
  recent: 'Do mais novo para o mais antigo, pela data que quem criou declarou. No máximo 2 grupos de cada pessoa.'
})

export const PARTIAL_TEXT = 'A lista ainda está sendo atualizada; alguns grupos podem faltar.'

export const FOLLOW_SAMPLE_MAX = 24
export const FANOUT_GAP_MS = 750
export const FANOUT_MAX_FAILURES = 3
export const FOLLOW_CACHE_MS = 600000
export const TREND_MIN_ACTIVE = 2
export const SHELF_ROWS_MAX = 20
export const GROUP_LIST_LIMIT = 26
export const GROUP_LIST_PAGES = 3

const DAY_MS = 86400000

export function followSample (keys, now, max = FOLLOW_SAMPLE_MAX) {
  const sorted = [...new Set(keys)].sort()
  if (sorted.length <= max) return sorted
  if (!Number.isFinite(now)) return []
  const offset = (Math.floor(now / DAY_MS) * max) % sorted.length
  const start = (offset + sorted.length) % sorted.length
  return Array.from({ length: max }, (_, i) => sorted[(start + i) % sorted.length])
}

export function joinedOf (pages) {
  const joined = new Set()
  if (!Array.isArray(pages)) return joined
  for (const page of pages) {
    if (!Array.isArray(page?.groups) || !Number.isSafeInteger(page.total) || page.total < 0) return new Set()
    for (const row of page.groups) {
      if (typeof row?.group !== 'string' || typeof row.role !== 'string') return new Set()
      if (row.role !== 'left') joined.add(row.group)
    }
  }
  return joined
}

export function visibleRows (rows, blocked) {
  return rows.filter(({ group, community, creator }) => !blocked.has(group) && !blocked.has(community) && !blocked.has(creator))
}

export function trendingRows (rows) {
  return rows.filter(({ active }) => active >= TREND_MIN_ACTIVE)
}

export function tallyFollowed (perDiary, { joined, blocked, own }) {
  const groups = new Map()
  for (const { diary, groups: rows } of perDiary) {
    if (diary === own || blocked.has(diary)) continue
    for (const row of visibleRows(rows, blocked)) {
      const { group } = row
      if (joined.has(group)) continue
      if (!groups.has(group)) groups.set(group, { row, diaries: new Set() })
      groups.get(group).diaries.add(diary)
    }
  }

  const ranked = Array.from(groups.values(), ({ row, diaries }) => {
    const { group, name, creator, community, communityName, writerCount } = row
    return { group, name, creator, community, communityName, writerCount, count: diaries.size }
  })
  ranked.sort((a, b) => b.count - a.count || (a.group < b.group ? -1 : 1))
  return ranked.slice(0, SHELF_ROWS_MAX)
}

export function followReason (count, sampledAll) {
  const reason = count === 1 ? '1 pessoa que você segue está aqui' : count + ' pessoas que você segue estão aqui'
  return sampledAll ? reason : 'Pelo menos ' + reason
}

export function activeText (n) {
  return n + ' pessoas escreveram nos últimos 7 dias'
}

export function olderSeeder (results) {
  if (!Array.isArray(results) || results.length !== 3) return false
  for (const result of results) {
    if (result?.ok !== false || result.reason !== 'not-found') return false
  }
  return true
}
