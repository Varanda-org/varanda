# feat/mute-members

Refs #45. Silenciar sem bloquear, e a lista de bloqueio aplicada à Feira.

## O que mudou

- `@varanda/rpc`: `mute.set` (altera estado) e `mute.list`, `MUTE_MAX` = 500.
- `packages/core/lib/member-mute.js`: as regras da lista de bloqueio (`member-block.js`, agora com teto opcional) com `MUTE_MAX`. O nó do core responde que silenciar só existe no navegador.
- `packages/core/lib/seen-blob.js`: versão 5, mesmo layout da 4. O byte `on` de uma entrada vale 0/1 para bloqueio e 2/3 para silêncio; as duas listas dividem `SYNC_BLOCKS_MAX` (128): os bloqueios primeiro, os mais novos, e os silêncios nas vagas que sobram, então silenciar nunca tira um bloqueio do bloco. A versão 4 continua sendo lida.
- `packages/web-member`: lista em `memberMutes` (kv), sincronizada pelo `seen.merge` (`mutesChanged`), apagada no Recomeçar. `feed.read` e `moments.read` deixam a pessoa silenciada de fora (como um bloqueio, sem mexer em seguir); `notices.list` tira os avisos dela. `diary.peek`, `peek.read`, conversas e grupos não mudam.
- App: `MutesProvider`, linha "Silenciar"/"Deixar de silenciar" no menu da publicação (entre Denunciar e Bloquear) e no perfil, tela Ajustes > Pessoas silenciadas com a explicação atrás do (i), A Rua (ao vivo, fotografia e prévia) e Avisos limpam as linhas na hora, e um comentário de outra pessoa numa publicação de quem você silenciou não vira cartão com essa publicação (`hiddenInFold`, como um bloqueio no `foldFeed`). Uma resposta incerta do `mute.set` relê a lista e recarrega A Rua. A Vitrine responde aos dois métodos e deixa a pessoa silenciada de fora de `feed.read`, `moments.read` e `notices.list`.
- Feira: a tela usa a lista de bloqueio do membro (`useBlocks`) no `blocked` que já existia e nunca era passado.
- Avisos push na web: a página informa a lista de silenciados ao service worker (`reportMutes` em `pushBlocks.web.js`), que a guarda em `/__varanda-mutes`, separada da de bloqueios; um aviso social de quem você silenciou aparece em silêncio e fecha, como o de quem você bloqueou. Mensagens diretas e grupos não dizem quem agiu e continuam aparecendo. No nativo, `reportMutes` não faz nada, como `reportBlocks`.
- Termos 111 (`apps/app/src/legal.js`, `TERMS_VERSION` no core): um parágrafo nos Termos sobre silenciar e uma frase na Política de Privacidade sobre o que o bloco de vistos e o navegador guardam dos silenciados. Páginas do site geradas de novo. `docs/app.md` ganha a seção "Silenciar uma pessoa" e `docs/design.md` cita os silenciados no bloco de vistos.

## Não feito

- Grupos e comunidades continuam sem filtro de bloqueio na tela. As linhas de um grupo guiam a posição de leitura, a contagem de não lidas e as âncoras de resposta; esconder uma mensagem ali (sumir ou mostrar um marcador) é decisão de produto.

## Testes

- `packages/rpc/test/methods.test.js`: `mute.*`.
- `packages/core/test/member-mute.test.js`, `packages/core/test/seen-blob.test.js` (silêncios ao lado de bloqueios, janela comum com os bloqueios primeiro, 200 silêncios novos não tiram um bloqueio, versão 4 ainda lida, `on` = 2 recusado na 4).
- `packages/web-member/test/member-mute.test.js`: lista, teto, a própria chave, reinício, bloqueado, Recomeçar, seguir mantido, `feed.read` e `notices.list` filtrados, `diary.peek` não.
- `packages/web-member/test/seen-sync.test.js`: um silêncio num aparelho chega ao outro.
- `apps/app/test/memberMutes.test.js`, `postActions.test.js`, `vitrine.test.js`, `composePolish.test.js`, `postLayout.test.js`.
- `apps/app/test/sw.test.js`: o aviso de quem você silenciou fica quieto numa lista própria, mensagens diretas continuam aparecendo, e a lista sobrevive ao reinício do worker. `apps/app/test/memberBlocks.test.js`: a lista de silenciados vai como mensagem própria na web, e o nativo não faz nada.
- `apps/app/test/legal.test.js` (versão 111, frases novas, digest), `apps/site/test/legal.test.js`, `packages/core/test/terms.test.js`.

## Caminhada (não executada)

- [ ] Android (debug) e simulador iOS: silenciar pelo menu de uma publicação em A Rua; as publicações e republicações da pessoa somem; o perfil dela ainda mostra tudo; Conversas com ela continua.
- [ ] Silenciar pelo perfil; o aviso de curtida dessa pessoa some de Avisos.
- [ ] Ajustes > Pessoas silenciadas lista a pessoa; Deixar de silenciar a traz de volta em A Rua.
- [ ] Segundo aparelho da mesma passkey: depois de uma passagem de vistos, a lista aparece lá.
- [ ] Feira: anúncio de quem você bloqueou não aparece.
- [ ] Web e PWA, depois do celular: com os avisos push ligados, uma curtida de quem você silenciou não mostra aviso; uma mensagem direta dessa pessoa mostra.
- [ ] O aceite dos Termos 111 aparece uma vez e mostra o parágrafo de silenciar.
