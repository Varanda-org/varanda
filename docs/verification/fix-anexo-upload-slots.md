# fix/anexo-upload-slots

Parte de #31. A rota `POST /account/report/anexo` ocupava uma de `MAX_ANEXO_INFLIGHT = 4` vagas logo depois de `declaredLength()`, antes de ler o corpo e antes de conferir o nonce e a assinatura em `report()`. Quatro envios lentos sem assinatura válida (parados abaixo do corte de 5 s, ou pingando dentro do prazo do tamanho) faziam a denúncia de uma pessoa de verdade receber `limite`. Decisão da manutenção: conferir quem denuncia antes de qualquer vaga, tirando o limite, como o PR #737 fez com o `ack` do operador.

## O que mudou

- `apps/cli/lib/account/mod-routes.js`: saem `MAX_ANEXO_INFLIGHT`, o contador `anexoInflight`, o `refuse('limite')` da vaga, o `try/finally` do contador e a exportação. Continuam iguais `declaredLength` (411 sem `Content-Length`, 413 acima de `ANEXO_BODY_MAX`), `readLargeBody` (corte de 5 s sem dados, prazo de 2 s mais o tamanho declarado a 1 Mbit/s) e tudo em `report()`. Os comentários que citavam o limite (cabeçalho, bloco acima de `LARGE_BODY_IDLE_MS`, bloco dos nonces gastos) passam a dizer o que limita essas leituras agora.
- `docs/protocol.md`, parágrafo da rota do anexo: sai "at most 4 such bodies are read at once"; entra o limite atual.
- `README.md`, linha de `VARANDA_ACCOUNT_MAX_CONNECTIONS`: diz que a memória das duas rotas de corpo grande cresce com esse teto, cerca de 1,5 MiB por conexão. O bloco "Ajuda" não muda.
- Este PR resolve o limite conhecido "4 vagas globais" registrado na seção 105 de `docs/verification.md` (aquele arquivo guarda as seções antigas e não muda aqui).
- O formato do pedido não muda, então builds antigos do app continuam funcionando. O app (`apps/app/src/report.js`, `ERROR_MESSAGES`) mostra `limite` com a mesma frase genérica para qualquer rota de denúncia ("a moderação não pode receber denúncias agora") e não trata esse código de forma própria no anexo; o código continua existindo para o teto de 2000 anexos guardados.

## O limite agora

- Quantas leituras ao mesmo tempo: o teto de conexões do serviço (`server.maxConnections`, por padrão `MAX_SOCKETS = 64` em `apps/cli/lib/account/server.js`), dividido com as outras rotas.
- Quanto cada uma guarda: no máximo o tamanho declarado, até `ANEXO_BODY_MAX = 1406296` bytes (o base64 de 1 MiB mais 8192).
- Quanto tempo: o corte de 5 s sem dados e o prazo de 2 s mais o tamanho a 1 Mbit/s (cerca de 13,3 s para um corpo máximo, `ANEXO_READ_MAX_MS = 13251`).
- Pior caso em memória, no teto padrão: cerca de 64 x 1406296 bytes, uns 90 MB de corpos recebidos. A decodificação, a conferência do formato e o hash são síncronos, então só um corpo por vez passa por eles (alguns MB a mais de cópias passageiras).
- Memória com outro teto: ela cresce com `VARANDA_ACCOUNT_MAX_CONNECTIONS` (até 4096), cerca de 1,5 MiB por conexão. O balde global limita quantos corpos chegam a ficar abertos ao mesmo tempo a perto de rajada + ritmo x prazo: 100 + 20 x 14,6 s, uns 390 corpos no ritmo padrão (uns 365 só de anexo, com o prazo de 13,3 s), ou seja, perto de 585 MiB com um teto alto. Vale também para o `ack` do operador desde o #737.
- Trabalho antes da assinatura, para qualquer remetente: a leitura do corpo, o `Buffer.concat`, a decodificação UTF-8 e o `JSON.parse` de até 1,4 MB (`readJsonBody` em `apps/cli/lib/account/server.js`) acontecem antes de conferir o nonce, limitados só pelo balde global (20 por segundo, rajada de 100). Medido abaixo: perto de 6 a 8 ms por corpo no pior formato, cerca de 0,12 a 0,17 s de CPU por segundo no ritmo máximo do balde.
- Trabalho só com nonce verdadeiro e não gasto: a decodificação do base64, a conferência do formato e o hash (`decodeAnexo`), e o nonce é gasto ali mesmo. Cada anexo com nonce gasta duas fichas do balde (`report/start` e o anexo), então em média no máximo cerca de 10 decodificações por segundo, uns 60 ms de CPU por segundo.
- No teto de conexões o serviço inteiro fica fora do ar, denúncias incluídas: 64 conexões presas, cerca de 4,8 pedidos por segundo sustentados (64 / 13,3 s). É o resíduo já aceito no cabeçalho de `apps/cli/lib/account/server.js` (o balde global e o teto de conexões valem para todos; um limite por origem exigiria endereços de clientes, fora deste serviço até o parecer da #38).

## Medição (Apple M4 Pro, Node v24.22.1)

O trabalho que a rota faz por corpo depois de conferir o nonce e antes de conferir a assinatura (`decodeAnexo`: regex do base64, `Buffer.from`, reencode para conferir, `mediaBounds` nos três tipos de imagem e `audioBounds`, SHA-256), 50 rodadas depois de 5 de aquecimento:

| Entrada | Tamanho | Mediana | p95 | Máximo |
|---|---|---|---|---|
| JPEG de ruído | 1004802 bytes | 5,58 ms | 5,80 ms | 6,00 ms |
| Lixo aleatório (todos os formatos testados e recusados) | 1048576 bytes | 5,82 ms | 6,11 ms | 6,45 ms |

No máximo de cerca de 10 decodificações por segundo, isso dá uns 60 ms de CPU por segundo. O script ficou fora do repositório (imagem gerada na hora com `sharp`, `packages/rpc` e a mesma sequência de `decodeAnexo`).

O que qualquer remetente provoca antes do nonce (`Buffer.concat` de pedaços de 64 KiB, `toString('utf8')` e `JSON.parse`, como em `readJsonBody`), 50 rodadas depois de 5 de aquecimento, script em memória fora do repositório:

| Corpo | Tamanho | Mediana | p95 | Máximo |
|---|---|---|---|---|
| Um texto base64 de 1 MiB | 1398128 bytes | 0,62 ms | 0,81 ms | 1,26 ms |
| Lista de números pequenos | 1406273 bytes | 2,40 ms | 3,35 ms | 5,65 ms |
| Lista de objetos pequenos | 1406279 bytes | 6,03 ms | 8,29 ms | 12,10 ms |

No ritmo máximo do balde (20 por segundo), o pior formato dá cerca de 0,12 s (mediana) a 0,17 s (p95) de CPU por segundo.

## Teste

`apps/cli/test/dm-report.test.js`, "report with anexo: stalled bodies from senders who never sign do not hold back a valid report, and are cut" (substitui "a stalled body is cut and its slot serves the next report", que exigia o `limite` das 4 vagas): abre 6 envios crus com `Content-Length` de `ANEXO_BODY_MAX - 1`, manda poucos bytes e para; enquanto eles esperam, uma denúncia de conversa privada assinada de verdade, com imagem, responde 200 e fica guardada com o anexo, com os 6 envios ainda abertos (o teste conta quantos já terminaram quando a resposta chega e exige 0, sem medir relógio); depois os 6 são cortados pelo servidor, a partir de 4,5 s e antes de 12 s; só a denúncia assinada fica guardada.

Com o limite de 4 posto de volta só para conferir, o teste falha:

```
not ok 1 - answered while the stalled bodies hang: {"error":"limite"}
not ok 2 - stored with its anexo
not ok 3 - every stalled body still open when the report was answered
not ok 8 - cut by the server
not ok 9 - cut by the server
not ok 12 - only the signed report stored
# tests = 15/16 pass
# asserts = 134/140 pass
```

O 3, o 8 e o 9 vêm do quinto e do sexto envio parados, que recebem `limite` logo, em vez de ficarem abertos e serem cortados. Sem o limite: 16/16 testes e 140/140 asserções. Contagem do arquivo: antes 16 testes e 137 asserções, depois 16 testes e 140 asserções. Dois nomes de teste e uma mensagem que falavam em vaga foram ajustados, sem mudar o que conferem.

## Comandos

```sh
node apps/cli/test/dm-report.test.js
node apps/cli/test/readme-help.test.js
npx standard apps/cli/lib/account/mod-routes.js apps/cli/test/dm-report.test.js
```

## Não rodado

Nenhum aparelho: a mudança não toca tela nem o formato do pedido.
