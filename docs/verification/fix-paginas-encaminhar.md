# Sobras de Páginas: Encaminhar como Página e "Carregar mais" (branch fix/paginas-encaminhar)

Parte da #352, dois itens: "Encaminhar não aparece agindo como Página" (decisão de Rodrigo em 16/11/2026: habilitar, por `dm.pageSend`) e "A folha de encaminhar lista no máximo 4 páginas". Só o app muda (`apps/app`). Não muda formato, RPC nem Termos.

- **Encaminhar como Página.** `Mensagem.js` mostra "Encaminhar" também agindo como Página e passa à folha o cliente de Conversas da Página (`pageDmClient`, `apps/app/src/dm-screen.js`). A folha (`apps/app/src/ui/ForwardSheet.js`) lista só as conversas da Página, sem grupos (`loadForwardDestinations(request, { groups: false })`), e cada envio é um `dm.pageDraft` com `fwd: 1` e um `dm.pageSend`. Um rascunho de Página não leva mídia (`docs/rpc.md` 5.114): `pageForwardSource` (`apps/app/src/forward.js`) manda só o texto, a folha diz "Como página, só o texto é encaminhado: fotos e áudios ficam de fora." quando havia foto ou áudio, e uma mensagem sem texto não oferece "Encaminhar" como Página.
- **Nada reenvia sozinho, e nada é assinado duas vezes.** Um envio incerto como Página guarda só o reenvio do mesmo rascunho assinado que o cliente da Página devolve (`err.retry`), e "Tentar de novo" chama só esse reenvio, uma vez (`retryPageForward`). Ele nunca passa por `retryForward`, que faria um rascunho novo e uma segunda assinatura.
- **"Carregar mais".** `loadForwardDestinations` devolve o cursor do `dm.list` (`more`) depois das 4 primeiras páginas, e `loadMoreForwardDestinations` lê as 4 seguintes a partir dele, sem repetir uma conversa já listada e mantendo os grupos. A folha mostra "Carregar mais" enquanto há cursor e antes do envio. Uma leitura que falha mostra o erro e mantém a lista. Uma resposta de uma leitura ou abertura antiga é descartada.

Como verificar, a partir da raiz:

- `node apps/app/test/forwardSheet.test.js`: "page forward: an uncertain send re-puts the same signed draft on a tap, never drafts or signs again" usa o `pageDmClient` de verdade: o reenvio repete o mesmo `dm.pageSend`, sem novo `dm.pageDraft` nem nova assinatura. "destinations load: more goes on from the cursor..." falha sem a exclusão das conversas já listadas. "ForwardSheet as a page..." falha no `Mensagem.js` da `origin/main` (Encaminhar só como pessoa).
- `node apps/app/test/dm.test.js` e `node apps/app/test/forward.test.js`.
- `npm run lint`, `npm test -- --affected=origin/main` e `npm run demo`.

Caminhada no aparelho (Android primeiro, depois iOS, depois web), ainda não feita:

- [ ] Agindo como Página, numa conversa dela, manter pressionada uma mensagem com texto: "Encaminhar" aparece; a folha lista só as conversas da Página; encaminhar para uma delas: a mensagem chega como da Página, com "Encaminhada".
- [ ] Mensagem com foto e legenda, como Página: a folha avisa que fotos e áudios ficam de fora; chega só a legenda.
- [ ] Mensagem só com foto, como Página: "Encaminhar" não aparece.
- [ ] Como pessoa, com mais de 4 páginas de conversas: "Carregar mais" aparece no fim da lista e traz as conversas seguintes, sem repetir nenhuma.

Limites:

- Uma Página ainda não encaminha mídia: `dm.pageDraft` não tem `media`. Mudar isso é mudança de RPC e de formato, fora desta issue.
- Encaminhar como Página não vai para grupos nem comunidades: só para as conversas da Página.
