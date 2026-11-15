// Hashtags in peer text: '#' plus a run of letters or digits. Pure: no React,
// React Native or Node built-ins. Peer text is untrusted, so a candidate that
// does not fold to exactly one [a-z0-9]{2,32} token stays plain text.

import { foldText } from './topics.js'

// Same pattern as TOKEN in topicPage.js and TAG in nav.js; keep the three in step.
const TAG_RE = /^[a-z0-9]{2,32}$/

// Code-point ranges instead of Unicode property escapes, which Hermes is not
// known to support. The combining marks (0x300-0x36f) sit inside the range,
// so a decomposed accent stays in its run and folds away. The ranges are
// richText.js isWordCp's (keep them in step) plus the Kelvin and Angstrom
// signs, which the index folds to 'k' and 'a', so a tag never stops inside
// a word the index reads whole. A copy, not an import: richText.js imports
// links.js, which imports this file.
function isWordCp (cp) {
  if (cp < 0x80) return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)
  return (cp >= 0xc0 && cp <= 0x1fff && cp !== 0xd7 && cp !== 0xf7) ||
    (cp >= 0x3040 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7a3) || cp === 0x212a || cp === 0x212b
}

// Same set as richText.js isSpaceCp; keep the two in step.
function isSpaceCp (cp) {
  return (cp >= 0x09 && cp <= 0x0d) || cp === 0x20 || cp === 0xa0 || cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f ||
    cp === 0x205f || cp === 0x3000
}

function wordBefore (text, i) {
  const low = text.charCodeAt(i - 1)
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = text.charCodeAt(i - 2)
    if (high >= 0xd800 && high <= 0xdbff) return isWordCp(text.codePointAt(i - 2))
  }
  return isWordCp(low)
}

// A '#' after a scheme, a www host or a '/' in the same space-delimited token
// is a URL fragment, whatever precedes it (a '/' or '?' would pass the
// boundary), so 'exemplo.com/#secao' has no tag.
function inUrl (text, hash) {
  let s = hash
  while (s > 0 && !isSpaceCp(text.charCodeAt(s - 1))) s--
  const head = text.slice(s, hash)
  return head.includes('/') || /(?:^|[^a-z0-9])www\./i.test(head)
}

// Every hashtag as { start, end, tag }: offsets into text (end past the last
// character of the run) and the folded token. Adjacent '#a#b' gives only 'a':
// the second '#' follows a word character, as does one after '#' itself, so a
// run of hashes is never read as several tags.
export function findTags (text) {
  const out = []
  if (typeof text !== 'string') return out
  try {
    let from = 0
    for (;;) {
      const at = text.indexOf('#', from)
      if (at === -1) break
      from = at + 1
      if (at > 0 && (wordBefore(text, at) || text[at - 1] === '#')) continue
      let end = at + 1
      while (end < text.length) {
        const cp = text.codePointAt(end)
        if (!isWordCp(cp)) break
        end += cp > 0xffff ? 2 : 1
      }
      if (end === at + 1) continue
      const tag = foldText(text.slice(at + 1, end))
      if (!TAG_RE.test(tag) || inUrl(text, at)) continue
      out.push({ start: at, end, tag })
      from = end
    }
  } catch {
    return []
  }
  return out
}

export function tagsOf (text) {
  const seen = new Set()
  for (const { tag } of findTags(text)) seen.add(tag)
  return [...seen]
}

export function hasTag (text, token) {
  if (typeof token !== 'string') return false
  const want = foldText(token)
  return findTags(text).some(({ tag }) => tag === want)
}
