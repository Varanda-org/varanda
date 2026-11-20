'use strict'

// Fails unless every native library (*.so) under the given directories can
// load on a device with 16 KB memory pages, which Google Play requires of
// 64-bit libraries (developer.android.com/guide/practices/page-sizes):
//   - every PT_LOAD lies within the file and has a power-of-two p_align >= 16384, and p_offset and p_vaddr agree
//     modulo p_align (otherwise the loader cannot map it at all);
//   - PT_LOADs do not overlap and p_memsz >= p_filesz;
//   - the 16 KB pages Bionic mprotects around PT_GNU_RELRO hold no writable
//     byte outside it, or that data would turn read-only after relocation.
// Anything it cannot read (not ELF, 32-bit, big-endian, truncated, no
// PT_LOAD) fails, and so does a directory with no library: a check that saw
// nothing proves nothing. Messages go to stderr, since prepare-native.sh
// runs the link check with stdout discarded.
//   node scripts/check-page-size.js <dir> [<dir>...]
const fs = require('node:fs')
const path = require('node:path')

const PAGE = 16384
const PT_LOAD = 1
const PT_GNU_RELRO = 0x6474e552
const PF_W = 2
const PHDR_SIZE = 56

const hex = (n) => '0x' + n.toString(16)

function checkElf (buf) {
  if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) return ['not an ELF file']
  if (buf[4] !== 2) return ['not 64-bit ELF (EI_CLASS ' + buf[4] + ')']
  if (buf[5] !== 1) return ['not little-endian ELF (EI_DATA ' + buf[5] + ')']
  const phoff = Number(buf.readBigUInt64LE(0x20))
  const phentsize = buf.readUInt16LE(0x36)
  const phnum = buf.readUInt16LE(0x38)
  if (phentsize !== PHDR_SIZE) return ['unexpected program header size ' + phentsize]
  if (phoff + phnum * PHDR_SIZE > buf.length) return ['truncated program headers']

  const phdrs = []
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * PHDR_SIZE
    phdrs.push({
      type: buf.readUInt32LE(o),
      flags: buf.readUInt32LE(o + 4),
      offset: buf.readBigUInt64LE(o + 8),
      vaddr: buf.readBigUInt64LE(o + 16),
      filesz: buf.readBigUInt64LE(o + 32),
      memsz: buf.readBigUInt64LE(o + 40),
      align: buf.readBigUInt64LE(o + 48)
    })
  }

  const loads = phdrs.filter((p) => p.type === PT_LOAD)
  if (loads.length === 0) return ['no PT_LOAD segment']
  const problems = []
  for (const p of loads) {
    if (p.memsz < p.filesz) {
      problems.push('PT_LOAD at ' + hex(p.vaddr) + ' has p_memsz ' + hex(p.memsz) + ' below p_filesz ' + hex(p.filesz))
    }
    if (p.offset + p.filesz > BigInt(buf.length)) {
      problems.push('PT_LOAD at ' + hex(p.vaddr) + ' extends past the end of the file')
    }
    if (p.align < BigInt(PAGE)) {
      problems.push('PT_LOAD at ' + hex(p.vaddr) + ' has p_align ' + hex(p.align) + ', needs >= ' + hex(PAGE))
    } else if ((p.align & (p.align - 1n)) !== 0n) {
      problems.push('PT_LOAD at ' + hex(p.vaddr) + ' has p_align ' + hex(p.align) + ', not a power of two')
    } else if (p.offset % p.align !== p.vaddr % p.align) {
      problems.push('PT_LOAD at ' + hex(p.vaddr) + ': p_offset ' + hex(p.offset) + ' and p_vaddr disagree modulo p_align ' + hex(p.align))
    }
  }

  const sorted = [...loads].sort((x, y) => (x.vaddr < y.vaddr ? -1 : x.vaddr > y.vaddr ? 1 : 0))
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].vaddr < sorted[i - 1].vaddr + sorted[i - 1].memsz) {
      problems.push('PT_LOAD at ' + hex(sorted[i].vaddr) + ' overlaps the PT_LOAD at ' + hex(sorted[i - 1].vaddr))
    }
  }

  // Bionic mprotects the whole pages around GNU_RELRO after relocation. On a
  // 16 KB device that range must not cover writable bytes outside RELRO.
  const P = BigInt(PAGE)
  for (const r of phdrs.filter((p) => p.type === PT_GNU_RELRO)) {
    const start = r.vaddr
    const end = r.vaddr + r.memsz
    const lo = start / P * P
    const hi = (end + P - 1n) / P * P
    if (!loads.some((p) => (p.flags & PF_W) && p.vaddr <= start && start < p.vaddr + p.memsz)) {
      problems.push('PT_GNU_RELRO at ' + hex(start) + ' is not inside a writable PT_LOAD')
    }
    for (const p of loads) {
      if (!(p.flags & PF_W)) continue
      const pend = p.vaddr + p.memsz
      const gaps = [[p.vaddr, start < pend ? start : pend], [end > p.vaddr ? end : p.vaddr, pend]]
      for (const [a, b] of gaps) {
        const from = a > lo ? a : lo
        const to = b < hi ? b : hi
        if (from < to) {
          problems.push('PT_GNU_RELRO ' + hex(start) + '-' + hex(end) + ' protects writable data at ' + hex(from) + '-' + hex(to) + ' outside it (16 KB pages ' + hex(lo) + '-' + hex(hi) + ')')
        }
      }
    }
  }
  return problems
}

function findLibraries (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findLibraries(full))
    else if (entry.name.endsWith('.so')) out.push(full)
  }
  return out.sort()
}

// Returns the failures as "<file>: <reason>" lines; empty means every library passed.
function checkDirs (dirs) {
  const failures = []
  if (dirs.length === 0) return ['no directory given']
  for (const dir of dirs) {
    let libs
    try {
      libs = findLibraries(dir)
    } catch (err) {
      failures.push(dir + ': cannot read (' + err.code + ')')
      continue
    }
    if (libs.length === 0) failures.push(dir + ': no .so file found')
    for (const lib of libs) {
      let problems
      try {
        problems = checkElf(fs.readFileSync(lib))
      } catch (err) {
        problems = ['cannot read (' + (err.code || err.message) + ')']
      }
      for (const p of problems) failures.push(lib + ': ' + p)
    }
  }
  return failures
}

module.exports = { checkElf, checkDirs, PAGE }

if (require.main === module) {
  const dirs = process.argv.slice(2)
  const failures = checkDirs(dirs)
  if (failures.length > 0) {
    for (const f of failures) console.error('check-page-size: FAIL: ' + f)
    process.exit(1)
  }
  console.log('check-page-size: ok, 16 KB pages in ' + dirs.join(' '))
}
