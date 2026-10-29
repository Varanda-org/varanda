'use strict'

const { refuseExisting, writeNew } = require('../write-new')
const { initAssociation, showAssociation, issueCertificate, issueSeederCertificate, issueIssuerCertificate, issueModeratorCertificate } = require('@varanda/core/lib/assoc')

function usage (message) {
  const err = new Error(message)
  err.code = 'USAGE'
  return err
}

function print (flags, result, line) {
  process.stdout.write((flags.json ? JSON.stringify(result) : line) + '\n')
}

function writePretty (file, value) {
  writeNew(file, JSON.stringify(value, null, 2) + '\n')
}

async function run (flags) {
  const sub = flags.positionals[0]
  const dir = flags.dataDir
  if (flags.out && sub && sub.startsWith('certify')) refuseExisting(flags.out)
  if (sub === 'init') {
    const { publicKey } = initAssociation(dir)
    print(flags, { publicKey }, 'chave pública da associação: ' + publicKey)
  } else if (sub === 'show') {
    const { publicKey } = showAssociation(dir)
    print(flags, { publicKey }, 'chave pública da associação: ' + publicKey)
  } else if (sub === 'certify') {
    if (!flags.member) throw usage('informe --member <hex>')
    const cert = issueCertificate(dir, {
      member: flags.member,
      ageBand: flags.ageBand || '18+',
      method: flags.method || 'stub'
    })
    if (flags.out) {
      writePretty(flags.out, cert)
      print(flags, { out: flags.out, cert }, 'certificado gravado em ' + flags.out)
    } else {
      process.stdout.write(JSON.stringify(cert) + '\n')
    }
  } else if (sub === 'certify-seeder') {
    if (!flags.seeder) throw usage('informe --seeder <hex>')
    const cert = issueSeederCertificate(dir, { seeder: flags.seeder })
    if (flags.out) {
      writePretty(flags.out, cert)
      print(flags, { out: flags.out, cert }, 'certificado do semeador gravado em ' + flags.out)
    } else {
      process.stdout.write(JSON.stringify(cert) + '\n')
    }
  } else if (sub === 'certify-issuer') {
    if (!flags.issuer) throw usage('informe --issuer <hex>')
    const cert = issueIssuerCertificate(dir, { issuer: flags.issuer })
    if (flags.out) {
      writePretty(flags.out, cert)
      print(flags, { out: flags.out, cert }, 'certificado do emissor gravado em ' + flags.out)
    } else {
      process.stdout.write(JSON.stringify(cert) + '\n')
    }
  } else if (sub === 'certify-moderator') {
    if (!flags.moderator) throw usage('informe --moderator <hex>')
    const cert = issueModeratorCertificate(dir, { moderator: flags.moderator })
    if (flags.out) {
      writePretty(flags.out, cert)
      print(flags, { out: flags.out, cert }, 'certificado da moderação gravado em ' + flags.out)
    } else {
      process.stdout.write(JSON.stringify(cert) + '\n')
    }
  } else {
    throw usage('node bin/varanda.js assoc init|show|certify|certify-seeder|certify-issuer|certify-moderator')
  }
}

module.exports = {
  commands: {
    assoc: { summary: 'chave da associação de teste e certificados de membro', run }
  }
}
