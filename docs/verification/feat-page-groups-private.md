# Página em grupos privados (branch feat/page-groups-private)

## O que mudou

- Serviço de conta, `apps/cli/lib/account/pages-routes.js`, `pages-groups.js` e `pages-writer.js`: a ação `media` da Página aceita o envio de uma mídia cifrada para um grupo privado (op exatamente `{ group, sha256, mime: 'application/octet-stream', bytes }`, sem tipo, tamanho de imagem nem duração). Antes de guardar, o serviço confere, sob a trava da página, que o grupo é privado, que a Página escreve nele com um escritor contado e que a caixa confere (`privado`, `sem-permissao`, `aguardando-chave`, `limite`, `indisponivel`). O descritor guardado vale só para `group-seal` (`p.sealed`, gravado e relido no reinício) e nunca para uma publicação pública.
- Nó, `packages/web-member/lib/session.js` e `member-ops.js`: `pageSealMedia` cifra uma foto, GIF, mensagem de voz ou miniatura de cartão com a chave da página, que nunca sai do nó, e devolve o texto cifrado e o item privado; `group.seal` passa a selar `media`, `card`, `react` e `hide` além do texto.
- RPC, `packages/rpc/lib/methods.js`: `group.seal` com `media`, `card`, `react` e `hide`; `media.sealPageFile`, só no IPC do worklet (o arquivo sai e volta por arquivo, nunca pelo canal de 64 KiB).
- Ligação: `packages/web-member/lib/node.js` e `web/node.js` (`media.sealPage`), `apps/app/worklet/web-node.js` e `web-node-parts.js` (`sealPageMedia`), `apps/app/src/client/webnode.native.js` e `browser.js`, `apps/app/src/node.js`, `apps/app/src/vitrine/request.js`.
- App, `apps/app/src/pageGroupMedia.js` (novo, sem React) e `screens/Grupo.js`: agindo como a Página num grupo privado, fotos, GIFs, mensagem de voz (sem os metadados, por `pageVoice.js`) e cartão de link são selados pelo nó, enviados um a um ao serviço e só depois a publicação é selada e enviada uma vez como `group-seal`. Um envio de mídia que falha para antes do selo. Reagir e esconder a própria mensagem também vão por `group.seal`. Resposta e Encaminhar para as Conversas da página passam a valer no grupo privado. Fóruns, enquetes e eventos continuam fora.
- Documentos: `docs/rpc.md` (5.84 e 5.114), `docs/protocol.md` (seção 12), `docs/app.md` (Grupo e Páginas).
- Legal, `apps/app/src/legal.js`, `packages/core/lib/terms.js` e o site: Termos e Política versão 89, com novo aceite.

## Como verificar

Testes automáticos, a partir da raiz, cada arquivo sozinho:

```sh
node apps/cli/test/pages-groups-private.test.js
node apps/cli/test/pages-groups-parity.test.js
node apps/cli/test/account-pages-groups.test.js
node apps/cli/test/pages-writer.test.js
node packages/web-member/test/page-groups.test.js
node packages/web-member/test/node-bundle.test.js
node packages/rpc/test/methods.test.js
node packages/core/test/terms.test.js
node apps/app/test/pageGroupMedia.test.js
node apps/app/test/sealPageFile.test.js
node apps/app/test/webnodeHandle.test.js
node apps/app/test/vitrine.test.js
node apps/app/test/groupScreen.test.js
node apps/app/test/heldBubble.test.js
node apps/app/test/group-flow.test.js
node apps/app/test/groupReactions.test.js
node apps/app/test/groups.test.js
node apps/app/test/pageVoice.test.js
node apps/app/test/platformGate.test.js
node apps/app/test/legal.test.js
node apps/site/test/legal.test.js
```

## Conferir no app (pessoas)

Ordem: Android (build de debug), simulador iOS, depois web e PWA. Precisa de uma Página que entrou num grupo privado e de um aparelho administrador com a chave da página.

- [ ] Agindo como a Página no grupo privado: mandar texto, uma foto, duas fotos, um GIF, uma mensagem de voz e um link com prévia; responder uma mensagem. Tudo aparece com o nome da Página para outro membro, e as fotos e a voz abrem nele. Pendente.
- [ ] Reagir como a Página e tirar a reação; esconder e mostrar de novo uma mensagem da própria Página. Numa mensagem de outra pessoa não aparece "Esconder". Pendente.
- [ ] Encaminhar uma mensagem do grupo para as Conversas da página. Pendente.
- [ ] Sem rede no meio de um envio com foto: a mensagem fica na caixa e nada é publicado; "Tentar de novo" só reenvia no toque. Pendente.
- [ ] Publicar como a Página de dois aparelhos ao mesmo tempo: um mostra "Alguém publicou antes" e o toque sela de novo sem enviar as fotos outra vez. Pendente.
- [ ] O grupo privado, agindo como a Página, não mostra Tópicos, enquete nem evento. Pendente.
- [ ] Como pessoa, o grupo privado continua como antes. Pendente.

## Não verificado / limites conhecidos

- As telas têm testes de texto do código e testes de funções puras, sem teste de renderização; nada foi rodado em aparelho.
- O serviço confere o grupo e o escritor da Página antes de guardar a mídia, e não de novo depois: entre a conferência e a gravação, uma saída do grupo ou uma troca de chave ainda deixa guardar aquele envio. O que fica guardado são só bytes cifrados, dentro do limite do núcleo de mídia da Página.
- A mudança de chave da Página não confere nem leva os descritores selados (`p.sealed`): uma mídia enviada e não publicada antes da mudança não vale na chave nova.
- Encaminhar para dentro de um grupo como a Página não existe no app (a folha de Encaminhar da Página não lista grupos); o campo `fwd` de `group.seal` é aceito, mas o app não o usa.
- Não volte o serviço de conta para uma versão anterior a este PR: o `validNonces` de um binário antigo recusa o descritor selado guardado no registro de um nonce, então o estado da Página é lido como perdido e ela fica pausada até o próximo `remember`.
- Esconder só a própria mensagem é garantido no aparelho: o serviço não vê dentro do envelope selado, e quem decide se um `hide` vale são as leituras (folds) dos aparelhos dos membros.
