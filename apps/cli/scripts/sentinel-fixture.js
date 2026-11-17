#!/usr/bin/env node
'use strict'

// Dev-only: builds apps/app/src/sentinel/benchFixture.json, the token ids and
// reference embeddings the on-device Sentinela spike compares against, so it
// can check parity with the account service embedder without porting the
// tokenizer. Never run by npm test, npm run demo or CI. Never downloads
// anything: it needs the five files already fetched by
// scripts/fetch-ai-model.js into a directory OUTSIDE the repository.
//   node apps/cli/scripts/sentinel-fixture.js --model-dir /var/lib/varanda/ai-model
// The sha256 of every file is re-checked (createEmbedder does it) and the
// vectors come from the same code path the account service uses. The texts
// are fixed, neutral and carry no member content.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { configureEnv } = require('../lib/account/ai/embed-child')
const { createEmbedder, MODEL_ID, MODEL_REVISION, DIM, MAX_TOKENS, PIN } = require('../lib/account/ai/embedder')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const DEFAULT_OUT = path.join(REPO_ROOT, 'apps', 'app', 'src', 'sentinel', 'benchFixture.json')

const TEXTS = {
  t16: 'Fui à feira com minha irmã e compramos mangas.',
  t64: 'No sábado a gente se reuniu na praça do bairro para plantar mudas de ipê e de pitanga. As crianças trouxeram regadores pequenos e os vizinhos levaram café e bolo de milho. Foi uma manhã tranquila, com sol fraco e vento leve, e todos voltaram contentes.',
  t128: 'Neste fim de semana organizamos a limpeza da horta comunitária atrás da escola. Chegamos cedo, com luvas, enxadas e baldes. Primeiro arrancamos o mato alto ao redor dos canteiros, depois separamos as folhas secas para fazer adubo. O seu João ensinou a preparar a terra para plantar alface e coentro, e a dona Marta explicou como regar sem desperdiçar água. As crianças colocaram as plaquinhas em cada fileira. No fim da manhã dividimos um lanche simples e combinamos de voltar daqui a quinze dias.'
}

function usage (msg) {
  if (msg) console.error('erro: ' + msg)
  console.error('uso: node apps/cli/scripts/sentinel-fixture.js --model-dir <diretório fora do repositório> [--out <arquivo>]')
  process.exit(2)
}

function arg (argv, name) {
  const i = argv.indexOf(name)
  if (i === -1) return null
  if (!argv[i + 1] || argv[i + 1].startsWith('--')) usage('informe o valor de ' + name)
  return argv[i + 1]
}

// The real path of the nearest existing ancestor (symlinks resolved), plus
// the rest of the path: a symlink cannot smuggle the directory into the repo.
function realish (p) {
  let cur = p
  const rest = []
  while (!fs.existsSync(cur)) {
    rest.unshift(path.basename(cur))
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return path.join(fs.realpathSync(cur), ...rest)
}

function inside (child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

function round6 (v) {
  return Math.round(v * 1e6) / 1e6
}

async function main () {
  const argv = process.argv.slice(2)
  const modelArg = arg(argv, '--model-dir')
  if (!modelArg) usage('informe --model-dir')
  const modelDir = path.resolve(modelArg)
  const repo = fs.realpathSync(REPO_ROOT)
  if (inside(realish(modelDir), repo)) usage('o diretório do modelo não pode ficar dentro do repositório')
  const out = path.resolve(arg(argv, '--out') || DEFAULT_OUT)
  // The fixture only ever lives next to the bench: --out cannot overwrite
  // any other file.
  if (!inside(realish(out), realish(path.dirname(DEFAULT_OUT)))) usage('--out precisa ficar em ' + path.relative(REPO_ROOT, path.dirname(DEFAULT_OUT)))

  // Verifies the five sha256 before anything else (code 'sem-modelo').
  const embedder = await createEmbedder({ modelDir })
  try {
    // The tokenizer only (no model in this process), loaded local-only the
    // same way embed-child.js does, for the token ids.
    const hf = require('@huggingface/transformers')
    configureEnv(hf.env, modelDir)
    const tokenizer = await hf.AutoTokenizer.from_pretrained(MODEL_ID, { local_files_only: true })

    const cases = []
    for (const [name, text] of Object.entries(TEXTS)) {
      const ids = Array.from(tokenizer.encode(text), Number)
      const n = ids.length
      if (n > MAX_TOKENS) throw new Error('texto ' + name + ' passa de ' + MAX_TOKENS + ' tokens (' + n + ')')
      const res = await embedder.embed(text)
      if (res.truncated || !res.embedding || res.embedding.length !== DIM) throw new Error('embedding inválido para ' + name)
      cases.push({
        name,
        n,
        inputIds: ids,
        attentionMask: ids.map(() => 1),
        expected: res.embedding.map(round6)
      })
    }

    const doc = { model: { id: MODEL_ID, revision: MODEL_REVISION, sha256: PIN }, cases }
    fs.mkdirSync(path.dirname(out), { recursive: true })
    // realish() sees a dangling symlink as a missing file, so the check above
    // cannot catch one: refuse it here, and never follow one while writing.
    let link = false
    try { link = fs.lstatSync(out).isSymbolicLink() } catch {}
    if (link) throw new Error('--out não pode ser um link simbólico')
    const fd = fs.openSync(out, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644)
    try { fs.writeSync(fd, JSON.stringify(doc) + '\n') } finally { fs.closeSync(fd) }
    const digest = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex').slice(0, 12)
    console.log('ok ' + path.relative(REPO_ROOT, out) + ' (casos: ' + cases.map((c) => c.name + '=' + c.n).join(', ') + '; sha256 ' + digest + ')')
  } finally {
    await embedder.close()
  }
}

main().then(() => process.exit(0), (err) => {
  console.error('erro: ' + (err && err.code ? err.code : err && err.message ? err.message : 'falha'))
  process.exit(1)
})
