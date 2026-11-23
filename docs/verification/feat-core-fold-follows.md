# Dobrar os seguidos de outros aparelhos no nó do core (#137)

Branch `feat/core-fold-follows`. Fecha o que faltava na #137: o `Member` do core só aplicava `followSet` ao gravar e nas páginas, sem dobrar o próprio diário.

## O que mudou

- `packages/core/lib/follows-fold.js`: `foldFollowsFile(dataDir, entries, ownHex, max)` aplica os registros `follow` do próprio diário a `follows.json` com as regras de `followSet` (último por chave, a própria chave ignorada, registros inválidos ignorados) e o limite `MAX_INVENTORY - 1`. Só escreve se o resultado muda.
- Um diário sem registro `follow` deixa `follows.json` como está. Uma chave sem registro (seguida antes de os registros existirem) continua na lista, e a dobra nunca grava um registro para ela: não republica nada sem confirmação.
- `member.js`: `followList`, `followAdd`/`followRemove` e `feedRead` dobram antes de ler a lista. `sync.js`: a dobra roda no início de cada execução, antes do portão de seguidos.
- `media.js`: `followRecordKeys`, as chaves que qualquer registro `follow` válido cita.
- `docs/protocol.md` descreve a regra na seção do `follows.json`.

## Como verificar

A partir da raiz:

- `node packages/core/test/member.test.js` (três testes novos: dois aparelhos seguindo e deixando de seguir, seguido antigo sem registro, registros repetidos e inválidos)
- `npm test -w packages/core`
- `npm run lint`
- `npm run demo`

Sem a correção, `member.test.js` passa 24 de 27 testes.

Caminhada, a fazer com a CLI e a web no mesmo diário:

- [ ] Seguir alguém na web, rodar `varanda sync` e `varanda follow list`: a pessoa aparece.
- [ ] `varanda follow add` na CLI, abrir a web depois do sync: a pessoa aparece lá.
- [ ] Deixar de seguir na web: depois do sync a CLI não a lista mais.

## Fora desta mudança

- Seguir de outro aparelho durante uma execução contínua de `sync` só vale na execução seguinte. Aplicar ao vivo exige mexer no conjunto de seguidos da execução.
- `varanda-serve` e o app com configuração manual usam o mesmo `sync`, então herdam a dobra do início da execução.
