// Each lookup is one local read of at most 100 rows.
export const MAX_COMMON_LOOKUPS = 8

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isKey = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const ROLES = ['creator', 'admin', 'member']

export function communitiesOf (listResult) {
  if (!isObject(listResult) || !Array.isArray(listResult.communities)) return []
  const seen = new Set()
  const items = []
  for (const row of listResult.communities) {
    if (!isObject(row) || !isKey(row.community) || row.state !== 'ready' || !ROLES.includes(row.role)) continue
    if (typeof row.name !== 'string' || row.name.length === 0 || seen.has(row.community)) continue
    seen.add(row.community)
    items.push({ community: row.community, name: row.name })
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }) || a.community.localeCompare(b.community))
}

export function commonCommunities (own, membersByCommunity, person) {
  if (!Array.isArray(own) || !(membersByCommunity instanceof Map) || !isKey(person)) return { count: 0, items: [] }
  const items = own.filter((item) => {
    if (!isObject(item) || !isKey(item.community)) return false
    const members = membersByCommunity.get(item.community)
    return Array.isArray(members) && members.some((row) => isObject(row) && row.member === person && row.banned !== true)
  })
  return { count: items.length, items }
}
