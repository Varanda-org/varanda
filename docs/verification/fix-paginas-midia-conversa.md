# Mídia nas conversas de uma Página (branch fix/paginas-midia-conversa)

Parte da issue #352, item "Cartão de anúncio numa conversa de Página sem miniatura" (o limite registrado em `docs/verification.md` §132). Agindo como uma Página, o cartão de um link numa conversa não mostrava miniatura, e as fotos e mensagens de voz que os membros mandam para a Página também não abriam. A causa: a leitura de mídia de DM do nó do navegador (`readMedia` em `packages/web-member/lib/dm.js`) só procurava a mensagem nas conversas da própria pessoa e só guardava no armazenamento dela.

## O que mudou

- `packages/web-member/lib/dm.js`: `readMedia(own, { from, id, index, page })`. Sem `page` (ou `null`), o caminho é o de antes. Com `page` (hex64 minúsculo, senão `TypeError('parâmetros inválidos')`), o contexto vem de `contextOf` (sem os segredos da Página: `'sem chave da página'`; trancado: `LOCKED`), a mensagem é procurada na dobra da Página (`keptMessage` recebe o contexto) e aberta com o contexto: o cache lê e grava no armazenamento da Página (`ctx.local`), e a chave da abertura em andamento e a marca de blob sumido levam o prefixo do contexto, para a mesma mensagem nunca se confundir entre a pessoa e a Página. As checagens de geração e bloqueio são as mesmas; uma Página esquecida enquanto o blob abria não entrega nada. Uma Página continua sem abrir nada em segundo plano; a linha da conversa da Página passa a dizer `{ unavailable: true }` depois que uma leitura explícita achou o blob sumido, e o `dm.changed` desse caso leva `page`.
- O cache da Página segue as regras do da pessoa: trancar mantém os itens selados; sair da conta (e o reset) apaga, com o da pessoa, o cache de cada Página guardada neste aparelho (`wipeMedia` chama `wipePageMedia` de `lib/node-store.js` para cada uma); `dm.pageForget` também apaga o cache da Página (`deletePageDm`), e as marcas de abertura em andamento e de blob sumido dela, para uma Página adotada de novo no mesmo desbloqueio começar limpa.
- `packages/web-member/lib/session.js` (`dmReadMedia`), `lib/node.js` e `web/node.js` (comentários) repassam `page`. O worklet (`apps/app/worklet/web-node-parts.js`, `readMediaToFile`) repassa `params.page` no `kind: 'dm'`, só quando vem.
- RPC: `media.readFile` aceita `page` (hex64) opcional, só com `kind: 'dm'` (`packages/rpc/lib/methods.js`); com `kind: 'group'` ou `'moment'` é `'parâmetro desconhecido'`. `docs/rpc.md` 5.89, a linha do `index: 'card'`, 5.88 (`media.readDm`), 5.78 (a linha sobre a mídia de uma Página), a seção das Páginas e o `dm.changed` foram atualizados.
- App: uma referência de mídia de DM pode levar `page`. `chatMediaKey` (`apps/app/src/media/chatMedia.js`) põe a Página na chave (`identidade|dm|página|from|id|index`), então um item da Página nunca responde pelo mesmo item lido como a pessoa; as chaves sem Página ficam iguais. As leituras (`sourceFor`, `bytesFor`), `client/browser.js` e `client/webnode.native.js` repassam `page`; `chatMediaRefs('dm', ...)` (`chatSend.js`) e `chatThumbRef` (`ui/LinkCard.js`) o carregam. Em `screens/Mensagem.js`, agindo como Página, as fotos e o `cardThumb` levam `page: pageKey` (antes o `cardThumb` era `undefined` para Página); a identidade continua `ownKey`, a da pessoa, dona do armazenamento da Página neste aparelho. A vitrine (`apps/app/src/vitrine/media.js`) não valida `page` e segue funcionando.

## Conferido por testes

Cada arquivo sozinho, com `node <arquivo>` a partir da raiz. "Sem a correção": o arquivo de produção voltou ao `origin/main` (`git show HEAD:<arquivo>`), o teste rodou, e o arquivo foi restaurado e o teste rodou de novo, passando.

| Teste | O que prova | Sem a correção |
|---|---|---|
| `packages/web-member/test/page-dm-media-e2e.test.js` (novo): "a photo and a card sent to a Página open as the Página, from its own store; never as the person" | semeador real com blobs, DHT local. Um membro manda uma foto e um link com cartão (miniatura JPEG) para a Página; a thread da Página lista os itens sem baixar nada; sem `page` a leitura é `'mídia indisponível'`; com `page` vêm os bytes exatos da foto e da miniatura; a segunda leitura sai do cache (nenhum GET a mais, com o blob já varrido do semeador); o índice do cache é o da Página, não o da pessoa; um blob sumido antes da leitura deixa a linha da Página `{ unavailable: true }` e emite `dm.changed` com `page`; Página sem segredos: `'sem chave da página'`; Página malformada: `TypeError`; trancado: `LOCKED`, e o cache da Página continua lá; depois de sair da conta (`clearKeyPair()` sem `keepMedia`), o índice e os itens do cache da Página somem | falha (`dm.js` e `session.js` do `origin/main`: a leitura com `page` dá `'mídia indisponível'`); só sem a chamada a `wipePageCaches` em `wipeMedia`: falha (28/31, as três asserções da saída) |
| `packages/rpc/test/methods.test.js`: "media.readFile" | `page` com `kind: 'dm'` passa (também com `index: 'card'`); `page` malformada, com `kind: 'group'` ou com `kind: 'moment'` é recusada | falha (159/160) |
| `apps/app/test/identityInstall.test.js`: "readMediaToFile opens a DM or group item through the session and writes it" | o worklet repassa `page` ao `dmReadMedia` | falha (48/49) |
| `apps/app/test/chatMedia.test.js`: "a Página's DM item keys apart from the same message read as the person and reaches the node with its page" | chave com a Página, diferente da pessoal; `page: null` é a pessoa; `page` malformada não tem chave; `sourceFor` e `bytesFor` repassam `page` | falha (55/56) |
| `apps/app/test/webnodeHandle.test.js`: "read names a read-dir file..." e "web: mediaOf gives the facade the same shape..." | o `media.readFile` nativo e o `readDm` da web levam `page` | falham os dois (12/14) |
| `apps/app/test/dm.test.js`: "chatMediaRefs names the DM sender..." e "acting as a Página, its photos and the card thumbnail are read from the Página's store" | `chatMediaRefs` põe `page` em cada ref; `Mensagem.js` passa `page: pageKey` às fotos e ao `cardThumb`, com a identidade da pessoa; `chatThumbRef` carrega `page` | falham os dois (60/62) |

Resultados com a correção: `page-dm-media-e2e.test.js` 1/1 (31 asserções, cerca de 35 s), `methods.test.js` 160/160, `identityInstall.test.js` 49/49, `chatMedia.test.js` 56/56, `webnodeHandle.test.js` 14/14, `apps/app/test/dm.test.js` 62/62. Também sozinhos, com a correção: `packages/web-member/test/page-dm.test.js` 20/20, `dm-summary.test.js` 12/12, `dm.test.js` 71/71, `dm-store.test.js` 44/44, `session-media.test.js` 15/15, `session.test.js` 66/66 e `dm-e2e.test.js` 5/5. `npm run lint` passa.

## No aparelho (não feito)

- [ ] Android (build de debug, e o APK de preview do EAS para a parte que exige conta): um membro manda para a Página uma foto, uma mensagem de voz e o link de um anúncio. Agindo como a Página, a foto abre, a voz toca e o cartão do anúncio mostra a miniatura. Agindo como a pessoa, nada muda nas conversas dela.
- [ ] iOS (simulador): o mesmo.
- [ ] Web e PWA: o mesmo.

## Limites

- A primeira leitura de um item da Página baixa o blob do semeador; se ele já foi varrido (retenção do semeador) antes de alguém abrir a conversa como a Página, o item fica indisponível, como numa conversa pessoal.
- O cache da Página fica no armazenamento da Página neste aparelho. Outro administrador da mesma Página baixa o blob de novo no aparelho dele.
