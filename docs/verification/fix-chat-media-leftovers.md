# Sobras da mídia nas conversas, parte 1 (branch fix/chat-media-leftovers)

Primeira parte da #443: o que mora no semeador (`packages/core/lib/blob-pool.js`), no nó (`packages/core/lib/dm-net.js`), no arquivo de chaves de postagem da CLI e no serviço de conta. O que mora no app (fotos, cache de mídia aberta, EXIF, prévia de link encurtado no celular, Termos) fica na parte 2, que fecha a issue. Este PR não muda o app, então não houve conferência em aparelho.

Cada teste de regressão abaixo foi rodado contra o código anterior (a lib de `HEAD` no lugar da nova, ou só a correção removida) e falhou; depois, com a correção, passou.

## Do #366: pool de blobs do semeador

- [x] Quadro corrompido antes de um reinício vira confiável. Agora cada quadro aceito grava um registro de 74 bytes no diário `acks` do blob (índice, kid, hash da ficha, hash do quadro), depois do próprio quadro. Na abertura, o quadro precisa bater com o registro: kid, selo ou ficha alterados no disco quebram o blob. Teste "a stamp or token changed at rest before a restart is caught at load" (`packages/core/test/blob-pool.test.js`), que muda os bytes do kid (deslocamento 41), do selo (100) e da ficha (320); falha sem a correção.
- [x] Blob expirado fica legível por cerca de 60 s. `gone(blob, t)` vale em `info`, `read`, na varredura e no envio: um blob vencido não é lido nem recebe quadro antes da varredura, e um envio para ele varre primeiro e recomeça o blob do zero. Teste "a blob past its retention is neither read nor added to before the sweep runs"; falha sem a correção.
- [x] `meta.json` sem índices nem fichas. O diário `acks` guarda o que o `meta.json` não guardava. Um quadro confirmado que sumiu antes do reinício quebra o blob, e a ficha dele continua gasta. Teste "an acked chunk whose file is gone before a restart breaks its blob and its token stays spent"; falha sem a correção. Também: "a chunk written but not recorded is recorded at load, and a partial record is dropped" (a janela entre gravar o quadro e o registro), "a journal that is missing, out of range or contradictory breaks its blob" (com um registro fora do `count` cujo quadro sumiu: a ficha dele continua gasta) e "a blob of the earlier layout (meta.json v1, no journal) loads and takes chunks as before".
- [x] Falhas de disco no meio de um envio não deixam o blob quebrar no reinício nem um quadro fora da conta. Testes com falha injetada no `fsync`: "a record whose fsync fails is cut off with its chunk, so a restart keeps the blob", "when the cut fails too, the chunk stays next to its record and a restart or a retry keeps both" e "a chunk renamed into place whose directory fsync fails is removed, not left uncounted". Os três falham com o tratamento de erro anterior.
- [x] Reserva presa por quadro arquivado no lugar errado: já resolvido antes desta issue. O teste de reinício existente conta só os quadros válidos (`pool.bytes` igual a dois quadros); este PR só dá nome à asserção ("the misfiled frame holds no space").
- [x] Dois escritores no arquivo de chave de selo. Depois da própria gravação, `createPostageFile.get()` relê o arquivo e só guarda o carimbo em cache se o arquivo não mudou no meio; senão serve o que ficou no disco. Testes "dm-postage file: another writer that lands right after our write is what get() serves" e "dm-postage file: a write that lands while ours is read back is what the next get() serves" (`apps/cli/test/seed-ops.test.js`); os dois falham sem a correção.
- [x] Cliente que perdeu duas rotações falha envio a envio: já resolvido. `packages/web-member/lib/blob.js` (a checagem `stale`, perto da linha 366) descarta a chave velha, com o teste "a rotated kid adopted after a stale key check keeps no stamp under any other kid" em `packages/web-member/test/blob.test.js`.
- [x] Corrida em `dm-net.js`. Um pedido de mídia em andamento por conexão, não por canal (como no `blob-net`): reabrir o canal não zera mais a vez, um resultado atrasado nunca responde ao canal novo, e um resultado nulo fecha só o próprio canal. Testes "one put/page in flight per socket: a reopened channel waits, a late result never answers it" e "a put/page that throws after a reopen closes only its own channel" (`packages/core/test/dm-net.test.js`); o primeiro falha sem a correção (o teste estoura o tempo esperando).
- [x] Rever o cache HTTP privado de `fetchBlob`: já resolvido. Os GETs usam `cache: 'no-store'` (`packages/web-member/lib/blob.js`, linha 599), com teste em `packages/web-member/test/blob.test.js`.

Decisões deste PR, registradas aqui:

- Um quadro válido gravado sem registro (queda entre as duas gravações) é adotado na abertura e o diário é regravado de forma atômica, em vez de quebrar o blob.
- O selo não é verificado na abertura: as chaves de blob podem ainda não estar carregadas quando o pool abre. A abertura compara o quadro com o registro gravado quando o selo já tinha sido verificado.
- Atualização: o `meta.json` vai à versão 2. Um blob da versão 1 abre como antes. Voltar a uma versão anterior apaga os blobs da versão 2 (a versão anterior trata o `meta.json` novo como inválido), com as fichas ainda gastas.

## Do #367: serviço de conta

- [x] Não há teste do painel com o anexo. Teste de comportamento novo em `apps/cli/test/panel.test.js`, "a report anexo renders as an image or an audio control, and logout releases both": imagem com `alt`, áudio com `controls` e `preload="none"`, os dois textos de procedência, e o `src` sai na saída da sessão. Sem a liberação do `src` na saída, o teste falha.
- [x] `REQUEST_TIMEOUT_MS` de 10 s pode cortar um anexo de cerca de 1,4 MB. Agora é `HEADERS_TIMEOUT_MS` mais `ANEXO_READ_MAX_MS` (o prazo do corpo do anexo, `apps/cli/lib/account/mod-routes.js`), cerca de 17,3 s. Teste "report with anexo: a full-size body sent slowly but inside its deadline is read to the end" (`apps/cli/test/dm-report.test.js`, cerca de 11,4 s); falha com o valor antigo. `apps/cli/test/audius-server.test.js` passa a ler o valor exportado (cerca de 20 s). As outras rotas não ganham esse tempo: o corpo delas é cortado 10 s depois de começar a ser lido (`BODY_READ_MS`, o tempo de antes). Teste "a small report body sent slowly is cut at its own deadline, long before the anexo request timeout" (cerca de 10 s); sem o prazo, o corte só vem aos 18 s e o teste falha.
- [ ] `getMedia` transforma qualquer erro em nulo: parte 2.

## Do #376: GIFs

- [x] Não há teto de sessões vivas por membro. `MAX_MEMBER_SESSIONS = 8` em `apps/cli/lib/account/member-session.js`, para GIF, prévia de link e música: uma sessão nova encerra a mais antiga do mesmo membro. Teste "gif: a member holds at most MAX_MEMBER_SESSIONS live tokens, and a new one ends the oldest" (`apps/cli/test/gif-routes.test.js`), que também confere que outro membro mantém a sua; falha sem o teto. Decisão do mantenedor: 8 por membro.
- [x] Não há teste das 16 imagens em andamento. Teste "gif: at most 16 image fetches run at once, and one past that is refused before it is counted": 16 buscas presas no provedor falso, a 17ª responde 503 `indisponivel` sem chegar ao provedor e sem gastar a contagem diária. Falha com o teto em 17 e com a contagem cobrada antes do teto.
- [x] O laboratório hospedado não liga a busca de GIF. `apps/cli/scripts/gif-stub.js`: um provedor no padrão do Giphy num socket de loopback, com GIFs de 1x1 de uma cor, sem chave e sem rede externa, ligado pelo `hosted-lab.js` através das rotas de GIF de verdade. Testes em `apps/cli/test/gif-stub.test.js` (busca, imagens `tiny` e `full`, a resolução de nomes só do stub) e a asserção nova do laboratório rodando em `apps/cli/test/hosted-lab.test.js` (`/account/gif/policy` responde `{ enabled: true }`), que falha com o `hosted-lab.js` anterior.

## Do #388: prévia de link

- [x] Não devolver a contagem diária quando o nome é recusado. A devolução saiu: uma prévia de um nome que o serviço recusa termina na hora, sem buscar a capa, e conta como qualquer outra falha, então ninguém sonda nomes pelo resolvedor do serviço de graça. Testes "preview: 60 previews per member per day, and a refused address stays counted" e "preview: a refused YouTube address is counted with no fallback fetch" (`apps/cli/test/preview-routes.test.js`); os dois falham com o código anterior.
- [ ] Links encurtados no celular, rotação EXIF, `expo/fetch` com `redirect: 'manual'` num aparelho: parte 2.

## Fica para a parte 2

Fotos de grupo público na escrita (#368), o fetch do worklet no Bare e os arquivos decifrados depois de um force-quit no iOS (#369, decisão do mantenedor: aceitar como está), as notas de voz gravadas no Android e no Safari (#370 e #371), os itens do app do #388, o cache de mídia aberta (#392, decisão do mantenedor: manter entre bloqueios) e a limpeza do trecho de limites das seções 104 a 108, 111, 114 e 117 de `docs/verification.md`.

## Documentos

`docs/protocol.md`: a seção 13 (diário `acks`, `meta.json` versão 2, carga do diário, envio que falha no meio, blob vencido), o limite de um pedido por conexão das mensagens diretas, o tempo do pedido do anexo e o prazo do corpo das outras rotas, o teto de 8 sessões por membro e a contagem da prévia sem devolução.

## Revisão

Revisão por um agente Claude de outro modelo (Fable), um só fornecedor de IA. Os achados de prioridade 2 foram corrigidos neste PR: as duas falhas de disco no envio, o prazo do corpo das rotas pequenas e os testes dos caminhos de falha (pool e arquivo de selo). Também as fichas de registros ruins do diário.

## Comandos

Arquivos rodados sozinhos, com a correção:

```sh
node packages/core/test/blob-pool.test.js        # 33/33
node packages/core/test/dm-net.test.js           # 18/18
node apps/cli/test/seed-ops.test.js              # 14/14
node apps/cli/test/dm-report.test.js             # 16/16
node apps/cli/test/audius-server.test.js         # 11/11
node apps/cli/test/panel.test.js                 # 72/72
node apps/cli/test/gif-routes.test.js            # 27/27
node apps/cli/test/preview-routes.test.js        # 32/32
node apps/cli/test/gif-stub.test.js              # 2/2
node apps/cli/test/hosted-lab.test.js            # 11/11
```
