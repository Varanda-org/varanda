'use strict'

// The genres the music picker offers on its empty Faixas tab, shared by the
// app (the chips) and the account service (the weekly track list it asks the
// provider for). The rules packages/rpc/test/music-genres.test.js enforces:
// 1. Every name answered the provider's weekly track list with tracks of
//    exactly that genre on 18/11/2026, names with a space or '&' included.
//    The provider filters by the exact string and accepts any text, so this
//    list is the only guard.
// 2. Music genres only.
// 3. Left out on purpose: 'Devotional', because a tapped name reaches the
//    account service with the member's session and religion is sensitive
//    data; 'Kids'; and 'Podcasts', 'Audiobooks', 'Spoken Word' and 'Comedy',
//    which are not music.
// 4. The main electronic sub-genres are entries of their own, because the
//    provider's 'Electronic' list does not hold them. Nothing is folded into
//    another name.
// 5. No name holds a comma (the split character of compound provider text)
//    and every name is at most 40 code points (MAX_GENRE of the service's
//    provider module).
// 6. Each entry is one more shared list on the service, at most one refresh
//    every 10 minutes.
// Zero dependencies, no Node built-ins. Never throws.

const MUSIC_GENRES = Object.freeze([
  'Pop',
  'Hip-Hop/Rap',
  'Rock',
  'Electronic',
  'R&B/Soul',
  'Latin',
  'Funk',
  'Reggae',
  'Jazz',
  'Alternative',
  'Indie',
  'Metal',
  'Folk',
  'Acoustic',
  'Classical',
  'Lo-Fi',
  'House',
  'Techno',
  'Trance',
  'Dubstep',
  'Drum & Bass',
  'Trap',
  'Deep House',
  'Tech House'
])

// Exact and case-sensitive: no trim, no case fold, no comma split.
function isMusicGenre (v) {
  return typeof v === 'string' && MUSIC_GENRES.includes(v)
}

module.exports = { MUSIC_GENRES, isMusicGenre }
