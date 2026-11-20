# feat/blocklist-cap-16384

Parte de #31. Cada exclusão de conta deixa a chave do diário na lista de bloqueio para sempre (certificados de membro não expiram), então o teto de 4096 chaves seria atingido com o tempo. Decisão da manutenção (2026-11-17): subir para 16384.

## O que mudou

- `packages/core/lib/blocklist.js`: `MAX_BLOCKED` 4096 -> 16384 e `MAX_SNAPSHOT_BYTES` 393216 -> 1179648. A maior lista válida (16384 chaves, 64 emissores revogados, datas com ano expandido, `seq = Number.MAX_SAFE_INTEGER`) tem 1102534 bytes. A relação com `MAX_INVENTORY` passa a ser `>=`.
- `packages/core/lib/blocklist-net.js`: `MAX_BLOCKLIST_MESSAGE` acompanha `MAX_SNAPSHOT_BYTES`.
- `apps/cli/lib/account/mod-routes.js`: `ACK_BODY_MAX` 524288 -> 1572864 (lista máxima mais 4096 ids de mudança e os campos assinados).
- `apps/cli/lib/mod-apply.js`: `PULL_BODY_CAP` 1048576 -> 1572864 (1000 mudanças mais a lista máxima).
- Prazos que crescem com os corpos maiores: a rota `/account/mod/api/ack` passa a ser lida como o anexo de uma denúncia (`apps/cli/lib/account/mod-routes.js`, leitura compartilhada `declaredLength` / `readLargeBody`): exige `Content-Length` (411 sem ele), responde 413 sem ler acima de `ACK_BODY_MAX`, corta um corpo parado por 5 s e dá 2 s mais o tamanho declarado a 1 Mbit/s (`largeBodyDeadlineMs`: cerca de 14,6 s para 1,5 MiB, antes 10 s fixos). Não há limite de leituras de `ack` ao mesmo tempo: um limite ocupado antes de conferir a assinatura deixaria qualquer pessoa segurar o `ack` do operador, então essas leituras contam só para o teto de 64 conexões do serviço. O `requestTimeout` do serviço passa a ser o tempo dos cabeçalhos mais o maior desses prazos (anexo ou ack, 18,6 s). No `mod apply`, `pull` e `ack` esperam até `TRANSFER_TIMEOUT_MS = 30000`; o desafio continua com 10 s.
- `packages/core/lib/mod-request.js`: `MAX_CHANGE_IDS` continua 4096. Ele limita os ids de um `ack`, não o tamanho da lista; o serviço entrega no máximo 1000 mudanças por `pull`.
- Sem mudança, conferidos: `apps/cli/lib/commands/mod.js` e `moderation-store.js` (`lotado`) leem `MAX_BLOCKED`; `readBlocklist`/`writeBlocklist` (core e web-member) não têm teto de tamanho; o nó do navegador recebe a lista pelo link do semeador, limitado por `MAX_EXTERNAL_FRAME` (8 MiB).
- `docs/protocol.md` seção 3 (com o parágrafo de compatibilidade), "Account deletion" e o mapa de módulos; `README.md` "Excluir conta" e os limites da moderação.

## Compatibilidade (decisão da manutenção, 2026-11-17: assinar até 16384 já)

- Até 4096 chaves: todas as versões leem a lista igual.
- De 4097 a 5796 chaves: a mensagem cabe no antigo teto de 393216 bytes (5796 é o pior caso: 64 emissores revogados, datas com ano expandido, `seq = Number.MAX_SAFE_INTEGER`; sem emissor revogado, com `seq = 1` e datas atuais, cabem 5861). Conferido com `createSnapshot` de verdade, medindo `JSON.stringify({ type: 'snapshot', snapshot })` para cada tamanho de lista. Um nó de versão anterior lê a lista como `'malformed'`, continua aplicando a última lista válida até ser atualizado e conclui a sincronização normalmente.
- Acima disso: um nó de versão anterior descarta a mensagem pelo tamanho, antes de ler, e conta uma mensagem inválida no canal `varanda/blocklist/1`. No nó do navegador de versão anterior (o app nativo, cujo worklet roda `packages/web-member`, e o PWA em cache), a meta G3 de `packages/web-member/lib/sync.js` (`blocklistSettled`) nunca se cumpre: todo Sincronizar termina em `tempo esgotado: blocklist`, e a sincronização contínua nunca informa que está pronta. Isso dura até o app ser atualizado. O nó do core de versão anterior não tem essa meta e não trava.
- Hoje a lista está muito abaixo de 4096 chaves. Quando a lista assinada se aproximar de 5796 chaves, o operador confere antes que as instalações já passaram da versão anterior (item na #224).

## Testes (cada um falha com o valor antigo; conferido revertendo cada mudança)

- `packages/core/test/blocklist.test.js`: a lista de 16384 chaves é criada, verificada e cabe em `MAX_SNAPSHOT_BYTES`; 16385 chaves são `'malformed'` e `createSnapshot` recusa; `MAX_BLOCKED >= MAX_INVENTORY`. Revertido: 3 asserções falham.
- `packages/core/test/blocklist-net.test.js`: uma lista de 16384 chaves (mais de 393216 bytes) atravessa o canal e é gravada sem mensagem inválida. Revertido: não chega.
- `apps/cli/test/account-mod.test.js`: um `ack` HTTP real com a lista de 16384 chaves responde 200, o espelho mostra 16384 bloqueios e um `pull` assinado devolve a lista. Revertido: a rota recusa o corpo.
- `apps/cli/test/mod-apply.test.js`: o `pull` de uma lista cheia (mais de 1048576 bytes) é aceito. Revertido: 4 asserções falham.
- `apps/cli/test/moderation-store.test.js`: o espelho de 16384 chaves reabre inteiro de `moderation.json`, e `lotado` vale em 16384. Revertido: falha.
- `packages/core/test/mod-request.test.js`: `MAX_CHANGE_IDS <= MAX_BLOCKED`.
- `apps/cli/test/account-mod.test.js`, prazos do `ack`: o prazo de um corpo máximo passa de 10 s e cresce com o tamanho, e o `requestTimeout` cobre o tempo dos cabeçalhos mais o maior prazo; um `ack` sem `Content-Length` recebe 411 com `Connection: close`; um `Content-Length` acima de `ACK_BODY_MAX` recebe 413 sem leitura; com três corpos anônimos de `ack` parados e abertos, um `ack` assinado de verdade responde 200; um corpo de 8000 bytes que pinga é cortado em cerca de 2 s. Revertido: o prazo sem a função falha, o 411 vira 403, o corte do pingo vem em 10 s. Com um limite de 2 leituras posto de volta só para conferir, o `ack` assinado recebe 503 `limite`. O 413 já valia antes e continua.
- `apps/cli/test/mod-apply.test.js`: `pull` e `ack` rodam com `TRANSFER_TIMEOUT_MS` (pelo menos o prazo máximo do `ack` no serviço mais 5 s), os desafios com 10 s. Revertido: falha.

## Comandos

```sh
npm run lint
node packages/core/test/blocklist.test.js
node packages/core/test/blocklist-net.test.js
node packages/core/test/mod-request.test.js
node packages/core/test/blocklist-member.test.js
node packages/core/test/blocklist-seeder.test.js
node apps/cli/test/account-mod.test.js
node apps/cli/test/moderation-store.test.js
node apps/cli/test/mod-apply.test.js
node apps/cli/test/mod.test.js
node apps/cli/test/moderation-e2e.test.js
node packages/web-member/test/blocklist.test.js
```

## Não rodado

Nenhum aparelho: a mudança não toca tela. Uma lista real com mais de 4096 chaves não existe hoje; a compatibilidade com nós antigos foi conferida lendo `blocklist-net.js` e pelos testes do canal.
