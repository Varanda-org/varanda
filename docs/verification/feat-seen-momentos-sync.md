# Momentos vistos no documento de vistos (PR feat/seen-momentos-sync)

Parte 2 da #447. Os momentos que a pessoa já viu (os refs `autor:seq` que pintam o anel como visto) saem da lista do aparelho (`varanda-moments-seen`) e entram no documento de vistos cifrado (docs/protocol.md §14), por identidade, sincronizados entre os aparelhos da mesma passkey pelo `seen.merge`, como as decisões de depoimentos da #610.

## O que muda

- Documento de vistos versão 4: cabeçalho de 79 bytes com `nMomentos` (u8) e, no fim, até 132 entradas de 40 bytes (autor 32, seq u32, t u32).
- Janelas da versão 4: mensagens diretas 128 (eram 256), grupos 92 (eram 128), momentos 132. As versões 1, 2 e 3 continuam sendo lidas (tokens cortados para 128, grupos para os 92 mais recentes, momentos vazios) e são regravadas como 4.
- União por (autor, seq), fica a maior hora, depois o corte nos 132 de maior hora. Um momento visto nunca volta a "não visto" por causa de um remoto que não o tem.
- Nó do navegador: kv `momentSeen` presa à chave própria (`{ v: 1, own, entries }`), apagada no recomeço (`resetChain`), lida pelo `seen.sign` e regravada pelo `seen.merge`, que devolve `momentsChanged`.
- RPC: `moment.seen` (5.149, `{ author, seq }`, devolve `{ changed }`, acorda uma passada de vistos quando muda) e `moments.seen` (5.150, devolve `{ refs }`, no máximo 132). Os dois exigem a identidade desbloqueada. O nó core responde `USAGE` "estado de vistos sincronizado só no navegador". `MOMENT_SEEN_MAX = 132` em `@varanda/rpc`.
- App: o armazenamento de vistos pergunta `moments.seen` ao nó hospedado (chave: `node.epoch`). Se o nó responde, a lista e as marcas vão para ele; se responde "estado de vistos sincronizado só no navegador" ou "método desconhecido", a lista fica no aparelho como antes. Decisão por capacidade, sem `Platform.OS`. Uma falha passageira (bloqueio, conexão) não marca em lugar nenhum e pergunta de novo depois.
- Migração única por nó: depois de uma resposta do `moments.read`, a lista antiga do aparelho é apagada primeiro e só então os refs vão ao nó, um `moment.seen` cada, só os dos momentos respondidos naquela hora, os 132 mais recentes. Nunca reenviada. Se apagar falhar, nada vai.
- Sair da conta e recomeçar apagam a lista antiga do aparelho (`passkeyOp`). Uma passada de vistos com `momentsChanged` faz o app reler a lista do nó.
- Termos e Privacidade 63: o parágrafo do bloco de vistos diz que ele guarda os momentos já vistos (chave de quem publicou, número do registro, hora, até 132), que nada do conteúdo vai no bloco e que, onde o aplicativo não usa o bloco, a lista fica no aparelho e sai com a saída da conta. A tabela LGPD de `docs/design.md` segue.

## Decisões

- Orçamento: a versão 3 sobrava 46 bytes, e 132 x 40 não cabia. Como a #610 fez com as mensagens diretas, a versão 4 corta janelas: dm 256 para 128 e grupos 128 para 92. No limite: 79 + 256 x 20 (avisos) + 4 x (33 + 32 x 20) (páginas) + 128 x 20 (dm) + 92 x 76 (grupos) + 128 x 37 (bloqueios) + 128 x 41 (decisões) + 132 x 40 (momentos) = 32707 bytes de 32768; sobram 61.
- O dono do produto escolheu cortar a janela de mensagens diretas de 256 para 128 e a de grupos de 128 para 92 para que os 132 momentos ao vivo caibam nos 32768 bytes; o documento tinha 46 bytes de folga.
- Contagem em u8: 132 cabe, e o código recusa subir o limite acima de 255 sem mudar o formato.
- `moment.seen` não altera estado no sentido do RPC (como `dm.seen` e `group.seen`): é uma marca idempotente.
- A versão do protocolo RPC continua `v: 1`; métodos novos só ganham seções numeradas.

## Testes (cada arquivo rodado sozinho, `node <arquivo>`)

| Arquivo | Resultado |
|---|---|
| `packages/core/test/seen-blob.test.js` | 38/38 testes, 243 asserções |
| `packages/core/test/moment-seen.test.js` | 3/3, 22 |
| `packages/core/test/seen-session-refuse.test.js` | 3/3, 41 |
| `packages/core/test/terms.test.js` | 8/8, 126 |
| `packages/rpc/test/methods.test.js` | 159/159 |
| `packages/rpc/test/sizes.test.js` | 42/42 |
| `packages/web-member/test/seen-sync.test.js` | 41/41, 315 |
| `packages/web-member/test/session-store.test.js` | 25/25, 173 |
| `apps/app/test/momentosScreen.test.js` | 147/147, 1240 |
| `apps/app/test/seenSync.test.js` | 34/34, 109 |
| `apps/app/test/vitrine.test.js` | 42/42, 3988 |
| `apps/app/test/legal.test.js` | 45/45, 1680 |
| `apps/site/test/legal.test.js` | 7/7, 115 |

Falham sem a correção (linha revertida na hora, rodada, restaurada):

- Marca que falha mantida na memória: falha "a failed mark is forgotten...". Leitura que falha esvaziando a lista no `refresh`: falha "a failed refresh keeps the list...". Migração sem esperar autores: falha "the migration waits for an answer with moments". Teto de dm da versão 4 em 256: falha "a version 4 dm count past the new window (129)".
- `merge` do seen-blob sem a união de momentos: `seen-blob.test.js` falha "moments: the merge is a union...".
- `seen-sync` sem gravar a kv `momentSeen`: falham os três testes de momentos de `seen-sync.test.js`.
- `resetChain` sem apagar a kv: falha "session: moment.seen wakes a seen pass, reset clears it...".
- App sem mandar as marcas ao nó e sem conferir a limpeza antes da migração: falham "a node with moments.seen holds the list..." e "the device list moves to the node once...".

## Limites

- O nó nativo (`packages/core`) não tem documento de vistos: lá a lista de momentos vistos continua só no aparelho, como antes, e é apagada ao sair da conta.
- Um momento visto que sai da janela de 132 volta a aparecer como não visto nos outros aparelhos. Um momento dura 24 horas e o `moments.read` responde no máximo 32 x 4 + 4 itens ao vivo, então a janela cobre todos.
- Um aparelho com código anterior lê a versão 4 como `unsupported` e o visto entre aparelhos fica parado nele até a atualização.
- A primeira leitura de um documento versão 3 já corta para as janelas da versão 4: um aparelho que nunca uniu os 128 tokens de mensagens diretas e as 36 marcas de grupos mais antigas não os recebe (como na passagem da versão 2 para a 3, descrita no §14).
- Uma marca que falha (`moment.seen` sem resposta) sai da memória e só é enviada de novo na próxima vez que a pessoa vê o momento: não há temporizador nem repetição automática.
- A migração espera uma resposta do `moments.read` com autores e itens; com uma resposta vazia, a lista antiga fica e nada é marcado como migrado.
- A migração leva só os momentos respondidos naquela hora; os vistos antigos, já expirados, não sobem.

## Conferência em aparelho

Na Vitrine (`EXPO_PUBLIC_VARANDA_VITRINE=1`, Metro com `--clear`), que trata o nó como hospedado e responde `moment.seen` e `moments.seen` pelo stub de `apps/app/src/vitrine/request.js`:

- **Android** (emulador API 36, build de debug): ao abrir o app, os anéis de João, Cecília e André têm a borda pôr do sol. Abri o momento único de André e fechei depois de dois segundos. Só o anel de André passou para o contorno; João e Cecília continuaram com a borda pôr do sol.
- **iOS** (simulador iPhone 17 Pro, build de debug): o mesmo roteiro, com o mesmo resultado para André. A instalação ainda guardava em `varanda-moments-seen.json` os momentos de João vistos numa conferência anterior. Depois do primeiro `moments.read`, a migração mandou essas marcas ao nó, o anel de João passou para o contorno e foi para o fim da fila, e o arquivo ficou `[]`.
- **Web** (painel do navegador, `localhost:8099`): o mesmo roteiro, com o mesmo resultado. No DOM, os anéis de João e Cecília têm as seis faixas, e o de André, só o contorno.

Não conferido em aparelho: o caminho local do app nativo sem nó hospedado (a lista por aparelho), que a Vitrine não alcança. Ele é coberto por `apps/app/test/momentosScreen.test.js`. A sincronização entre dois aparelhos depende de um nó de navegador com conta, que o build de debug não alcança; ela é coberta por `packages/web-member/test/seen-sync.test.js`.
