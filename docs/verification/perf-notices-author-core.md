# perf/notices-author-core

`notices.list` no celular de quem é dono do diário levava cerca de 5,7 s, quase tudo nas linhas ("linhas 5361 ms"). Em `packages/web-member/lib/notices.js`, cada linha abria um núcleo novo em memória, e as linhas de um mesmo autor rodavam uma depois da outra; por isso cada linha do mesmo autor buscava de novo o bloco 0, o começo e o fim do diário.

## O que mudou

- As linhas de um mesmo autor numa mesma página do semeador usam um só armazenamento em memória (`memoryStorage`) durante a leitura. Continua no máximo um núcleo aberto por autor, e a linha seguinte só reabre o armazenamento depois que o núcleo da anterior fechou.
- O núcleo reaberto pede ao link a cabeça assinada atual (`update`) antes de ler: o que o autor acrescentou entre uma linha e outra é lido. Um fork, uma cabeça mais longa que o núcleo não alcança, ou um armazenamento que não abre fazem a linha rodar de novo num armazenamento novo, que passa a ser o do autor. Sem resposta do link a tempo, a linha conta como um bloco 0 que não chegou.
- O bloco 0 e os blocos do fim assinado (os últimos `PEEK_TAIL_BLOCKS`, 8) que o armazenamento já tem são lidos dele: sem pedido ao semeador e sem cobrança no orçamento de bytes (o limite de tamanho do bloco continua valendo). Os blocos abaixo do fim (o começo 1..2 e o próprio bloco da linha, quando fica abaixo) são tirados da cópia (`clear`) e pedidos ao semeador em cada linha, como antes. O fim e o `clear` usam o comprimento assinado com que a linha confere, lido depois do bloco 0, e não a cabeça vista no `update`: o que o autor acrescenta depois disso fica fora da cópia que a linha confere, como sem a cópia guardada, e um bloco que estava no fim antigo e ficou abaixo do novo não é servido pela cópia. O motivo: um apagamento sempre fica acima do bloco que apaga e o bloco 0 nunca é apagado, então um bloco do fim tem o apagamento lido na janela da própria linha, mas um bloco abaixo dele pode ter sido apagado, e limpo pelo semeador, depois que uma linha anterior o leu, com o apagamento também abaixo do fim. Os blocos que chegam pelo link são cobrados como antes.
- A consulta local de um bloco numa linha que reaproveita o armazenamento conta como um pedido em voo (`run.pending`) até terminar, para a checagem de orçamento da janela, que lê esse número na hora de cada início. Assim a linha não dispara até 4 pedidos de uma vez perto do fim do orçamento, e o excesso sobre o orçamento continua de no máximo um bloco por linha.
- Uma linha cujo próprio bloco um registro `delete` no fim assinado apaga é descartada: a cópia guardada pode ainda ter o bloco que o autor apagou depois que uma linha anterior o leu, enquanto o semeador já o limpou.
- Toda conferência continua por linha (bloco 0 e certificado, bloqueio e emissores revogados, o bloco `seq`, o fim assinado). Só uma linha que verificou por inteiro deixa o armazenamento para a próxima; uma linha que falhou, foi cortada ou não verificou não passa nada adiante. O armazenamento de um autor some quando acaba o último item dele na página, no fim da página, no fim da leitura, num abort e com o link perdido, e no máximo `NOTICES_PARALLEL` (8) autores guardam um ao mesmo tempo. Nada vai para o disco e nada passa de um autor para outro nem de uma leitura para outra.
- Não mudaram: orçamento, prazos, a janela de 4 blocos em voo, o limite de quadro, o link separado, `NOTICES_CACHE_TTL_MS` e o intervalo do app.
- `docs/rpc.md` (5.28, custo) ganhou uma frase sobre a cópia em memória compartilhada pelas linhas do mesmo autor.

## Testes

Arquivo novo `packages/web-member/test/notices-author-core.test.js` (DHT nenhuma: o semeador de teste de `test/helpers/notices.js` em 127.0.0.1), 7 testes e 49 asserções:

1. Cinco linhas de um autor: a resposta é exatamente as cinco respostas esperadas. Contado no evento `upload` do núcleo do autor, o bloco 0 e o fim (blocos 9 a 16) são enviados uma vez cada; abaixo do fim, cada linha pede ao semeador como sem a cópia: o começo 1..2 uma vez por linha (5 vezes) e cada resposta (blocos 3 a 6) uma vez, pela própria linha.
2. Crescimento entre linhas: depois que a primeira linha fecha o núcleo, o autor troca o nome do perfil; a segunda linha, no armazenamento reaproveitado, mostra o nome novo e pede o bloco novo.
3. Resposta apagada entre linhas: duas respostas do mesmo autor (blocos 2 e 3), e a primeira linha lê o bloco 3 no fim do diário. Depois que ela fecha o núcleo, o autor apaga a resposta 3 (registro `delete`) e o semeador de teste limpa o bloco, como os semeadores fazem. A segunda linha lê o bloco 3 da cópia guardada, mas o fim assinado traz o apagamento: a linha dela some, a da resposta 2 fica, e a leitura não sai incompleta (um apagamento conhecido não é leitura incompleta).
4. Autor com emissor revogado e autor bloqueado: nenhuma linha deles aparece, nada do bloqueado é buscado, e cada linha do revogado busca o próprio bloco 0 (a linha que falha não deixa armazenamento).
5. Abort com um armazenamento guardado e duas linhas esperando bloco: todo núcleo aberto fecha e nenhum armazenamento fica guardado.
6. Fim do orçamento numa linha reaproveitada: orçamento de 24576 bytes (cabe a primeira linha e mais um bloco de até 16384 bytes, não dois). Depois que a primeira linha fecha o núcleo, o autor acrescenta seis publicações (blocos 4 a 9), que a cópia guardada não tem. A segunda linha lê o bloco 0 da cópia, pede uma vez cada bloco novo e o bloco 1 do começo (abaixo do fim, que vai de 2 a 9), e nunca tem mais de um pedido em voo.
7. Resposta apagada com o apagamento abaixo do fim: como no teste 3, mas depois do apagamento (bloco 4) o autor acrescenta 8 publicações (blocos 5 a 12), então o fim da segunda linha vai de 5 a 12 e não traz o apagamento. A segunda linha lê o bloco 0 da cópia, mas não o bloco 3: pede-o ao semeador, que já o limpou, e ele não chega. A linha da resposta apagada some e a da resposta 2 fica. `blockTimeoutMs` de 2000 ms, o tempo que a linha espera pelo bloco limpo.

Sem a mudança (o `notices.js` de `HEAD` no lugar), o arquivo novo falha: 0 de 7 testes, 27 de 49 asserções. O teste 1 falha na contagem de envios (na base, os blocos 0, 2, 13, 14, 15 e 16 eram enviados mais de uma vez). No teste 3, a base também tira a resposta apagada (o bloco limpo nunca chega a um armazenamento novo), mas marca a leitura como incompleta e não reaproveita armazenamento. No teste 7, a base também tira a resposta apagada; o que falha são as asserções sobre a cópia reaproveitada. Com a mudança mas com o `update` do núcleo reaberto trocado por uma promessa já resolvida, o arquivo falha em 2 de 7 testes passando, 32 de 49 asserções: no teste 2 a segunda linha sai com o nome antigo ("Ana") e o bloco novo não é pedido, e as linhas reaproveitadas dos outros testes também falham. Com a mudança mas sem a linha `if (gone.has(item.seq)) return DROPPED` de `fetchRow`, o teste 3 falha (6 de 7 testes, 48 de 49 asserções): a resposta apagada aparece, servida pela cópia guardada. Com a mudança mas sem contar a consulta local em `run.pending` (`getBlock`), o teste 6 falha (6 de 7 testes, 48 de 49 asserções): a segunda linha chega a ter 4 pedidos em voo ao mesmo tempo. Com a mudança mas lendo da cópia qualquer bloco que ela tenha (sem o `clear` dos blocos abaixo do fim e sem a regra de `fromCopy`), falham os testes 1, 6 e 7 (4 de 7 testes, 44 de 49 asserções): no teste 7 a resposta apagada aparece, servida pela cópia guardada. Só sem o `clear`, falham os testes 1 e 7 (5 de 7, 46 de 49): o pedido do bloco 3 sai, mas o Hypercore o responde com o bloco que a cópia ainda tem, sem perguntar ao semeador. Só sem a regra de `fromCopy`, com o `clear`, os 7 passam (49 de 49): depois do `clear`, a consulta local de um bloco abaixo do fim não acha nada e o pedido vai ao semeador; a regra só evita essa consulta.

Rodados um arquivo por vez com `node <arquivo>`, todos passando: o arquivo novo, `notices.test.js` (24/24), `notices-link.test.js` (7/7), `post-notices.test.js` (9/9) e os outros 37 arquivos de `packages/web-member/test` que importam `lib/notices.js` ou `lib/storage.js`.

## Medição A/B

Script local fora do repositório: o `notices.js` de `HEAD` e o novo, lado a lado no mesmo processo, contra um semeador de teste em 127.0.0.1 com atraso de RTT/2 em cada sentido de cada quadro, aplicado no lado do semeador do WebSocket. Cada leitura usa um noticer novo (sem cache de evidências) e mede o `read` inteiro, conexão e prova incluídas. As execuções alternam qual versão roda primeiro. Cenários: 10 linhas de 1 autor (respostas nos blocos 2 a 11 de um diário de 30 blocos) e 10 linhas de 10 autores (diários do mesmo formato). As respostas das duas versões são iguais. Node 24.22.1, macOS, 12 núcleos, máquina com outras sessões.

Rodada 1, 20 leituras por célula (ms):

| Cenário | RTT | Base mediana | Base p95 | Nova mediana | Nova p95 | p95 |
|---|---|---|---|---|---|---|
| mesmo autor | 0 | 12,2 | 17,3 | 7,3 | 9,5 | -45,1% |
| mesmo autor | 100 | 7669,8 | 7689,4 | 2957,6 | 2965,2 | -61,4% |
| autores distintos | 0 | 8,3 | 9,8 | 8,3 | 10,9 | +11,8% |
| autores distintos | 100 | 1807,2 | 1814,2 | 1808,9 | 1816,6 | +0,1% |

Rodada 2, só RTT 0, 60 leituras por célula (ms):

| Cenário | RTT | Base mediana | Base p95 | Nova mediana | Nova p95 | p95 |
|---|---|---|---|---|---|---|
| mesmo autor | 0 | 10,6 | 14,8 | 6,1 | 8,2 | -44,8% |
| autores distintos | 0 | 6,9 | 8,8 | 6,9 | 8,1 | -7,8% |

Rodada 3, só RTT 0, 150 leituras por célula (ms), combinada antes de rodar como a que decide, porque as rodadas 1 e 2 divergiram em autores distintos:

| Cenário | RTT | Base mediana | Base p95 | Nova mediana | Nova p95 | p95 |
|---|---|---|---|---|---|---|
| mesmo autor | 0 | 9,6 | 12,9 | 5,8 | 8,4 | -34,9% |
| autores distintos | 0 | 6,9 | 10,7 | 7,0 | 10,6 | -0,5% |

As rodadas 1 a 3 mediram o código antes das correções da revisão (linha apagada no fim assinado, contagem do orçamento, leitura da cópia limitada ao bloco 0 e ao fim assinado). A rodada 4 mede o código com essas correções, antes de a limpeza abaixo do fim passar a usar o comprimento conferido; essa última mudança só troca de lugar a mesma limpeza.

Rodada 4, 150 leituras por célula com RTT 0 e 20 com RTT 100 (ms):

| Cenário | RTT | Base mediana | Base p95 | Nova mediana | Nova p95 | p95 |
|---|---|---|---|---|---|---|
| mesmo autor | 0 | 9,8 | 13,4 | 6,6 | 9,6 | -28,2% |
| autores distintos | 0 | 6,8 | 8,7 | 6,9 | 8,6 | -1,0% |
| mesmo autor | 100 | 7673,2 | 7712,8 | 3909,5 | 3933,2 | -49,0% |
| autores distintos | 100 | 1808,3 | 1819,7 | 1803,5 | 1819,5 | -0,0% |

Com RTT 100 o ganho do mesmo autor cai de 61,4% (rodada 1) para 49,0%: os blocos abaixo do fim voltam a ser pedidos ao semeador.

Critério combinado: p95 do mesmo autor pelo menos 20% menor e p95 de autores distintos no máximo 10% pior. O mesmo autor passa nas quatro rodadas. Autores distintos com RTT 0 passou do limite na rodada 1 (+11,8%, 1,1 ms em cerca de 10 ms, com medianas iguais, 20 leituras) e ficou dentro nas rodadas 2 (-7,8%), 3 (-0,5%) e 4 (-1,0%); com RTT 100 a diferença fica em 0,1% ou menos. Resultado: passa, também no código final (rodada 4). Nesse cenário nenhum armazenamento é guardado (cada autor tem um item), então o caminho da linha é o de antes mais a contagem de itens por autor.

## O que não foi conferido

- O celular de quem é dono do diário: o ganho real depende de quantas linhas seguidas vêm do mesmo autor.
- Latência real da internet e da DHT: o atraso foi simulado em loopback, sem perda nem variação.
- O caminho de fork ou de histórico incompatível num armazenamento reaproveitado não tem teste próprio: o semeador de teste não serve um fork do mesmo diário.

## Comandos

```sh
npx standard packages/web-member/lib/notices.js packages/web-member/test/notices-author-core.test.js
node packages/web-member/test/notices-author-core.test.js
node packages/web-member/test/notices.test.js
node packages/web-member/test/notices-link.test.js
node packages/web-member/test/post-notices.test.js
```

A suíte inteira roda no GitHub CI (Node 20 e 24).
