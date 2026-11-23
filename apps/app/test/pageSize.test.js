'use strict'

// scripts/check-page-size.js against synthetic ELF64 files written at test
// time (no binary fixture is committed).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('brittle')
const { checkElf, checkDirs } = require('../scripts/check-page-size')

const SCRIPT = path.join(__dirname, '../scripts/check-page-size.js')
const PT_LOAD = 1
const PT_GNU_RELRO = 0x6474e552
const R = 4
const RW = 6

// segs: { type, flags, offset, vaddr, memsz, align }
function elf (segs, { cls = 2, data = 1 } = {}) {
  // the file holds every PT_LOAD's bytes, as a real library does
  const end = Math.max(64 + segs.length * 56, ...segs.filter((s) => s.type === PT_LOAD).map((s) => (s.offset || 0) + (s.memsz || 0)))
  const buf = Buffer.alloc(end)
  buf.writeUInt32BE(0x7f454c46, 0)
  buf[4] = cls
  buf[5] = data
  buf[6] = 1
  buf.writeBigUInt64LE(64n, 0x20)
  buf.writeUInt16LE(56, 0x36)
  buf.writeUInt16LE(segs.length, 0x38)
  segs.forEach((s, i) => {
    const o = 64 + i * 56
    buf.writeUInt32LE(s.type, o)
    buf.writeUInt32LE(s.flags || R, o + 4)
    buf.writeBigUInt64LE(BigInt(s.offset || 0), o + 8)
    buf.writeBigUInt64LE(BigInt(s.vaddr || 0), o + 16)
    buf.writeBigUInt64LE(BigInt(s.filesz === undefined ? s.memsz || 0 : s.filesz), o + 32)
    buf.writeBigUInt64LE(BigInt(s.memsz || 0), o + 40)
    buf.writeBigUInt64LE(BigInt(s.align), o + 48)
  })
  return buf
}

const load = (vaddr, memsz, align, flags = R, offset = vaddr, filesz) => ({ type: PT_LOAD, flags, offset, vaddr, memsz, align, filesz })
const relro = (vaddr, memsz) => ({ type: PT_GNU_RELRO, flags: R, vaddr, memsz, align: 1 })
const good = () => elf([load(0, 0x8000, 0x4000), load(0xc000, 0x2000, 0x4000, RW)])
const bad4k = () => elf([load(0, 0x8000, 0x1000), load(0x9000, 0x2000, 0x1000, RW)])

function tree (t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-size-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const [name, buf] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), buf)
  }
  return dir
}

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

test('16 KB aligned library passes', (t) => {
  t.alike(checkElf(good()), [])
})

test('4 KB aligned library fails, naming the alignment', (t) => {
  const p = checkElf(bad4k())
  t.is(p.length, 2)
  t.ok(p[0].includes('p_align 0x1000'))
})

test('p_offset and p_vaddr must agree modulo p_align', (t) => {
  const p = checkElf(elf([load(0, 0x4000, 0x4000), load(0x8000, 0x1000, 0x4000, RW, 0x5000)]))
  t.is(p.length, 1)
  t.ok(p[0].includes('disagree modulo'))
})

test('p_align must be a power of two', (t) => {
  const p = checkElf(elf([load(0xc000, 0x1000, 0x6000, R, 0x6000)]))
  t.is(p.length, 1)
  t.ok(p[0].includes('not a power of two'))
})

test('a PT_LOAD whose bytes run past the end of the file fails', (t) => {
  const p = checkElf(good().subarray(0, 4096))
  t.is(p.length, 2)
  t.ok(p.every((l) => l.includes('extends past the end of the file')))
})

test('RELRO: misaligned end with writable data after it in the same LOAD fails', (t) => {
  const p = checkElf(elf([
    load(0, 0x4000, 0x4000),
    load(0x4000, 0x4000, 0x4000, RW),
    { type: PT_GNU_RELRO, flags: R, vaddr: 0x4000, memsz: 0x1000, align: 1 }
  ]))
  t.is(p.length, 1)
  t.ok(p[0].includes('PT_GNU_RELRO 0x4000-0x5000 protects writable data at 0x5000-0x8000'))
})

test('RELRO: filling the rest of its LOAD passes', (t) => {
  t.alike(checkElf(elf([
    load(0, 0x4000, 0x4000),
    load(0x4000, 0x1000, 0x4000, RW),
    { type: PT_GNU_RELRO, flags: R, vaddr: 0x4000, memsz: 0x1000, align: 1 },
    load(0x8000, 0x100, 0x4000, RW)
  ])), [])
})

test('RELRO: 16 KB aligned end before more data passes', (t) => {
  t.alike(checkElf(elf([
    load(0, 0x8000, 0x4000, RW),
    { type: PT_GNU_RELRO, flags: R, vaddr: 0, memsz: 0x4000, align: 1 }
  ])), [])
})

test('RELRO starting mid-LOAD at an unaligned address, writable bytes before it in the same page, fails', (t) => {
  const p = checkElf(elf([load(0, 0x4000, 0x4000), load(0x4000, 0x8000, 0x4000, RW), relro(0x5000, 0x3000)]))
  t.is(p.length, 1)
  t.ok(p[0].includes('protects writable data at 0x4000-0x5000'))
})

test('RELRO spanning into the next RW LOAD and ending unaligned fails', (t) => {
  const p = checkElf(elf([load(0, 0x4000, 0x4000), load(0x4000, 0x4000, 0x4000, RW), load(0x8000, 0x8000, 0x4000, RW), relro(0x4000, 0x5000)]))
  t.is(p.length, 1)
  t.ok(p[0].includes('protects writable data at 0x9000-0xc000'))
})

test('RELRO spanning two RW LOADs and ending on a 16 KB boundary passes', (t) => {
  t.alike(checkElf(elf([load(0, 0x4000, 0x4000), load(0x4000, 0x4000, 0x4000, RW), load(0x8000, 0x4000, 0x4000, RW), relro(0x4000, 0x8000)])), [])
})

test('a second RW LOAD starting in the page where RELRO ends fails', (t) => {
  const p = checkElf(elf([load(0, 0x4000, 0x4000), load(0x4000, 0x4000, 0x4000, RW), load(0x8000, 0x100, 0x4000, RW, 0x8000), relro(0x4000, 0x4000 - 0x2000)]))
  t.ok(p.length >= 1)
  t.ok(p.some((l) => l.includes('protects writable data at 0x6000-0x8000')))
})

test('RELRO ending mid-page next to a LOAD starting inside that page fails', (t) => {
  const p = checkElf(elf([load(0, 0x4000, 0x4000), load(0x4000, 0x1800, 0x4000, RW), load(0x6000, 0x100, 0x4000, RW, 0x6000), relro(0x4000, 0x1800)]))
  t.is(p.length, 1)
  t.ok(p[0].includes('protects writable data at 0x6000-0x6100'))
})

test('overlapping PT_LOAD segments fail', (t) => {
  const p = checkElf(elf([load(0, 0x8000, 0x4000), load(0x4000, 0x4000, 0x4000, RW)]))
  t.is(p.length, 1)
  t.ok(p[0].includes('overlaps'))
})

test('p_memsz below p_filesz fails', (t) => {
  const p = checkElf(elf([load(0, 0x4000, 0x4000, R, 0, 0x4001)]))
  t.ok(p.some((l) => l.includes('p_memsz 0x4000 below p_filesz 0x4001')))
})

test('an unexpected program header size fails', (t) => {
  const buf = good()
  buf.writeUInt16LE(32, 0x36)
  t.alike(checkElf(buf), ['unexpected program header size 32'])
})

test('RELRO outside any writable LOAD fails', (t) => {
  const p = checkElf(elf([load(0, 0x4000, 0x4000), { type: PT_GNU_RELRO, vaddr: 0, memsz: 0x1000, align: 1 }]))
  t.ok(p[0].includes('not inside a writable PT_LOAD'))
})

test('malformed files fail closed', (t) => {
  t.alike(checkElf(Buffer.from('not an elf, just text padding it out to sixty-four bytes and more')), ['not an ELF file'])
  t.ok(checkElf(elf([load(0, 0x4000, 0x4000)], { cls: 1 }))[0].includes('not 64-bit'))
  t.ok(checkElf(elf([load(0, 0x4000, 0x4000)], { data: 2 }))[0].includes('not little-endian'))
  t.alike(checkElf(elf([])), ['no PT_LOAD segment'])
  t.alike(checkElf(good().subarray(0, 100)), ['truncated program headers'])
  t.alike(checkElf(good().subarray(0, 20)), ['not an ELF file'])
})

test('empty tree and missing directory fail', (t) => {
  const dir = tree(t, { 'readme.txt': 'x' })
  t.ok(checkDirs([dir])[0].endsWith('no .so file found'))
  t.ok(checkDirs([path.join(dir, 'missing')])[0].includes('cannot read'))
  t.alike(checkDirs([]), ['no directory given'])
})

test('one good library among bad ones still fails, nested directories included', (t) => {
  const dir = tree(t, {
    'arm64-v8a/libsodium-native.5.2.0.so': good(),
    'arm64-v8a/libold.so': bad4k(),
    'x86_64/deep/libtrunc.so': good().subarray(0, 90)
  })
  const f = checkDirs([dir])
  t.is(f.length, 3)
  t.ok(f.every((l) => !l.includes('libsodium-native')), 'the good library is not reported')
  t.ok(f.some((l) => l.includes('libold.so')))
  t.ok(f.some((l) => l.includes('libtrunc.so')))
})

test('cli: exit 1 with the reason on stderr, exit 0 on a good tree', (t) => {
  const badDir = tree(t, { 'libbad.so': bad4k() })
  const r = run(badDir)
  t.is(r.status, 1)
  t.is(r.stdout, '')
  t.ok(/libbad\.so: PT_LOAD at 0x0 has p_align 0x1000/.test(r.stderr))

  const okDir = tree(t, { 'a/libgood.so': good(), 'b/libgood.so': good() })
  const ok = run(path.join(okDir, 'a'), path.join(okDir, 'b'))
  t.is(ok.status, 0)
  t.is(ok.stderr, '')

  t.is(run().status, 1, 'no argument fails')
})
