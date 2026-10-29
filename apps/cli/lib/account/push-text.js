'use strict'

// The pt-BR sentence a Web Push notice shows: who did what, nothing else.
// Never a key, a count, post text or a bio: the push service and the lock
// screen see this text, and the actor's name is the only peer-supplied part.
const { pushName } = require('@varanda/core/lib/push-events')

const PUSH_TITLE = 'Varanda'
const PUSH_FALLBACK_BODY = 'Você tem um aviso novo na Varanda'
const PUSH_BODY_MAX = 120
const NOBODY = 'Alguém'

const ACTIONS = {
  follow: ' começou a seguir você',
  reply: ' respondeu ao seu post',
  like: ' curtiu seu post',
  repost: ' republicou seu post'
}

// Same rule as isValidUsername in apps/app/src/who.js: six hex digits could
// be read as a key prefix, so such a username is never shown as a name.
function validUsername (username) {
  return typeof username === 'string' && /^[a-z][a-z0-9_]{2,19}$/.test(username) && !/^[0-9a-f]{6}$/.test(username)
}

// Like the app's title: the display name, else the verified username written
// as a name (never with '@'), else nobody in particular.
function actorName (name, username) {
  const shown = pushName(name)
  if (shown !== null) return shown
  if (validUsername(username)) return username
  return NOBODY
}

function pushBody ({ kind, name, username } = {}) {
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS, kind)) {
    throw new TypeError('kind must be follow, reply, like or repost')
  }
  const action = ACTIONS[kind]
  const room = PUSH_BODY_MAX - Array.from(action).length
  const actor = Array.from(actorName(name, username)).slice(0, room).join('').trimEnd()
  return (actor === '' ? NOBODY : actor) + action
}

module.exports = {
  PUSH_TITLE,
  PUSH_FALLBACK_BODY,
  PUSH_BODY_MAX,
  pushBody
}
