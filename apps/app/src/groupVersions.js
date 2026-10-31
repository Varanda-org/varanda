// Versions are local invalidation signals, not group lengths or post counts.
import rpc from '@varanda/rpc'

export const EMPTY_GROUP_VERSIONS = Object.freeze({})

export function readGroupVersion (versions, group) {
  return Object.hasOwn(versions, group) ? versions[group] : 0
}

export function bumpGroupVersion (versions, group) {
  if (!rpc.isKey(group)) return versions
  return { ...versions, [group]: readGroupVersion(versions, group) + 1 }
}

export function clearGroupVersions () {
  return EMPTY_GROUP_VERSIONS
}
