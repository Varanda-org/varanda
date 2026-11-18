# feat/app-paginas-no-core

Parte de #352 (PR 8 do plano). O app usa as Conversas das Páginas num nó core.

## O que mudou

- `apps/app/src/client/native.js`, `apps/app/src/config.js` (`coreAccountOrigin`): uma configuração de nó core passa ao worklet `accountOrigin`, o da configuração ou a instalação (`installationOrigin()`), só quando `core-dm.js` o aceitaria (https; http só em loopback; sem usuário, caminho, consulta ou fragmento). Um valor inválido deixa as Conversas desligadas em vez de impedir o nó de iniciar.
- `apps/app/worklet/main.js`: com o motor montado, `node.info` responde `accountOrigin` (como o `varanda-serve --account-origin`, docs/rpc.md 5.2), o que liga as Páginas no app, e o worklet responde `media.readFile` só para `kind: 'dm'` (`session.dmReadMedia` com as conferências e o diretório `media-read` do tipo web, `worklet/web-node-parts.js`); momento e grupo recusam com `mídia disponível só na versão web`. O diretório é limpo antes da primeira leitura e no fechamento, antes de o nó soltar o lock.
- `apps/app/src/client/connect.native.js`, `webnode.native.js` (`coreMediaHandle`), `src/node.js`: o nó core com motor ganha só `read`, `forgetReadFile` e `clearReadFiles`, entregues às linhas (NodeHandleContext). `node.media` continua nulo nesse nó, então nenhuma tela oferece envio.
- `apps/app/src/pages.js` `pagesDmCoreOnly` virou uma sondagem: um `dm.list` (sem escrita) por nó e endereço de conta. `mensagens diretas disponíveis só no navegador` quer dizer sem motor (`PAGE_DM_CORE_ONLY`, como antes); qualquer outra recusa USAGE quer dizer motor presente; outra falha é lançada e não guardada. `PaginaAjustes.js` (remover administrador, mover) e `pagesDmForget`/`pagesList` usam a sondagem.
- `apps/app/src/dmTextOnly.js` e `Mensagem.js`: num nó que não é hospedado e não tem `media.putDm`, o compositor não mostra prévia nem manda cartão de link; foto, vídeo e voz já ficavam escondidos sem `putDm`.
- Globais do Bare: o grafo de módulos de `core-dm.js` (calculado no Node com `require.cache`) é um subconjunto do que o tipo web já carrega no worklet, exceto o próprio `core-dm.js`, que usa só `URL` (global do Bare, já usado por `bare-fetch.js` e `seeder-url.js`). `coreDm` já instala `bare-crypto/global` e `bare-encoding/global` antes de carregar `core-dm`; nada foi acrescentado. Efeito colateral: `packages/core/lib/verified.js` passa a achar `crypto.subtle` no nó core com motor (a sondagem dele confere assinatura boa e ruim antes de usar).
- Suspensão: `session.suspend()` segura as chamadas `dm.*` e as operações do motor no armazenamento (`onChain`) até `resume()`; nenhuma correção foi preciso. Um `topUp` ou uma leitura de mídia já em andamento continua na rede, e as operações deles no armazenamento esperam a retomada.

## Testes

- `apps/app/test/config.test.js`: `coreAccountOrigin` (aceitos, recusados, configuração antes da instalação).
- `apps/app/test/workletGlobals.test.js`: globais antes de `core-dm` em `coreDm`; `core-dm` carrega sem `TextEncoder` depois de `bare-encoding/global`.
- `apps/app/test/pages.test.js`: nó core sem motor recusa com `PAGE_DM_CORE_ONLY` depois só da sondagem; nó core com motor gira a chave (falha sem a mudança: conferido revertendo `pagesDmCoreOnly`); sondagem com falha não vira resposta; `pagesDmForget` num nó core com e sem motor.
- `apps/app/test/dmTextOnly.test.js`: o portão, o texto igual ao de `core-dm.js`, o uso em `Mensagem.js`.
- `packages/web-member/test/core-dm-e2e.test.js`: suspensão segura chamada e operação do motor até `resume`.

## Pendente nos aparelhos (não rodado)

Android (build de debug) e simulador iOS primeiro, depois web. Configuração manual de nó core em Ajustes, Conexão, com a instalação padrão.

1. Abrir o app com a configuração de nó core: o nó inicia como antes (Início, sincronização). Ver em Ajustes que as Páginas aparecem.
2. Configuração de nó core sem instalação válida (endereço apagado): o nó inicia, as Páginas não aparecem, nenhum erro novo.
3. Como dono de uma Página com chaves no aparelho (ativada neste nó): Ajustes da Página, remover um administrador. Ver a remoção concluída, sem "Para remover administradores ou mudar a chave desta página, use o app no celular ou na web."; o administrador removido não lê mensagens novas.
4. Mover a Página: conclui, a Página nova abre as Conversas.
5. Nó core antigo (worklet sem motor, build anterior) ou `varanda-serve` sem `--account-origin`: remover administrador mostra o texto de `PAGE_DM_CORE_ONLY`, sem nova tentativa sozinha.
6. Como Página, abrir uma conversa que recebeu foto, voz e vídeo da web: os três abrem no aparelho; fechar e reabrir o app não deixa arquivo em `<documentos>/varanda/media-read`.
7. Como Página, no compositor: sem botão de anexo nem de voz; colar um link não mostra cartão e a mensagem sai só com o texto.
8. Como pessoa (não Página) num nó core: enviar mensagem mostra a recusa em pt-BR, sem travar a tela e sem reenvio.
9. Mandar o app para segundo plano com uma conversa abrindo e voltar: a conversa termina de carregar, sem erro de lock.
10. Web hospedada: as mesmas telas sem mudança (anexos, cartão, remover administrador).

### Rodada 2: telas num nó core (pendente, não rodado)

Mesma ordem: Android (build de debug), simulador iOS, depois web.

11. Nó core com as Conversas desativadas: abrir a aba Conversas. Ver a linha "Num nó core, as chaves destas Conversas ficam guardadas num arquivo neste aparelho, sem passkey: quem tiver a pasta de dados do nó consegue lê-las, e quem perder essa pasta perde estas Conversas." e o botão "Ativar Conversas". Tocar: a lista abre, sem tela de passkey. Tocar de novo depois de uma falha mostra o erro em pt-BR, sem nova tentativa sozinha.
12. Nó core com as Conversas ativas: a lista e as conversas abrem; sem o aviso de "desbloquear" da web.
13. Como Página: abrir uma conversa, responder com texto, ver a mensagem na web do outro lado. Foto e voz recebidas abrem (passo 6).
14. Como pessoa numa conversa pessoal: a conversa abre e lê; enviar texto ou reagir mostra a recusa em pt-BR, a tela não trava e nada é reenviado.
15. Como Página, abrir um grupo em que a Página participa: com o core de hoje, a tela fica como antes (indisponível neste nó). Com o core que responde `group.read` com `page` (PR 7): as publicações da Página aparecem, o compositor tem só texto, sem anexo, voz nem cartão.
16. Como Página, aba Avisos: a lista de avisos da Página carrega e atualiza ao puxar; sem nomes resolvidos, avatares nem trechos (ficam só no app hospedado). Como pessoa, os Avisos seguem "Avisos indisponíveis".
17. Web hospedada: Conversas, grupo como Página e Avisos sem mudança.
