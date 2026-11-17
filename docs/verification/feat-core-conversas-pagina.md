# feat/core-conversas-pagina

Parte de #352 (PR 5): Conversas no nó core, só texto, com o motor de mensagens do nó do navegador injetado na sessão do core. Termos e Privacidade versão 88, sobre a 84 (a fila: #756 com a 85, page-web-share com a 86, page-groups-public com a 87; renumerada na entrada se elas mudarem).

## O que mudou

- `packages/core/lib/store.js`: `readDmSeed` e `ensureDmSeed`. A semente fica em `<dataDir>/private/dm-seed.json`, `{ "v": 1, "seed": "<64 hex>" }`, arquivo `0600`, diretório `0700`, links simbólicos recusados, escrita num nome temporário e ligada ao nome final só se ele não existe (`linkNew`). Vazio, JSON inválido ou formato errado: erro `DM_SEED_INVALID`, sem nenhum byte do arquivo na mensagem, e o arquivo nunca é recriado. Lida uma vez por desbloqueio e zerada depois. Nenhum comando a imprime.
- `packages/core/lib/member.js`: `dmKeyEnsure`, `dmKeyStale`, `dmLookup` (a metade local), `newestDmKey`; `dmSigner` (o diário e o par do assinante do diário, nunca pelo RPC); `dmActorBox` (assinada pela chave de delegado da Página, com a caixa do próprio nó, gen 1).
- `packages/web-member/lib/core-dm.js` (novo): `createCoreDm({ dataDir, association, accountOrigin, createSocket, fetch, hkdf, ops, emit, log, limits })`. Armazenamento `fileNodeStorage(<dataDir>/private/dm)`. `dm.enable` cria a semente; os outros métodos sem ela respondem `Conversas ainda não ativadas neste aparelho`. A chave de quem não está aqui vem por uma ligação curta com o semeador (chave Noise efêmera, certificado do bloco 0 conferido, janelas do mais novo para o mais velho). Um autor bloqueado responde caixa `null` sem nenhuma leitura. Os métodos de Página agem como o delegado. `dm.pageDraft` recusa mídia e cartão antes de qualquer digest. Depois de cada `dm.pull`, sem segurá-lo, confere a chave publicada de cada Página guardada e emite `dm.pageKeyMismatch` (conferência simplificada). Semeador: `https` vira `wss://<host>/seeder`, `http` de loopback vira `ws`, qualquer outro é recusado.
- `packages/core/lib/session.js`: opção `dm` (a fábrica). Com ela: `dm.enable`, `dm.lookup`, `dm.pull`, `dm.list`, `dm.thread`, `dm.seen`, `dm.pageGenerate`, `dm.pageShare`, `dm.pageSecrets`, `dm.pageDraft`, `dm.pageSend`, `dm.pageLegacyChunk`, `dm.pageLegacyBlocks`, `dm.pageForget` e `dm.actorBox`. Continuam recusados no core: `dm.send`, `dm.react`, `dm.set`, `dm.reportSign`, `group.seal` e `group.read` com `page`. Sem a fábrica, toda recusa fica igual. Mídia recebida pelo `session.dmReadMedia` (para o `media.readFile` kind `'dm'` de um host; o worklet core ainda não o oferece).
- `packages/web-member/lib/dm.js` e `blob.js`: opção `stampDiary`, para o motor do core assinar a prova de carimbo v2 (assinante do diário).
- Hosts: `apps/cli/bin/varanda-serve.js` injeta a fábrica só com `--account-origin` (opção que já existia; aceita só https). `apps/app/worklet/main.js` só quando o argumento de início traz `accountOrigin` (o app ainda não passa: PR 8). `apps/cli/package.json` depende de `@varanda/web-member` 0.1.0, versão exata; depois de `npm install` ou `npm ci`, o build nativo precisa de `npm run prepare:native -w apps/app`.
- Termos e Privacidade 88 (`apps/app/src/legal.js`, `packages/core/lib/terms.js`, páginas do site refeitas com `node apps/site/scripts/render-legal.js`): uma frase no parágrafo do nó core das Páginas, nos Termos, e a mesma no parágrafo das Páginas da Privacidade.
- Docs: `docs/rpc.md` (Conversas 5.73 a 5.80, 5.89, 5.114, 5.161, eventos `dm.changed`, `dm.sending` e `dm.pageKeyMismatch`), `docs/protocol.md` (seção 11 "Key" e "Local storage", seção 12 "Nó core: delegado" e "Actor box"), `README.md` (semente, cópia de segurança, `--account-origin`), `docs/development.md`.

## Ordem de implantação

1. Web hospedada antes (o pacote web que já confere a `proof` da caixa declarada em `dm.pageGenerate` e `dm.pageShare`).
2. O semeador com a prova de carimbo v2 (#760) e o serviço de conta com a ação `actor-box` (#771), antes de um administrador core ser convidado para uma Página com Conversas. Sem a prova v2 o semeador não dá carimbos ao diário do core; sem `actor-box` o dono não acha a caixa do delegado.
3. Depois, o operador do nó core roda `varanda-serve --account-origin https://<host>` e faz cópia de segurança do diretório de dados.

## Testes

Cada arquivo rodou sozinho (`node <arquivo>`, Node 24.22.1):

- `packages/web-member/test/core-dm-e2e.test.js`: 9/9, 70 asserções. Uma sessão core com a fábrica, um semeador local (DHT presa a 127.0.0.1) e um motor do navegador: o dono ativa as Conversas da Página, o delegado core declara a caixa (`dm.actorBox`), o dono compartilha com a `proof`, o core adota, puxa, lista, abre uma foto recebida pelo `dmReadMedia` e responde como Página (texto). Também: a origem decide o transporte (http fora de loopback recusado), autor bloqueado sem rede, mídia recusada, sem semente nada desbloqueia, e uma sessão sem a fábrica recusa como antes. Na rodada de correções: um segundo motor no mesmo diretório é recusado até o primeiro fechar (trava do armazenamento); uma semente corrompida chega como USAGE em pt-BR, sem bytes nem caminho; `dm.send`, `dm.react`, `dm.set`, `dm.reportSign`, `group.seal` e `group.read` com `page` continuam recusados com a fábrica; a busca de um desconhecido pelo semeador real recusa um semeador de outra associação e um certificado de emissor revogado; uma rotação para gen 2 no semeador, com a réplica local ainda em gen 1, marca a Página (`dm.pageKeyMismatch`) e o envio é recusado. Na segunda rodada: uma busca incompleta (bloco de uma janela que falha, atualização que falha, prazo antes do fim) responde "sem conexão com o semeador", nunca uma chave mais antiga nem "sem chave", e o `dm.lookup` chega ao cliente como USAGE com essa mensagem; uma resposta desconhecida do semeador não marca a Página; um `blocklist.json` ilegível (um diretório no lugar) recusa o `dm.pull`; `close()` durante um `dm.enable` em andamento espera a chamada, só depois zera o par e fecha o armazenamento, sem recarga de selos, e uma chamada depois recusa; uma chamada `dm.*` enfileirada com a sessão suspensa recusa depois do `close` sem entrar no motor.
- `packages/core/test/dm-core-identity.test.js`: 12/12, 144 asserções (modos da semente, criação exclusiva, nunca recriada, links simbólicos, `dm-key` publicado e lido, `dmSigner`, `dmActorBox`; `dmLookup` responde null para réplica parcial com um `dm-key` antigo no começo, para emissor revogado e para réplica bifurcada).
- `packages/core/test/dm-session-refuse.test.js`: 2/2, 54 asserções, sem mudança no arquivo.
- Termos: `packages/core/test/terms.test.js` 8/8 (126), `apps/app/test/legal.test.js` 60/60 (1915, com o teste novo da versão 88 e o digest atualizado), `apps/site/test/legal.test.js` 7/7 (115), `apps/app/test/terms-version.test.js` 1/1 (2).
- `npx standard` nos arquivos tocados.

## Regressão

Sem a fábrica, o teste ponta a ponta falha logo no `dm.enable` com `RpcError: mensagens diretas disponíveis só no navegador`.

Rodada de correções, cada teste visto falhando sem a correção: os três casos novos de `dmLookup` (réplica parcial, emissor revogado, bifurcação); o segundo motor no mesmo diretório (sem a trava); a semente corrompida (sai INTERNAL); o certificado do semeador (a busca responde em vez de recusar); o emissor revogado na busca pelo semeador; e a rotação no semeador com réplica local atrasada (sem a consulta ao semeador primeiro, a Página não é marcada). Segunda rodada, também vistos falhando sem a correção (10 asserções em 4 testes): a busca incompleta (4 casos), a resposta desconhecida que não marca, o `dm.pull` com lista ilegível, o `close` que espera e a chamada enfileirada depois do `close`.

## Não coberto

- A declaração `actor-box` passando pelo serviço de conta, de ponta a ponta: no teste, a resposta de `dm.actorBox` vai direto para o dono. O lado do serviço foi testado em #771.
- O app não passa `accountOrigin` ao worklet (PR 8), então no aparelho nada muda; o worklet core também não oferece `media.readFile`.
- Fica para o PR 8: `session.dmReadMedia` não tem chamador nos hosts core (varanda-serve, worklet core), então `media.readFile` tipo `dm` só é alcançado nos testes.
- Fica para o PR 8: `argsOf` em `apps/app/src/client/native.js` nunca passa `accountOrigin`, então a fábrica fica inerte no app nativo.
- Fica para o PR 8: `session.suspend()` não pausa o motor das Conversas.
- Fica para o PR 8: conferir se `URL` é global no Bare (worklet core), usado por `seederUrlOf`.
- `varanda-serve --account-origin` contra um serviço de conta real, e a cópia de segurança e restauração do diretório de dados, não foram conferidos à mão.
