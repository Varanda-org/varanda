// Seguindo ignores empty input, follows a key directly, validates and resolves
// a handle, and searches a name. Partial keys show guidance instead of reaching
// the search index, since its queryPath does not reject hexadecimal input.
export const PARTIAL_KEY_TEXT = 'Código incompleto: são 64 letras e números.'

export function classifyFollowInput (text) {
  if (typeof text !== 'string' || !text.trim()) return { kind: 'empty' }
  const value = text.trim()
  if (/^[0-9a-fA-F]{64}$/.test(value)) return { kind: 'key', key: value.toLowerCase() }
  if (/^[0-9a-fA-F]{21,}$/.test(value)) return { kind: 'partial-key' }
  if (value.startsWith('@')) return { kind: 'handle', handle: value }
  return { kind: 'name' }
}
