'use strict'

// The member's own mute list: whose posts and notices this member chose not
// to see in A Rua and Avisos, without blocking. Follows, messages, the
// person's profile and everything else stay as they were, the other person is
// never told, and nothing about the mute is published.
// Pure: the same entries and rules as the block list (member-block.js), with
// MUTE_MAX as the cap. Entries are { key, on, t }; an unmute stays as on:
// false, so devices that merge their lists do not bring a mute back.

const { MUTE_MAX } = require('@varanda/rpc')
const { normalizeBlocks, blockedKeys, applyBlock, mergeBlocks } = require('./member-block')

const normalizeMutes = (list) => normalizeBlocks(list, MUTE_MAX)
const mutedKeys = (list) => blockedKeys(list, MUTE_MAX)
const applyMute = (list, key, on, nowSec) => applyBlock(list, key, on, nowSec, MUTE_MAX)
const mergeMutes = (a, b) => mergeBlocks(a, b, MUTE_MAX)

module.exports = { normalizeMutes, mutedKeys, applyMute, mergeMutes }
