// A tapped hashtag as a nav entry. Pure: the tag is a peer's text, so it is
// folded and checked by topicPath, and anything that is not exactly one usable
// token has no target (the span then stays plain text).

import { topicPath } from './topicPage.js'

// { screen: 'assunto', key: token } for a tag with or without the '#', else null.
export function tagTarget (tag) {
  if (typeof tag !== 'string') return null
  const found = topicPath(tag)
  return found === null ? null : { screen: 'assunto', key: found.token }
}

// Title of the page for a token.
export function tagTitle (token) {
  return '#' + token
}
