# Página em comunidades e grupos públicos (branch feat/page-groups-public)

## O que mudou

- `apps/cli/lib/account/pages-groups.js`, `pages-routes.js`: num grupo público, `group-post` leva foto, GIF, mensagem de voz, cartão de link, `replyTo`, tópico com enquete ou evento (gravados juntos, num só acréscimo); novas ações `group-react`, `group-hide` (só as mensagens da própria Página) e `group-choice` (voto e presença), e as leituras `group-read` com `topic`, `group-topics`, `group-voters` e `group-events`, com `mine` da Página e os mesmos limites do nó. Grupo privado responde `privado` nas leituras novas. As três ações idempotentes respondem `expirado` a um pedido assinado antes de o serviço reiniciar. Um esconder que não muda nada não grava nada; um esconder de mensagem ainda visível sempre grava.
- `apps/cli/lib/account/pages-writer.js`: o envio de mídia da Página aceita mensagem de voz (`audio/mp4`, o app tira os metadados antes, dentro de `MAX_AUDIO_MS` e `MAX_AUDIO_BYTES`), só para grupos.
- `packages/core/lib/page-proof.js`, `packages/rpc/lib/methods.js`, `apps/app/src/pages.js`: as ações novas nas listas fixas.
- `apps/app/src/groups.js`, `screens/Grupo.js`, `screens/Topico.js`, `screens/Eventos.js`, `screens/Comunidade.js`, `ui/EventCard.js`, `pageVote.js` e `pageVoice.js` (novos): o grupo, o tópico, o evento e a agenda agem e leem como a Página pelo serviço; uma resposta que chega depois de trocar de identidade é descartada; um resultado incerto mostra o reenvio, que manda os mesmos bytes assinados.
- `docs/protocol.md` (seção 12), `docs/rpc.md`, `docs/app.md`.
- `apps/app/src/legal.js`, `packages/core/lib/terms.js`: Termos e Política versão 87, com novo aceite.

## Como verificar

Testes automáticos, a partir da raiz, cada arquivo sozinho:

```sh
node apps/cli/test/pages-groups-parity.test.js
node apps/cli/test/account-pages-groups.test.js
node apps/cli/test/account-pages.test.js
node apps/cli/test/pages-writer.test.js
node packages/core/test/page-proof.test.js
node packages/rpc/test/methods.test.js
node apps/app/test/pageVote.test.js
node apps/app/test/pageVoice.test.js
node apps/app/test/pageChoice.test.js
node apps/app/test/groups.test.js
node apps/app/test/groupScreen.test.js
node apps/app/test/group-flow.test.js
node apps/app/test/groupReactions.test.js
node apps/app/test/heldBubble.test.js
node apps/app/test/forum.test.js
node apps/app/test/pages.test.js
node apps/app/test/legal.test.js
```

## Conferir no app (pessoas)

Ordem: Android (build de debug), simulador iOS, depois web e PWA. Precisa de uma Página que entrou num grupo público.

- [ ] Agindo como a Página num grupo público: mandar texto, foto, GIF, mensagem de voz e um link com prévia; responder uma mensagem. Tudo aparece com o nome da Página. Pendente.
- [ ] Reagir como a Página e tirar a reação; esconder e mostrar de novo uma mensagem da própria Página. Numa mensagem de outra pessoa não aparece "Esconder". Pendente.
- [ ] Criar um tópico com enquete e outro com evento; votar, trocar o voto e retirar; confirmar presença. O voto e a presença mostrados são os da Página, nunca os da pessoa. Pendente.
- [ ] Aba de tópicos e Agenda da comunidade agindo como a Página: listam os tópicos e eventos do grupo. Pendente.
- [ ] Trocar de Página para pessoa (ou para outra Página) com um envio em andamento: nada do envio antigo aparece na nova identidade. Pendente.
- [ ] Como pessoa, o grupo, os tópicos, a agenda e os eventos continuam como antes. Pendente.

## Não verificado / limites conhecidos

- As telas têm testes de texto do código e testes de funções puras, sem teste de renderização; nada foi rodado em aparelho.
- "Ver quem reagiu" fica fora para a Página: não há leitura do serviço para isso nesta etapa.
- Em grupo privado a Página continua só com texto; mídia, reações, tópicos e votos em grupo privado são a próxima etapa.
- Depois que a Página sai de um grupo e entra de novo, o direito de esconder uma mensagem escrita antes da saída só vale enquanto o serviço ainda guarda o escritor antigo.
