# fix/write-preempt-sync

Fecha #66: publicar durante a sincronização não emite mais `sync.stopped` `preempted`.

## O que mudou

- Escritas no próprio diário (`post.create`, `post.reply`, `post.quote`, `profile.set`, `like.set`, `repost.set`) rodam ao lado da sincronização nos dois nós. As outras escritas continuam pausando a sincronização.
- Nó core: `runSync` (`packages/core/lib/sync.js`) ganhou `lend`. Depois de abrir o store e o diário, empresta `{ hold, release, session }`; `hold()` falha quando a execução está terminando, e o store só fecha depois do último `release()`. A sessão (`packages/core/lib/session.js`, `withOwnWrite`) roda a escrita numa sessão do Corestore da execução (`ctx.store`, aceito por `member.openStore`). Sem empréstimo em 3 s (`writerWaitMs`), ou com a execução terminando, a escrita interrompe a execução como antes. Uma escrita que falhou no store emprestado nunca roda de novo.
- Nó do navegador: `openShared` já faz de cada abertura do diário e dos núcleos de mídia uma sessão da instância viva, então `withOwnWrite` (`packages/web-member/lib/session.js`) só não para a execução contínua (a trava de escrita ainda para uma execução `once`, como antes). A escrita marca o comprimento local assim que o bloco entra (`ctx.appending`, de `member-ops`), e um comprimento próprio novo que chega com um append em andamento conta como escrito neste aparelho (um eco remoto durante a validação de mídia ou um `like.set` sem mudança não conta): o Hypercore pode mandar o bloco ao semeador antes de `append()` terminar, e o eco chegava antes de `wrote()` (o teste `passkey-e2e` pegou isso).
- `docs/rpc.md` 6.1 e `docs/protocol.md` 9 descrevem a exceção.

## Testes

Core (`packages/core/test/session-sync.test.js`):

- `continuous sync: preempted by a request and restarted, then sync.stop`: o `post.create` não para a execução; o `feed.read` ainda para e reinicia.
- `a preempted once run ends ...`: preempção por `follow.list`.
- `regression: requests queued during a continuous run preempt it once`: 4 posts em fila não param nada; 4 leituras param uma vez.
- `own-diary writes during continuous runs reach a follower live (#66)`: A e B em sincronização contínua com um semeador; as seis escritas de A não param a execução de A, e a execução de B, sem reinício, baixa os 7 blocos.
- `suspend during an own-diary write waits for it, then stops the run (#66)`.

Navegador (`packages/web-member/test/`): `session.test.js` (preempção agora por `post.delete`; resposta e caminho rápido sem parada, o mesmo `runId` leva o bloco ao semeador), `lease.test.js` (preempção por `post.delete`), `session-upkeep.test.js` (o post local não inicia execução; índices das execuções ajustados; novo: um comprimento próprio novo relatado durante um `like.set` que não grava nada não é nomeado como local), `passkey-e2e.test.js` (a escrita contínua é nomeada como local uma vez, logo antes do eco, na mesma execução).

## Falha sem a correção

Com `withOwnWrite` trocado de volta por `withStore` no core, `session-sync.test.js` falha em `the write did not stop the run` e seguintes. No navegador, sem a guarda do append em andamento, `passkey-e2e.test.js` falha em `the live run names this session's write once` (168/170); com a guarda contando a escrita inteira em vez do append, `session-upkeep.test.js` falha em `and not named local`.

## Comandos

```sh
npx standard packages/core/lib/session.js packages/core/lib/sync.js packages/core/lib/member.js packages/web-member/lib/session.js packages/web-member/lib/member-ops.js
node packages/core/test/session-sync.test.js
node packages/web-member/test/session.test.js
node packages/web-member/test/session-upkeep.test.js
node packages/web-member/test/lease.test.js
node packages/web-member/test/passkey-e2e.test.js
npm run demo
```

## Limites

- Leituras no nó core (`feed.read`, `log.read`, `profile.read` e as outras) continuam interrompendo a sincronização; a pausa do cache de nomes (`apps/app/src/names.js`) continua valendo para elas.
- Sem conferência em aparelho (emulador Android ou simulador iOS): a mudança é no nó e está coberta pelos testes de sessão com rede local.
