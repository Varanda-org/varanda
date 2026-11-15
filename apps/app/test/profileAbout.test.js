'use strict'

const test = require('brittle')
const rpc = require('@varanda/rpc')

const load = () => import('../src/profileAbout.js')
const NOW = Date.UTC(2026, 10, 15, 12)
const H = 60 * 60 * 1000
const iso = (ms) => new Date(ms).toISOString()

test('birthday shows as d de mes and rejects impossible dates', async (t) => {
  const { birthdayLabel } = await load()
  t.is(birthdayLabel('03-05'), '5 de março')
  t.is(birthdayLabel('01-01'), '1º de janeiro')
  t.is(birthdayLabel('11-01'), '1º de novembro')
  t.is(birthdayLabel('01-10'), '10 de janeiro')
  t.is(birthdayLabel('12-25'), '25 de dezembro')
  t.is(birthdayLabel('02-29'), '29 de fevereiro')
  for (const bad of ['02-30', '13-01', '00-10', '04-31', '3-5', '2000-03-05', null, 5, undefined]) {
    t.is(birthdayLabel(bad), null, String(bad))
  }
})

test('aboutView keeps filled fields in order and drops empty ones', async (t) => {
  const { aboutView } = await load()
  const v = aboutView({
    about: ' Oi, tudo bem? ',
    city: 'Recife',
    work: null,
    studies: '',
    interests: 'cinema',
    birthday: '07-09',
    theme: 'mar'
  })
  t.is(v.about, 'Oi, tudo bem?')
  t.alike(v.rows.map((r) => r.key), ['city', 'interests', 'birthday'])
  t.is(v.rows[2].value, '9 de julho')
  t.is(v.theme, 'mar')
  t.is(v.empty, false)
})

test('aboutView tolerates junk and unknown themes', async (t) => {
  const { aboutView } = await load()
  for (const junk of [null, undefined, 4, 'x', []]) {
    const v = aboutView(junk)
    t.is(v.empty, true)
    t.is(v.theme, 'varanda')
  }
  t.is(aboutView({ theme: 'neon', about: 7, city: {} }).empty, true)
  t.is(aboutView({ theme: 'neon' }).theme, 'varanda')
})

test('aboutView caps lengths and strips unsafe text', async (t) => {
  const { aboutView } = await load()
  const v = aboutView({ about: 'a'.repeat(900), city: 'b'.repeat(200), work: 'ok‮hidden' })
  t.is(v.about.length, 600)
  t.is(v.rows.find((r) => r.key === 'city').value.length, 60)
  t.absent(v.rows.find((r) => r.key === 'work').value.includes('‮'))
})

test('about and city are cut by code points, never inside a pair', async (t) => {
  const { aboutView } = await load()
  const v = aboutView({ about: 'a' + '😀'.repeat(599), city: '😀'.repeat(61) })
  t.is(Array.from(v.about).length, rpc.profileExtra.MAX_ABOUT)
  t.is(v.about, 'a' + '😀'.repeat(599))
  const city = v.rows.find((r) => r.key === 'city').value
  t.is(Array.from(city).length, rpc.profileExtra.MAX_CITY)
  t.is(city, '😀'.repeat(60))
  t.absent(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v.about + city))
  t.is(Array.from(aboutView({ about: 'a' + '😀'.repeat(700) }).about).length, 600)
})

test('mood is live for 24 hours only', async (t) => {
  const { moodView, MOOD_TTL_MS } = await load()
  const mood = (at) => ({ type: 'mood', emoji: '😀', text: 'feliz', at: iso(at) })
  t.is(moodView(mood(NOW - 1 * H), NOW).emoji, '😀')
  t.is(moodView(mood(NOW - 1 * H), NOW).text, 'feliz')
  t.ok(moodView(mood(NOW - MOOD_TTL_MS + 1), NOW))
  t.is(moodView(mood(NOW - MOOD_TTL_MS), NOW), null)
  t.is(moodView(mood(NOW - 30 * H), NOW), null)
  const v = moodView(mood(NOW - 1 * H), NOW)
  t.is(v.at, NOW - 1 * H)
  t.is(v.expiresAt, NOW - 1 * H + MOOD_TTL_MS)
})

test('mood at must be an ISO string: a number is rejected', async (t) => {
  const { moodView } = await load()
  t.is(moodView({ emoji: '😀', text: 'x', at: NOW - H }, NOW), null)
  t.is(moodView({ emoji: '😀', text: 'x', at: iso(NOW - H) }, NOW).emoji, '😀')
  t.is(moodView({ emoji: '😀', text: 'x', at: String(NOW - H) }, NOW), null)
})

test('mood may be an emoji, a text or both; empty or invalid shows nothing', async (t) => {
  const { moodView } = await load()
  const at = iso(NOW - H)
  const textOnly = moodView({ emoji: '', text: 'só texto', at }, NOW)
  t.is(textOnly.emoji, null)
  t.is(textOnly.text, 'só texto')
  t.is(moodView({ emoji: '😀', text: '', at }, NOW).text, null)
  t.is(moodView({ emoji: '', text: '', at }, NOW), null)
  t.is(moodView({ emoji: '', text: '  ', at }, NOW), null)
  t.is(moodView({ emoji: 'abc', text: '', at }, NOW), null)
  t.is(moodView({ emoji: 'abc', text: 'oi', at }, NOW).emoji, null)
  t.is(moodView({ emoji: '😀😀', text: '', at }, NOW), null)
  t.is(moodView({ emoji: 5, text: 'oi', at }, NOW).emoji, null)
})

test('mood never shows from a future at or bad input', async (t) => {
  const { moodView } = await load()
  t.is(moodView({ emoji: '😀', text: '', at: iso(NOW + 1) }, NOW), null)
  t.is(moodView({ emoji: '😀', text: '', at: iso(NOW + 1000 * H) }, NOW), null)
  t.is(moodView({ emoji: '😀', text: '', at: iso(NOW) }, NOW).text, null)
  t.is(moodView({ emoji: '😀', text: 'x', at: 'now' }, NOW), null)
  t.is(moodView({ emoji: '😀', text: 'x', at: NaN }, NOW), null)
  t.is(moodView({ emoji: '😀', text: 'x' }, NOW), null)
  t.is(moodView(null, NOW), null)
  t.is(moodView({ emoji: '😀', text: 'x', at: iso(NOW) }, NaN), null)
})
