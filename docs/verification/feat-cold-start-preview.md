# feat/cold-start-preview

Abertura com a cópia de A Rua e da faixa de Momentos no Android e no iOS (`apps/app/App.js`, `ARuaPreview` em `apps/app/src/screens/ARua.js`, `previewAllowed` em `apps/app/src/splashGate.js`, `previewCapable` em `apps/app/src/feedSnapshotStore.native.js`).

## O que mudou

- `previewCapable` passa a `true` no store nativo de A Rua. O store da web continua `false`: `sessionStore.web.js` responde `hasLive` com `false`, então o navegador não prova uma sessão viva da dona da cópia antes de o nó responder.
- `previewAllowed` exige `momentsKnown`: uma cópia `momentos` da mesma pessoa dona da cópia de A Rua que passou na leitura (faixa vazia vale). Sem ela a abertura fica.
- App.js lê a cópia `momentos` com `previewBinding` e o dono da cópia de A Rua, como membro (`actingAs.get()`), antes da consulta ao chaveiro; sem a cópia não consulta o chaveiro nem guarda a prévia.
- `ARuaPreview` recebe `moments` e desenha a faixa como cabeçalho da lista, na mesma ordem do cabeçalho de A Rua (faixa, depois a nota de contagens). Os autores passam por `cachedRowsShown` a cada render (lista de bloqueios pendente: só o anel próprio). Os anéis ficam sob `pointerEvents='none'`, sem `onOpen`; os nomes vêm da própria cópia da faixa; os vistos vêm de `loadMomentSeen` e `onMomentSeen`, sem ligar o store ao nó.
- Continuam valendo: sessão viva exatamente para o dono, cópia com no máximo 24 horas, nenhuma etapa a seguir, não trancada, e a troca de dono, tranca ou saída que apaga as cópias por `wipeLocalCaches`.

## Testes locais

```sh
npx standard apps/app/App.js apps/app/src/screens/ARua.js apps/app/src/splashGate.js apps/app/src/feedSnapshotStore.native.js apps/app/test/splashGate.test.js apps/app/test/splashWiring.test.js apps/app/test/feedSnapshotStore.test.js apps/app/test/ruaSnapshot.test.js
node apps/app/test/splashGate.test.js         # 17 testes, 330 asserções
node apps/app/test/splashWiring.test.js       # 10 testes, 94 asserções
node apps/app/test/feedSnapshotStore.test.js  # 8 testes, 25 asserções
node apps/app/test/ruaSnapshot.test.js        # 46 testes, 372 asserções
node apps/app/test/splashGateSeeded.test.js   # 1 teste, 43 asserções
node apps/app/test/cachedRows.test.js         # 4 testes, 30 asserções
```

Também passaram, um arquivo por vez, os testes de `apps/app/test` que leem `App.js`, `splashGate.js` ou `ARua.js` (entre eles `snapshotSafety`, `feedPreviews`, `backgroundTask`, `momentosSnapshot`, `screenSnapshotStore`, `vitrineGuard` e `platformGate`). Regressão conferida: sem a exigência de `momentsKnown` em `previewAllowed`, `splashGate.test.js` falha em 3 asserções.

## Aparelhos (a conferir)

- Android (build de debug) e iOS (simulador), com sessão guardada e cópias de A Rua e de Momentos: ao fim da animação de abertura aparece A Rua com a faixa de Momentos em cima; quando a tela ao vivo assume, nem a faixa nem as linhas se mexem.
- Sem sessão guardada: a abertura espera o nó, sem prévia.
- Depois de sair da conta: as cópias foram apagadas, sem prévia.
- Depois de trancar a sessão: sem prévia; destrancar segue o fluxo normal.
- Web e PWA instalado: sem prévia, a abertura espera o nó e pinta as linhas guardadas de uma vez, como antes.

A suíte inteira roda no GitHub CI (Node 20 e 24).
