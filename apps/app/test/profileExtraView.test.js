'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const rpc = require('@varanda/rpc')

const load = () => import('../src/profileExtraView.js')
const read = (name) => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8')
const AUTHOR = 'a'.repeat(64)
const NOW = Date.UTC(2026, 10, 15, 12)
const H = 60 * 60 * 1000
const iso = (ms) => new Date(ms).toISOString()
const aboutRecord = (extra = {}) => ({ type: 'profile-about', about: 'Oi', city: null, work: null, studies: null, interests: null, birthday: null, theme: null, at: iso(NOW - H), ...extra })

test('every mood offered is a valid reaction with a name', async (t) => {
  const { MOODS } = await load()
  t.ok(MOODS.length >= 8)
  for (const m of MOODS) {
    t.ok(rpc.isReaction(m.e), m.e)
    t.ok(m.name.length > 0, m.name)
  }
  t.is(new Set(MOODS.map((m) => m.e)).size, MOODS.length)
})

test('birthday input reads dia/mês and writes MM-DD', async (t) => {
  const { birthdayFromInput, birthdayToInput } = await load()
  t.alike(birthdayFromInput('15/03'), { ok: true, value: '03-15' })
  t.alike(birthdayFromInput(' 5-3 '), { ok: true, value: '03-05' })
  t.alike(birthdayFromInput('29/02'), { ok: true, value: '02-29' })
  t.alike(birthdayFromInput(''), { ok: true, value: null })
  t.alike(birthdayFromInput('   '), { ok: true, value: null })
  for (const bad of ['31/04', '30/02', '00/10', '10/13', '2000', 'abc', '15/03/1990', '1503']) {
    t.is(birthdayFromInput(bad).ok, false, bad)
  }
  t.is(birthdayToInput('03-15'), '15/03')
  t.is(birthdayToInput('13-01'), '')
  t.is(birthdayToInput(null), '')
})

test('aboutParams sends all seven keys, null for empty, and trims', async (t) => {
  const { aboutParams, emptyAboutDraft } = await load()
  const empty = aboutParams(emptyAboutDraft())
  t.is(empty.ok, true)
  t.alike(empty.params, { about: null, city: null, work: null, studies: null, interests: null, birthday: null, theme: null })
  const full = aboutParams({ about: '  Olá\r\nmundo  ', city: ' Recife ', work: 'a\nb', studies: '', interests: 'café', birthday: '15/03', theme: 'mar' })
  t.is(full.ok, true)
  t.alike(full.params, { about: 'Olá\nmundo', city: 'Recife', work: 'a b', studies: null, interests: 'café', birthday: '03-15', theme: 'mar' })
  t.is(aboutParams({ ...emptyAboutDraft(), theme: 'nope' }).params.theme, null)
})

test('aboutParams refuses what the node would refuse, and listed terms', async (t) => {
  const { aboutParams, emptyAboutDraft, TEXTS } = await load()
  const d = emptyAboutDraft()
  t.is(aboutParams({ ...d, about: 'x'.repeat(601) }).ok, false)
  t.is(aboutParams({ ...d, about: 'x'.repeat(600) }).ok, true)
  t.is(aboutParams({ ...d, city: 'x'.repeat(61) }).ok, false)
  t.is(aboutParams({ ...d, work: 'x'.repeat(81) }).ok, false)
  t.is(aboutParams({ ...d, interests: 'x'.repeat(201) }).ok, false)
  t.is(aboutParams({ ...d, city: '😀'.repeat(60) }).ok, true, 'limits count code points')
  t.is(aboutParams({ ...d, city: 'a\u202eb' }).error, TEXTS.badText, 'bidi control')
  t.is(aboutParams({ ...d, city: '\u200b\u200b' }).params.city, null, 'invisible-only text is not sent')
  t.is(aboutParams({ ...d, birthday: '31/02' }).error, TEXTS.badBirthday)
  const wc = await import('../src/wordCheck.js')
  const { BLOCKED_TERMS } = require('@varanda/rpc')
  const term = BLOCKED_TERMS.find((x) => !x.includes(' '))
  const blocked = aboutParams({ ...d, interests: 'gosto de ' + term })
  t.is(blocked.ok, false)
  t.is(blocked.error, wc.refusalText(term))
})

test('every params the editor builds passes the node validators', async (t) => {
  const { aboutParams } = await load()
  const r = aboutParams({ about: 'Texto', city: 'Rio', work: 'Padaria', studies: 'Letras', interests: 'samba', birthday: '1/1', theme: 'terra' })
  t.is(r.ok, true)
  const { profileExtra: px } = rpc
  t.ok(px.isAbout(r.params.about) && px.isCity(r.params.city) && px.isWork(r.params.work) && px.isStudies(r.params.studies) && px.isInterests(r.params.interests))
  t.ok(px.isBirthday(r.params.birthday) && px.isThemeId(r.params.theme))
})

test('draftFromRecord starts the editor from the own record', async (t) => {
  const { draftFromRecord, emptyAboutDraft } = await load()
  t.alike(draftFromRecord(null), emptyAboutDraft())
  t.alike(draftFromRecord(aboutRecord({ city: 'Recife', birthday: '03-15', theme: 'flor' })), { about: 'Oi', city: 'Recife', work: '', studies: '', interests: '', birthday: '15/03', theme: 'flor' })
  t.is(draftFromRecord(aboutRecord({ theme: 'nope' })).theme, null)
})

test('the editor seeds from the raw fields, so a save never writes back U+FFFD', async (t) => {
  const { draftFromRecord, moodDraftFromRecord, aboutParams } = await load()
  const record = aboutRecord({ about: 'Oi\u200f tudo', city: 'Rio\u200e' })
  t.ok(rpc.profileExtra.isAbout(record.about) && rpc.profileExtra.isCity(record.city), 'valid text the node stores')
  t.ok(rpc.displayText(record.about).includes('\ufffd'), 'displayText would replace it')
  const draft = draftFromRecord(record)
  t.is(draft.about, 'Oi\u200f tudo')
  t.is(draft.city, 'Rio\u200e')
  const params = aboutParams(draft).params
  t.is(params.about, record.about)
  t.absent(JSON.stringify(params).includes('\ufffd'))
  const mood = { type: 'mood', emoji: '😊', text: 'bem\u200f', at: iso(NOW - H) }
  t.alike(moodDraftFromRecord(mood, NOW), { emoji: '😊', text: 'bem\u200f' })
  t.alike(moodDraftFromRecord(mood, NOW + 24 * H), { emoji: '', text: '' }, 'a mood past its 24 hours starts empty')
  t.alike(moodDraftFromRecord(null, NOW), { emoji: '', text: '' })
})

test('the mood hint says the record stays in the diary until Apagar humor', async (t) => {
  const { TEXTS, MOODS } = await load()
  t.absent(/some sozinh/.test(TEXTS.moodHint), 'never claims it goes away by itself')
  t.ok(TEXTS.moodHint.includes('24 horas'))
  t.ok(TEXTS.moodHint.includes('diário público') && TEXTS.moodHint.includes(TEXTS.moodDelete))
  t.ok(/substitui o anterior/.test(TEXTS.moodHint))
  t.absent(MOODS.some((m) => m.e === '🤒' || m.name === 'doente'), 'no doente preset')
})

test('aboutMatches compares every key', async (t) => {
  const { aboutMatches, aboutParams, draftFromRecord } = await load()
  const record = aboutRecord({ city: 'Recife', theme: 'mar' })
  const params = aboutParams(draftFromRecord(record)).params
  t.is(aboutMatches(params, record), true)
  t.is(aboutMatches({ ...params, city: 'Olinda' }, record), false)
  t.is(aboutMatches({ ...params, theme: null }, record), false)
  t.is(aboutMatches(params, null), false)
  t.is(aboutMatches(null, record), false)
})

test('moodParams: emoji or text, both empty clears, limits and word check apply', async (t) => {
  const { moodParams, moodMatches, TEXTS } = await load()
  t.alike(moodParams({ emoji: '😊', text: ' feliz ' }), { ok: true, params: { emoji: '😊', text: 'feliz' }, error: '', clears: false })
  t.is(moodParams({ emoji: '', text: 'só texto' }).ok, true)
  t.is(moodParams({ emoji: '', text: '' }).clears, true)
  t.is(moodParams({ emoji: 'ab', text: '' }).error, TEXTS.badText)
  t.is(moodParams({ emoji: '😊😊', text: '' }).ok, false)
  t.is(moodParams({ emoji: '', text: 'x'.repeat(61) }).ok, false)
  t.is(moodParams({ emoji: '', text: 'x'.repeat(60) }).ok, true)
  t.is(moodParams({ emoji: '', text: 'a\u202eb' }).ok, false)
  t.is(moodMatches({ emoji: '😊', text: 'feliz' }, { emoji: '😊', text: 'feliz' }), true)
  t.is(moodMatches({ emoji: '', text: '' }, { emoji: '', text: '' }), true)
  t.is(moodMatches({ emoji: '😊', text: '' }, { emoji: '😢', text: '' }), false)
  t.is(moodMatches({ emoji: '😊', text: '' }, null), false)
})

test('the peek plan asks only for the seqs the seeder named', async (t) => {
  const { planExtraPeeks } = await load()
  t.alike(planExtraPeeks({ about: 4, mood: 9 }, AUTHOR), [{ author: AUTHOR, seqs: [4, 9] }])
  t.alike(planExtraPeeks({ about: null, mood: 9 }, AUTHOR), [{ author: AUTHOR, seqs: [9] }])
  t.alike(planExtraPeeks({ about: null, mood: null }, AUTHOR), [])
  t.alike(planExtraPeeks({ about: 0, mood: -1 }, AUTHOR), [])
  t.alike(planExtraPeeks({ about: 'x', mood: 1.5 }, AUTHOR), [])
  t.alike(planExtraPeeks(null, AUTHOR), [])
  t.alike(planExtraPeeks({ about: 1 }, 5), [])
})

test('readExtra trusts only the author\'s own diary under the named seq and type', async (t) => {
  const { readExtra } = await load()
  const about = aboutRecord()
  const mood = { type: 'mood', emoji: '😊', text: '', at: iso(NOW) }
  const peek = { key: AUTHOR, entries: [{ seq: 4, record: about }, { seq: 9, record: mood }] }
  const ok = readExtra({ about: 4, mood: 9 }, [peek], AUTHOR)
  t.alike(ok.about, { seq: 4, record: about })
  t.alike(ok.mood, { seq: 9, record: mood })
  t.alike(readExtra({ about: 4, mood: 9 }, [{ ...peek, key: 'b'.repeat(64) }], AUTHOR), { about: null, mood: null }, 'another diary')
  t.alike(readExtra({ about: 5, mood: 9 }, [peek], AUTHOR).about, null, 'seq the seeder did not name')
  t.alike(readExtra({ about: 9, mood: 4 }, [peek], AUTHOR), { about: null, mood: null }, 'wrong type under the pointer')
  t.alike(readExtra({ about: 4, mood: null }, [{ key: AUTHOR, entries: [{ seq: 4, record: { type: 'post' } }] }], AUTHOR).about, null)
  t.alike(readExtra({ about: 4 }, [{ key: AUTHOR, entries: 'x' }], AUTHOR).about, null)
  t.alike(readExtra({ about: 4 }, new Map([[AUTHOR, [peek]]]), AUTHOR).about, { seq: 4, record: about })
  t.alike(readExtra(undefined, [peek], AUTHOR), { about: null, mood: null })
})

test('a seq the seeder named but that did not verify settles nothing', async (t) => {
  const { readExtra, extraStatus } = await load()
  const about = aboutRecord()
  const mood = { type: 'mood', emoji: '😊', text: '', at: iso(NOW) }
  const pointers = { about: 4, mood: 9, complete: true }
  const both = { key: AUTHOR, entries: [{ seq: 4, record: about }, { seq: 9, record: mood }], invalid: [], missing: [] }
  t.is(extraStatus(pointers, readExtra(pointers, [both], AUTHOR)), 'ready')
  const aboutMissing = { key: AUTHOR, entries: [{ seq: 9, record: mood }], invalid: [], missing: [4] }
  const got = readExtra(pointers, [aboutMissing], AUTHOR)
  t.is(got.about, null)
  t.is(extraStatus(pointers, got), 'unsure', 'about in missing: the editor stays locked')
  const moodMissing = { key: AUTHOR, entries: [{ seq: 4, record: about }], invalid: [], missing: [9] }
  t.is(extraStatus(pointers, readExtra(pointers, [moodMissing], AUTHOR)), 'unsure', 'same for the mood')
  t.is(extraStatus(pointers, readExtra(pointers, [], AUTHOR)), 'unsure', 'no peek came back')
  t.is(extraStatus({ about: null, mood: null, complete: true }, { about: null, mood: null }), 'ready', 'complete and empty')
  t.is(extraStatus({ about: null, mood: null, complete: false }, { about: null, mood: null }), 'unsure', 'still indexing')
  t.is(extraStatus({ about: 4, mood: null, complete: false }, { about: { seq: 4, record: about }, mood: null }), 'unsure', 'the mood is not known yet')
  t.is(extraStatus(null, null), 'unsure')
})

test('the own diary walk: newest live record wins, tombstones skipped, settles at the start', async (t) => {
  const { ownExtraScan, ownLogParams, ownRecordAt, OWN_LOG_PAGES } = await load()
  t.ok(OWN_LOG_PAGES >= 1)
  t.alike(ownLogParams(), { limit: rpc.LOG_LIMIT_MAX })
  t.alike(ownLogParams(41), { limit: rpc.LOG_LIMIT_MAX, before: 41 })
  t.alike(ownLogParams(0), { limit: rpc.LOG_LIMIT_MAX })
  const old = aboutRecord({ about: 'velho' })
  const live = aboutRecord({ about: 'novo' })
  const mood = { type: 'mood', emoji: '😊', text: 'bem', at: iso(NOW) }
  // seq 50 was the newest about, now tombstoned (log.read lists it in invalid).
  const top = { key: AUTHOR, entries: [{ seq: 40, record: live }, { seq: 45, record: { type: 'post', text: 'x' } }, { seq: 51, record: { type: 'delete', seq: 50, at: iso(NOW) } }], invalid: [{ seq: 50, reason: 'deleted' }], entriesTruncated: 39 }
  const first = ownExtraScan([top], AUTHOR)
  t.alike(first.held.about, { seq: 40, record: live }, 'the tombstoned 50 never counts')
  t.is(first.held.mood, null)
  t.is(first.settled, false, 'no mood yet and the diary goes on')
  t.is(first.next, 40)
  const mid = { key: AUTHOR, entries: [{ seq: 12, record: old }, { seq: 20, record: mood }], invalid: [], entriesTruncated: 11 }
  const second = ownExtraScan([top, mid], AUTHOR)
  t.alike(second.held.about, { seq: 40, record: live }, 'an older version never replaces the newest')
  t.alike(second.held.mood, { seq: 20, record: mood })
  t.is(second.settled, true)
  t.is(second.next, null)
  const onlyAbout = { key: AUTHOR, entries: [{ seq: 3, record: old }], invalid: [], entriesTruncated: 0 }
  const start = ownExtraScan([onlyAbout], AUTHOR)
  t.is(start.settled, true, 'the start of the diary: no mood exists')
  t.is(start.held.mood, null)
  t.alike(ownExtraScan([{ ...top, key: 'b'.repeat(64) }], AUTHOR), { held: { about: null, mood: null }, settled: false, next: null }, 'another diary settles nothing')
  t.alike(ownExtraScan([{ key: AUTHOR, entries: [], invalid: [], entriesTruncated: 5 }], AUTHOR), { held: { about: null, mood: null }, settled: false, next: null }, 'a page that cannot be walked past')
  t.alike(ownExtraScan([], AUTHOR), { held: { about: null, mood: null }, settled: false, next: null })
  t.alike(ownRecordAt(top, AUTHOR, 'about', 40), { seq: 40, record: live })
  t.is(ownRecordAt(top, AUTHOR, 'about', 50), null, 'a tombstoned seq')
  t.is(ownRecordAt(top, AUTHOR, 'mood', 40), null, 'wrong type')
  t.is(ownRecordAt(top, 'b'.repeat(64), 'about', 40), null, 'another diary')
})

test('newerExtra keeps the higher seq so a lagging seeder cannot undo a write', async (t) => {
  const { newerExtra } = await load()
  const a5 = { seq: 5, record: aboutRecord() }
  const a3 = { seq: 3, record: aboutRecord({ about: 'velho' }) }
  t.alike(newerExtra({ about: a5, mood: null }, { about: a3, mood: null }).about, a5)
  t.alike(newerExtra({ about: a3, mood: null }, { about: a5, mood: null }).about, a5)
  t.alike(newerExtra({ about: null, mood: null }, { about: a3, mood: null }).about, a3)
  t.alike(newerExtra(undefined, undefined), { about: null, mood: null })
})

test('extraView: no record shows nothing, a theme needs a known id, a stale mood is gone', async (t) => {
  const { extraView } = await load()
  t.alike(extraView({ about: null, mood: null }, NOW), { theme: null, about: null, mood: null }, 'looks as today')
  t.alike(extraView(undefined, NOW), { theme: null, about: null, mood: null })
  const v = extraView({ about: { seq: 1, record: aboutRecord({ theme: 'mar', city: 'Recife' }) }, mood: null }, NOW)
  t.is(v.theme, 'mar')
  t.is(v.about.about, 'Oi')
  t.is(v.about.rows[0].value, 'Recife')
  t.is(extraView({ about: { seq: 1, record: aboutRecord({ theme: 'nope' }) }, mood: null }, NOW).theme, null)
  t.is(extraView({ about: { seq: 1, record: aboutRecord({ theme: null }) }, mood: null }, NOW).theme, null, 'no theme keeps the sunset band')
  const only = extraView({ about: { seq: 1, record: aboutRecord({ about: null, theme: 'ipe' }) }, mood: null }, NOW)
  t.is(only.about, null, 'nothing to show in the card')
  t.is(only.theme, 'ipe', 'the theme still applies')
  const live = { seq: 2, record: { type: 'mood', emoji: '😊', text: 'bem', at: iso(NOW - 2 * H) } }
  t.is(extraView({ about: null, mood: live }, NOW).mood.text, 'bem')
  t.is(extraView({ about: null, mood: live }, NOW + 23 * H).mood, null, '24 hours by the reader clock')
  t.is(extraView({ about: null, mood: { seq: 2, record: { type: 'mood', emoji: '', text: '', at: iso(NOW) } } }, NOW).mood, null, 'cleared')
})

test('peer text in the about card comes out through displayText', async (t) => {
  const { extraView } = await load()
  const v = extraView({ about: { seq: 1, record: aboutRecord({ about: 'a\u202eb', city: 'x\u0007y' }) }, mood: null }, NOW)
  t.absent(JSON.stringify(v.about).includes('\u202e') || JSON.stringify(v.about).includes('\\u0007') || JSON.stringify(v.about).includes('\u0007'))
})

test('an incomplete index answer is unknown, never "no Sobre mim, no mood, default theme"', async (t) => {
  const { extraKnown, readExtra, planExtraPeeks, newerExtra, extraView } = await load()
  const indexing = { about: null, mood: null, indexing: true, complete: false }
  t.alike(extraKnown(indexing), { about: false, mood: false }, 'nothing is settled while indexing')
  t.alike(extraKnown({ about: 4, mood: null, indexing: true, complete: false }), { about: true, mood: false }, 'a named seq is known, an unnamed one is not')
  t.alike(extraKnown({ about: null, mood: null, indexing: false, complete: true }), { about: true, mood: true }, 'complete and empty: there is none')
  t.alike(extraKnown(null), { about: false, mood: false })
  t.alike(extraKnown({ about: null, mood: null }), { about: false, mood: false }, 'no flag is not complete')
  t.alike(planExtraPeeks(indexing, AUTHOR), [], 'nothing to read')
  t.alike(readExtra(indexing, [], AUTHOR), { about: null, mood: null })
  // What is on screen survives an indexing answer, so no flash back to the default theme.
  const held = { about: { seq: 4, record: aboutRecord({ theme: 'flor' }) }, mood: { seq: 9, record: { type: 'mood', emoji: '😊', text: 'bem', at: iso(NOW - H) } } }
  const kept = newerExtra(held, readExtra(indexing, [], AUTHOR))
  t.alike(kept, held)
  const v = extraView(kept, NOW)
  t.is(v.theme, 'flor')
  t.is(v.mood.text, 'bem')
  t.is(v.about.about, 'Oi')
})

test('moodRemaining and moodLabel', async (t) => {
  const { moodRemaining, moodLabel } = await load()
  const at = NOW
  t.is(moodRemaining({ expiresAt: at + 5 * H }, NOW), 'some em 5 h')
  t.is(moodRemaining({ expiresAt: at + 4.2 * H }, NOW), 'some em 5 h')
  t.is(moodRemaining({ expiresAt: at + 40 * 60000 }, NOW), 'some em 40 min')
  t.is(moodRemaining({ expiresAt: at + 30000 }, NOW), 'some em instantes')
  t.is(moodRemaining({ expiresAt: at + 99 * H }, NOW), 'some em 24 h', 'never past the 24 hour window')
  t.is(moodRemaining(null, NOW), '')
  t.is(moodLabel({ emoji: '😊', text: 'bem' }), '😊 bem')
  t.is(moodLabel({ emoji: null, text: 'bem' }), 'bem')
})

test('bandTint pairs keep 4.5:1 in every theme and scheme, and none without a theme', async (t) => {
  const { bandTint } = await load()
  const { THEME_IDS } = await import('../src/profileThemes.js')
  const { contrastRatio } = await import('../src/appearance.js')
  t.is(bandTint(null, 'light'), null)
  t.is(bandTint('nope', 'dark'), null)
  for (const id of THEME_IDS) {
    for (const scheme of ['light', 'dark']) {
      const c = bandTint(id, scheme)
      t.ok(contrastRatio(c.icon, c.disc) >= 4.5, id + ' ' + scheme)
    }
  }
})

test('deleteParams, canDelete and the nada para apagar answer', async (t) => {
  const { deleteParams, canDelete, isNothingToDelete, deleteAsk, deletedNote, TEXTS } = await load()
  t.alike(deleteParams('about'), { ok: true, params: { kind: 'about' } })
  t.alike(deleteParams('mood'), { ok: true, params: { kind: 'mood' } })
  for (const bad of ['theme', '', null, undefined, 3, 'ABOUT']) t.is(deleteParams(bad).ok, false, String(bad))
  t.ok(rpc.isMutating('profile.extra.delete'))
  for (const k of ['about', 'mood']) t.ok(rpc.validateParams('profile.extra.delete', deleteParams(k).params), 'the rpc takes ' + k)
  const held = { about: { seq: 3, record: aboutRecord() }, mood: null }
  t.ok(canDelete(held, 'about'))
  t.absent(canDelete(held, 'mood'), 'no mood held: nothing to delete')
  t.absent(canDelete(null, 'about'))
  t.absent(canDelete(held, 'theme'))
  t.ok(isNothingToDelete(Object.assign(new Error('nada para apagar'), { code: 'USAGE' })))
  t.absent(isNothingToDelete(Object.assign(new Error('nada para apagar'), { code: 'INTERNAL' })), 'only the USAGE answer')
  t.absent(isNothingToDelete(Object.assign(new Error('limite do diário atingido'), { code: 'USAGE' })))
  t.absent(isNothingToDelete(Object.assign(new Error('x'), { code: 'USAGE', uncertain: true })), 'an uncertain failure is not success')
  t.absent(isNothingToDelete(null))
  t.ok(/versões/.test(deleteAsk('about')) && /versões/.test(deleteAsk('mood')))
  t.ok(/Cópias que outras pessoas/.test(deleteAsk('about')) && /Cópias que outras pessoas/.test(deleteAsk('mood')), 'both confirms say copies may persist')
  t.is(deletedNote('about'), TEXTS.aboutDeleted)
  t.is(deletedNote('mood'), TEXTS.moodDeleted)
})

test('withoutExtra, draftAfterDelete and settledExtra', async (t) => {
  const { withoutExtra, draftAfterDelete, settledExtra, extraView, emptyAboutDraft } = await load()
  const held = { about: { seq: 3, record: aboutRecord({ theme: 'flor' }) }, mood: { seq: 5, record: { type: 'mood', emoji: '😊', text: 'bem', at: iso(NOW - H) } } }
  const noAbout = withoutExtra(held, 'about')
  t.is(noAbout.about, null)
  t.is(noAbout.mood.seq, 5)
  t.is(extraView(noAbout, NOW).theme, null, 'theme back to default with the about gone')
  t.is(withoutExtra(held, 'mood').about.seq, 3)
  t.alike(withoutExtra(held, 'x'), held, 'unknown kind drops nothing')
  t.alike(withoutExtra(null, 'about'), { about: null, mood: null })
  const d = { ...emptyAboutDraft(), about: 'x', theme: 'flor' }
  const m = { emoji: '😊', text: 'bem' }
  t.alike(draftAfterDelete('about', d, m), { about: emptyAboutDraft(), mood: m })
  t.alike(draftAfterDelete('mood', d, m), { about: d, mood: { emoji: '', text: '' } })
  // a check drops a kind only when the seeder's index is complete and names none
  t.is(settledExtra(held, { about: null, mood: null, complete: true }, ['about']).about, null)
  t.is(settledExtra(held, { about: null, mood: null, complete: true }, ['about']).mood.seq, 5, 'only the asked kind')
  t.is(settledExtra(held, { about: null, mood: null, complete: false }, ['about']).about.seq, 3, 'still indexing: not known')
  t.is(settledExtra(held, { about: 3, mood: null, complete: true }, ['about']).about.seq, 3, 'still live')
  t.is(settledExtra(held, { about: null, mood: null, complete: true }, []).about.seq, 3, 'nothing asked, nothing dropped')
})

test('the delete flow in the screens: one action per kind, a confirm, never resent', (t) => {
  const perfil = read('screens/Perfil.js')
  const editor = perfil.slice(perfil.indexOf('function ProfileExtraEditor'), perfil.indexOf('export default function Perfil'))
  t.ok(editor.includes("'profile.extra.delete'"))
  t.ok(editor.includes('TEXTS.aboutDelete') && editor.includes('TEXTS.moodDelete'))
  t.absent(editor.includes('moodClear') || editor.includes('clearMood'), 'one mood action: Tirar humor is gone')
  t.ok(editor.includes('isNothingToDelete(err)'), 'nada para apagar is success')
  t.ok(editor.includes('deleteAsk(kind)') && editor.includes('setConfirm(kind)'), 'a confirm before the call')
  t.ok(editor.includes('extra.check([kind])') && editor.includes('setDeleteCheck(kind)'), 'uncertain: Conferir')
  t.ok(editor.includes('extra.drop(kind)') && editor.includes('onDeleted(kind)'), 'held state updated like a save')
  t.absent(/profile\.extra\.delete'[^\n]*\.catch/.test(editor), 'no automatic resend')
  t.ok(read('screens/Diario.js').includes('onExtraDeleted={(kind) => rich.drop(kind)}'), 'the own profile drops the record')
  t.ok(editor.includes('request: node.request, own: true })'), 'the editor and its Conferir read the own diary, not a seeder pointer')
  const card = read('ui/AboutCard.js')
  t.ok(card.includes("request('log.read', ownLogParams("), 'own reads go through log.read')
  t.ok(card.includes("(own && next !== 'ready')"), 'a walk that stopped short confirms nothing')
  t.ok(card.includes('return extraStatus(res.value, got)'), 'a named record that did not verify is not ready')
})

test('the screens: hosted-gated entry points, themed band only on a theme', async (t) => {
  const { TEXTS } = await load()
  const perfil = read('screens/Perfil.js')
  t.ok(TEXTS.aboutHint === 'A bio aparece logo abaixo do seu nome. O Sobre mim é o texto mais longo, com os detalhes: abre pelo link Sobre mim, no seu perfil.' && /<SectionHeader flush>\{TEXTS.aboutTitle\}<\/SectionHeader>\s*<Soft>\{TEXTS.aboutHint\}<\/Soft>/.test(perfil.slice(perfil.indexOf('function ProfileExtraEditor'), perfil.indexOf('export default function Perfil'))), 'the bio and Sobre mim hint sits directly below the editor section title')
  t.ok(perfil.includes('const hosted = node.hosted === true'), 'editor gated on node.hosted')
  t.ok(perfil.includes('if (!hosted || key === null) return null'))
  t.absent(/Platform\.OS[^\n]*(hosted|profile\.about|profile\.mood)/.test(perfil))
  t.ok(perfil.includes("'profile.about'") && perfil.includes("'profile.mood'"))
  t.absent(/node\.request\([^)]*\)\s*\.catch|retry/i.test(perfil.slice(perfil.indexOf('function ProfileExtraEditor'), perfil.indexOf('export default function Perfil'))), 'no automatic resend')
  const band = read('ui/ProfileBand.js')
  t.ok(band.includes('<SunsetBand height={height}>{children}</SunsetBand>'), 'no theme: the sunset band')
  const membro = read('screens/Membro.js')
  t.ok(membro.includes('enabled: node.hosted === true && !isPage && !blockedHere'), 'Membro reads nothing off a hosted node, for a page or a blocked person')
  const diario = read('screens/Diario.js')
  t.ok(diario.includes('<SorteCard ownerKey={topOwner} />'), 'Sorte on the own Diario')
  t.absent(membro.includes('SorteCard'), 'Sorte is not on another person\'s profile')
  for (const file of ['screens/Perfil.js', 'screens/Membro.js', 'screens/Diario.js', 'ui/AboutCard.js', 'ui/MoodChip.js', 'ui/ThemePicker.js', 'ui/SorteCard.js', 'ui/ProfileBand.js', 'profileExtraView.js']) {
    const src = read(file)
    if (!/Membro|Diario/.test(file)) t.absent(/mural/i.test(src), file + ': the profile area is never called mural')
    t.absent(src.includes('\u2014'), file + ': no em dash')
  }
})
