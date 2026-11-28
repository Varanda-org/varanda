# Fork e cópia velha nos avisos

Testes de caracterização da cópia compartilhada em `packages/web-member/lib/notices.js`. A lib não muda. Loopback: o semeador de teste de `packages/web-member/test/helpers/notices.js` em 127.0.0.1. Nenhuma DHT pública.

`forkDiary` em `packages/web-member/test/helpers/notices.js` faz `core.truncate(keepLength)` e acrescenta blocos diferentes. Isso sobe o fork. Um append sem truncate deixaria o fork em 0.

## Comandos

```sh
node packages/web-member/test/notices-author-core.test.js
node packages/web-member/test/notices.test.js
node packages/web-member/test/notices-link.test.js
node packages/web-member/test/post-notices.test.js
npm run lint
```

## Cobertura

Quatro testes novos em `notices-author-core.test.js`. O evento de trace não é uma promise: o teste espera a resposta do `read` e, nos forks no meio da leitura, a promise que o evento `kept` ou `get` disparou.

- `a kept copy that still matches is the only core the next row opens`: duas linhas, diário sem fork. Aberturas `[false, true]`. A cópia compatível devolve o resultado e não cai no `fetchRow` novo. Cobre o retorno da linha 605 quando `r !== STALE`.
- `a fork after a kept copy: the next row does not answer from it, opens one fresh core, and is dropped`: duas linhas do mesmo autor. No evento `kept` da primeira, `forkDiary` reescreve o diário. A segunda abre a cópia (`reused` true), não lê bloco (entre essa abertura e a seguinte só há `closed`), abre outra vez com `reused` false e sai descartada. Um `kept` só, antes dessa reabertura. Todo núcleo aberto fecha. A leitura não fica incompleta. A linha que verificou antes do fork continua na resposta.
  - Linha 699: `q.fork !== 0` na cópia reaproveitada devolve STALE (o retorno é antes de qualquer `get`).
  - Linha 605: esse STALE segue para o armazenamento novo. A segunda abertura é essa tentativa, uma só.
  - A tentativa nova também passa pela linha 711: `get` do bloco 0 e nenhum `get` com seq > 0.
- `a diary forked before the read: one fresh core, the row is dropped, and no block past 0 is fetched`: o diário já está forkado, com certificado, comprimento e cota que passariam na conferência do bloco 0, e o bloco da linha ainda é uma resposta abaixo do comprimento. Uma abertura `reused` false, linha descartada, nada guardado, `get` só do bloco 0. Cobre a linha 711 (núcleo novo com `q.fork !== 0`).
- `a fork while the row reads its blocks: the window passes, the fork check after it drops the row`: diário `[certificado, perfil, resposta seq 2, post seq 3]`, uma linha no seq 2. No primeiro `get` do seq 2, `forkDiary(A, 4, [post])` trunca no comprimento inteiro (nenhum bloco que a linha lê é cortado, então os `get` em voo se resolvem) e acrescenta um post: `A.fork` 1, `A.length` 5. A checagem da linha 711 já passou com fork 0; a janela lê os blocos 0 a 3. Resposta vazia, leitura não incompleta, uma abertura `reused` false, nada guardado. Cobre a linha 837. Truncar abaixo dos blocos da linha (`forkDiary(A, 3, ...)`) faria o `get` em voo voltar nulo e daria descarte com `incomplete` true, que não é a linha 837.

## Prova por mutação

Cada mutação deve derrubar um teste novo (os números de linha são de `packages/web-member/lib/notices.js`, a lib não muda):

1. Na linha 699, trocar `q.fork !== 0` por `false`. Falha o teste do fork depois do `kept`: a cópia deixa de ser STALE por causa do fork, então não há a abertura `reused` false. A linha continua descartada, na linha 711 da cópia reaproveitada. A cláusula do mesmo fork com `remoteLength > q.length` continua no código; o teste usa um fork de verdade para não depender dela.
2. Remover o fallback da linha 605, `if (r !== STALE) return r`.
   - Apagar a linha e deixar o `return fetchRow` de baixo incondicional: falha `a kept copy that still matches is the only core the next row opens` (a segunda linha abre um núcleo novo), e também os testes já existentes 1, 2, 3, 6 e 7. O teste do fork continuaria passando, porque ele já espera essa abertura.
   - Trocar a linha por `return r`, devolvendo STALE sem a tentativa nova: falha o teste do fork depois do `kept`, na abertura `reused` false.
3. Na linha 837, trocar `if (q.fork !== 0 || overQuota(q)) return DROPPED` por `if (overQuota(q)) return DROPPED`. Falha só o teste do fork durante a janela: a resposta passa a ter a linha (`[[2, 'reply']]`). Saída: `# tests = 10/11 pass`, `# asserts = 84/85 pass`.

Mutações que sobrevivem (todos os testes passam, 11/11):

- Na linha 699, reduzir a condição a `if (q.fork !== 0) return STALE`, sem a cláusula do mesmo fork com `remoteLength > q.length`.
- Na linha 848, trocar o retorno por `return failed()`. Isso também mostra que o caminho do teste do fork depois do `kept` é a linha 699, não esse catch.

## Fora de alcance

- A segunda cláusula da linha 699 (mesmo fork, `remoteLength > q.length`) fica sem teste próprio: a mutação acima sobrevive.
- O catch da linha 848 com `matched` ainda falso (a cópia guardada lança antes de casar, uma tentativa nova, e a linha verifica contra um autor de fork 0) não sai do helper: `forkDiary` faz o `update` resolver com `q.fork !== 0`, que é a linha 699, sem lançar. Um throw depois de `matched` true, que chamaria `failed()` sem segunda abertura, também exigiria injetar a falha na lib.

## Lacuna do perf

`docs/verification/perf-notices-author-core.md` (linha 78) diz que o caminho de fork ou histórico incompatível num armazenamento reaproveitado não tinha teste próprio, porque o semeador de teste não servia um fork do mesmo diário. Os testes acima fecham a parte do fork: o helper reescreve o núcleo que o semeador de teste já replica. O histórico incompatível no mesmo fork (a segunda cláusula da linha 699) e o catch da linha 848 continuam sem teste.
