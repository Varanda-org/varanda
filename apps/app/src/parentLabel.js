// The context line over the post a thread reply answers. Pure, so tests load
// it alone. The name is peer text and goes through displayText.
import rpc from '@varanda/rpc'
import { UNNAMED, whoOf } from './who.js'

// profile: {name, username} as the thread screen knows it, raw. With no name
// to show, the line stands alone rather than say "sem nome".
export function parentLabel (profile) {
  const title = whoOf(profile).title
  const name = title === UNNAMED ? '' : rpc.displayText(title)
  return name === '' ? 'Em resposta a' : 'Em resposta a ' + name
}
