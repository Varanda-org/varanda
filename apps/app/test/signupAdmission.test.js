'use strict'

// Which offers the hosted welcome card shows while the network is full
// (src/signupAdmission.js). Pure module: Node loads it with import().
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/signupAdmission.js')

const ADMISSIONS = [undefined, null, { open: true }, { open: false }]

const labelOf = ({ hosted, admission, createFirst, phoneOk }) => {
  const admissionText = admission === undefined
    ? 'undefined'
    : admission === null
      ? 'null'
      : 'open:' + admission.open
  return 'hosted=' + hosted + ' admission=' + admissionText + ' createFirst=' + createFirst + ' phoneOk=' + phoneOk
}

// Same booleans the welcome card shows today, before any admission answer.
const today = (createFirst, phoneOk) => ({
  full: false,
  waiting: false,
  create: createFirst,
  phoneCreate: createFirst && phoneOk,
  phoneSignin: phoneOk && !createFirst
})

test('admissionOffer covers every hosted, admission, createFirst and phoneOk combination', async (t) => {
  const { admissionOffer } = await load()
  for (const hosted of [true, false]) {
    for (const admission of ADMISSIONS) {
      for (const createFirst of [true, false]) {
        for (const phoneOk of [true, false]) {
          const where = labelOf({ hosted, admission, createFirst, phoneOk })
          let expected
          if (hosted !== true) {
            expected = today(createFirst, phoneOk)
          } else {
            const closed = admission !== null && typeof admission === 'object' && admission.open === false
            const waiting = createFirst && admission === undefined
            const full = createFirst && closed
            const create = createFirst && !waiting && !closed
            expected = {
              full,
              waiting,
              create,
              phoneCreate: create && phoneOk,
              phoneSignin: phoneOk && !create
            }
          }
          const got = admissionOffer({ hosted, admission, createFirst, phoneOk })
          t.alike(got, expected, where)
          for (const key of ['full', 'waiting', 'create', 'phoneCreate', 'phoneSignin']) {
            t.is(typeof got[key], 'boolean', where + ' ' + key)
          }
        }
      }
    }
  }
})

test('creation stays off while hosted and the answer is pending or closed', async (t) => {
  const { admissionOffer } = await load()
  for (const admission of [undefined, { open: false }]) {
    for (const createFirst of [true, false]) {
      for (const phoneOk of [true, false]) {
        const got = admissionOffer({ hosted: true, admission, createFirst, phoneOk })
        t.is(got.create, false, labelOf({ hosted: true, admission, createFirst, phoneOk }))
      }
    }
  }
})

test('the phone button signs in whenever it exists and creation is off', async (t) => {
  const { admissionOffer } = await load()
  let saw = 0
  for (const hosted of [true, false]) {
    for (const admission of ADMISSIONS) {
      for (const createFirst of [true, false]) {
        for (const phoneOk of [true, false]) {
          const got = admissionOffer({ hosted, admission, createFirst, phoneOk })
          if (phoneOk === true && got.create === false) {
            saw += 1
            t.is(got.phoneSignin, true, labelOf({ hosted, admission, createFirst, phoneOk }))
          }
        }
      }
    }
  }
  t.ok(saw > 0, 'the matrix includes a case with the phone button and no creation')
})

test('a non-hosted card keeps today\'s booleans for every admission', async (t) => {
  const { admissionOffer } = await load()
  for (const admission of ADMISSIONS) {
    for (const createFirst of [true, false]) {
      for (const phoneOk of [true, false]) {
        t.alike(
          admissionOffer({ hosted: false, admission, createFirst, phoneOk }),
          today(createFirst, phoneOk),
          labelOf({ hosted: false, admission, createFirst, phoneOk })
        )
      }
    }
  }
})

test('admissionFor returns the answer only for the same installation', async (t) => {
  const { admissionFor } = await load()
  const origin = 'https://a.example'
  const other = 'https://b.example'
  const closed = { open: false }
  t.is(admissionFor(null, origin), undefined)
  t.is(admissionFor(undefined, origin), undefined)
  t.is(admissionFor({ origin, answer: null }, origin), null)
  t.is(admissionFor({ origin, answer: closed }, origin), closed)
  t.is(admissionFor({ origin, answer: closed }, other), undefined)
  t.is(admissionFor({ origin: other, answer: null }, origin), undefined)
  t.is(admissionFor('https://a.example', origin), undefined)
})

test('signupAdmission.js has no import, no require and no em dash', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'signupAdmission.js'), 'utf8')
  t.absent(src.includes('import '))
  t.absent(src.includes('require('))
  t.absent(src.includes('\u2014'))
})
