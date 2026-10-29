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
  utf8ByteLength: text.utf8ByteLength,
  utf8Encode: text.utf8Encode,
  utf8Decode: text.utf8Decode,
  clipText: text.clipText,
  tokensEqual,
  createServerDispatcher,
  createClient
}
