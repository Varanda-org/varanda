'use strict'

// @varanda/rpc: the JSON contract between the UI and a Varanda node
// (normative spec: docs/rpc.md). Zero dependencies, no Node built-ins.

const limits = require('./lib/limits')
const errors = require('./lib/errors')
const methods = require('./lib/methods')
const envelope = require('./lib/envelope')
const framing = require('./lib/framing')
const text = require('./lib/text')
const mentions = require('./lib/mentions')
const mediaBounds = require('./lib/media-bounds')
const audioBounds = require('./lib/audio-bounds')
const dmBudget = require('./lib/dm-budget')
const linkCard = require('./lib/link-card')
const music = require('./lib/music')
const ogParse = require('./lib/og-parse')
const feira = require('./lib/feira')
const inviteCard = require('./lib/invite-card')
const { tokensEqual } = require('./lib/token')
const { createServerDispatcher } = require('./lib/server')
const { createClient } = require('./lib/client')

module.exports = {
  ...limits,
  ...errors,
  METHODS: methods.METHODS,
  MUTATING: methods.MUTATING,
  isMethod: methods.isMethod,
  isMutating: methods.isMutating,
  validateParams: methods.validateParams,
  isKey: methods.isKey,
  isRef: methods.isRef,
  EVENTS: envelope.EVENTS,
  STOP_REASONS: envelope.STOP_REASONS,
  validateRequest: envelope.validateRequest,
  validateResponse: envelope.validateResponse,
  validateEvent: envelope.validateEvent,
  encodeFrame: framing.encodeFrame,
  createFrameDecoder: framing.createFrameDecoder,
  parseMessage: framing.parseMessage,
  displayText: text.displayText,
  findMentions: mentions.findMentions,
  mentionTokens: mentions.mentionTokens,
  mentionSegments: mentions.mentionSegments,
  activeMention: mentions.activeMention,
  MENTION_MAX: mentions.MENTION_MAX,
  mediaBounds: mediaBounds.mediaBounds,
  MAX_MEDIA_PIXELS: mediaBounds.MAX_MEDIA_PIXELS,
  MAX_MEDIA_FRAMES: mediaBounds.MAX_MEDIA_FRAMES,
  MAX_MEDIA_TOTAL_PIXELS: mediaBounds.MAX_MEDIA_TOTAL_PIXELS,
  audioBounds: audioBounds.audioBounds,
  stripAudioMetadata: audioBounds.stripAudioMetadata,
  MAX_AUDIO_MS: audioBounds.MAX_AUDIO_MS,
  AUDIO_MS_TOLERANCE: audioBounds.AUDIO_MS_TOLERANCE,
  utf8ByteLength: text.utf8ByteLength,
  utf8Encode: text.utf8Encode,
  utf8Decode: text.utf8Decode,
  clipText: text.clipText,
  DM_INNER_KEYS: dmBudget.DM_INNER_KEYS,
  DM_INNER_KEYS_V2: dmBudget.DM_INNER_KEYS_V2,
  DM_MEDIA_KEYS: dmBudget.DM_MEDIA_KEYS,
  DM_CARD_KEYS: dmBudget.DM_CARD_KEYS,
  dmInnerVersion: dmBudget.innerVersion,
  canonicalDmInnerJson: dmBudget.canonicalInnerJson,
  dmTextBytes: dmBudget.dmTextBytes,
  dmTextBudget: dmBudget.dmTextBudget,
  MEMBER_CERT_STANDIN: dmBudget.MEMBER_CERT_STANDIN,
  MAX_CARD_URL: linkCard.MAX_CARD_URL,
  MAX_CARD_TITLE: linkCard.MAX_CARD_TITLE,
  MAX_CARD_DESC: linkCard.MAX_CARD_DESC,
  MAX_CARD_IMAGE_BYTES: linkCard.MAX_CARD_IMAGE_BYTES,
  isCardForbiddenChar: linkCard.isCardForbiddenChar,
  cardTextLength: linkCard.cardTextLength,
  cardText: linkCard.cardText,
  cardUrlHost: linkCard.cardUrlHost,
  MOMENT_MUSIC_KEYS: music.MOMENT_MUSIC_KEYS,
  MOMENT_SNIPPET_S: music.MOMENT_SNIPPET_S,
  isMomentMusic: music.isMomentMusic,
  MAX_OG_HTML: ogParse.MAX_OG_HTML,
  parseOg: ogParse.parseOg,
  ogText: ogParse.ogText,
  ogImageUrl: ogParse.ogImageUrl,
  feira,
  ...inviteCard,
  tokensEqual,
  createServerDispatcher,
  createClient
}
