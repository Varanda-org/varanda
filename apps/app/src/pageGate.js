// Whether the Páginas entry points are shown. A hosted node always has the
// account service on its own origin; a core node only when it was given an
// https account origin (a plain http or malformed one never counts) and this
// bundle can reach that origin at all (setCoreReach, from src/pageReach.*.js).
// No imports: Metro bundles the file and the tests load it with import().

let coreReach = false

export function setCoreReach (on) {
  coreReach = on === true
}

export function accountOriginOf (value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.host !== '' ? url.origin : undefined
  } catch {
    return undefined
  }
}

export function pagesOn ({ hosted, accountOrigin } = {}) {
  return hosted === true || (coreReach && accountOriginOf(accountOrigin) !== undefined)
}

// Pages on a node that is not hosted: its pages go through its account origin
// and the node itself signs nothing for them (page.register, rpc 5.87).
export function pagesCore ({ hosted, accountOrigin } = {}) {
  return hosted !== true && coreReach && accountOriginOf(accountOrigin) !== undefined
}
