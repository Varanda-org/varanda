# Marcas de leitura enviadas em segundos (branch fix/seen-sync-latency)

O app manda as marcas de leitura (bloco de vistos cifrado de `/account/seen/`) poucos segundos depois de uma leitura, e não mais no ciclo longo. Os outros aparelhos as recebem na próxima consulta deles (ao ficar visíveis, ao reconectar ou a cada 5 min); nada os avisa na hora. Para isso caber, o serviço de conta passou a aceitar, por membro, 64 gravações e 120 leituras a cada 10 min (antes, 10 e 30): até 4 aparelhos ativos da mesma passkey, cada um com no máximo 13 gravações a cada 10 min, contando a recusada com 409 (`conflito`), que também é cobrada: 52 para 4 aparelhos, e o resto cobre as passagens de desbloqueio, que o app deixa passar do seu teto. Cada passagem faz uma leitura, e o espaçamento das passagens deixa cada aparelho perto de 15 a cada 10 min: cerca de 60 leituras para 4 aparelhos. Os apagamentos continuam em 5. Um pedido recusado com 429 não gasta o nonce nem muda o arquivo (a janela é cobrada antes de o nonce ser gasto, em `apps/cli/lib/account/seen-routes.js`).

## Testes automatizados

Cada arquivo rodado sozinho (`node <arquivo>`), com lint limpo nos arquivos mudados (`npx standard`):

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/cli/test/account-seen.test.js` | 14/14 | 339/339 |
| `apps/app/test/seenSync.test.js` | 60/60 | 259/259 |
| `apps/app/test/account.test.js` | 80/80 | 1329/1329 |

- `node apps/cli/test/account-seen.test.js`: a 121ª leitura e a 65ª gravação em 10 min respondem 429 `pedido-invalido`; o arquivo guardado não muda, outro membro mantém a sua janela e o nonce recusado ainda vale depois que a janela anda (relógio falso, sem espera real). Com os limites trocados por 121 e 65, os dois testes falham.
- `npx standard apps/cli/lib/account/server.js apps/cli/test/account-seen.test.js`: limpo.
- `node apps/app/test/seenSync.test.js`, com relógio falso: uma marca é gravada 3 s depois; a quinta passagem em 300 s espera o intervalo de 60 s; uma visita 20 s depois de uma passagem roda aos 60 s em vez de se perder; uma falha é tentada de novo uma vez, 15 s depois; um 429 espera 120 s sem nova tentativa, também quando chega na nova tentativa; marcar sem parar por 30 min mantém o intervalo de 60 s e nunca chega ao teto de 13 gravações; uma passagem conta cada gravação enviada (duas depois de um 409); o desbloqueio passa do teto, mas a nova tentativa dele espera a janela andar; e `App.js` devolve ao agendador o resultado da passagem.
- `node apps/app/test/account.test.js`: as chamadas de vistos do app continuam com o mesmo formato.

## Conferência manual

Todas a fazer:

- Duas sessões web (A e B) da mesma passkey contra um serviço de conta local. Marcar uma conversa direta como lida em A: o ponto de Conversas de B some na próxima consulta de B: logo que B fica visível, ou em até 5 min com B visível.
- Ler os Avisos em A: o ponto do sino de B some do mesmo jeito.
- 65 gravações seguidas, feitas por script com a chave de um membro de teste, em menos de 10 min: a 65ª recebe 429. Num aparelho de teste, forçar um 429: o app espera 120 s antes da próxima passagem.
