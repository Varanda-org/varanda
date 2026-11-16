// Undo for removing a photo from the Anunciar grid: take one out by id and
// put it back where it was. Pure, so the order rules run without React.

// -> { list, removed: { item, index } | null }. An unknown id changes nothing.
export function removeById (list, id) {
  if (!Array.isArray(list)) return { list, removed: null }
  const index = list.findIndex((item) => item && item.id === id)
  if (index < 0) return { list, removed: null }
  return { list: [...list.slice(0, index), ...list.slice(index + 1)], removed: { item: list[index], index } }
}

// Back at its index, or at the end when the list has shrunk since. Nothing
// changes when the photo is already there or the list is full: a photo added
// in the meantime keeps its place and the cap holds.
export function restoreRemoved (list, removed, max = Infinity) {
  if (!Array.isArray(list) || !removed || !removed.item || !Number.isInteger(removed.index)) return list
  if (list.length >= max || list.some((item) => item && item.id === removed.item.id)) return list
  const at = Math.min(Math.max(removed.index, 0), list.length)
  return [...list.slice(0, at), removed.item, ...list.slice(at)]
}
