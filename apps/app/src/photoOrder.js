// The first photo is the cover: it sets the carousel frame and the Mural tile.
// A move reorders that cover and keeps each photo the same object.

export function moveItem (list, from, to) {
  if (!Array.isArray(list)) return list
  if (!Number.isInteger(from) || !Number.isInteger(to)) return list
  if (from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  if (from === to) return list
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

// By id rather than by the index of the last render: a second tap that lands
// before the re-render still moves the photo that was tapped.
export function moveById (list, id, delta) {
  if (!Array.isArray(list)) return list
  const from = list.findIndex((item) => item && item.id === id)
  if (from < 0) return list
  return moveItem(list, from, from + delta)
}
