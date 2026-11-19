# Sinal de leitura dos avisos (branch feat/seen-sync-signal)

## O que muda

- A leitura autenticada de vistos devolve `outstanding` e `asOf`. A gravação pode levar `close` e `asOf`, fora do enunciado assinado, no corpo do pedido assinado de uso único. Só tags notificadas pelo serviço nas últimas 24 h entram no fechamento.
- Depois de gravar, o serviço retira da fila trabalhos ainda não em voo com tag em `close` e `g <= asOf`, com devolução das cotas. Com `VARANDA_SEEN_SIGNAL=1`, manda `{ v: 1, kind: 'seen-sync', close: [tagHash, ...], asOf }`, juntando chamadas ao fim de 20 s por membro, no máximo 30 por hora, com enchimento e espera de 0 a 5 s. A retirada funciona com a chave desligada.
- `push/check` recebe `caps` do worker; `push-caps.json` guarda a capacidade por membro e hash do endereço da inscrição e a apaga junto com a inscrição ou conta. Só workers que anunciaram `seen-sync` recebem o sinal.
- O worker fecha avisos pelos hashes e pelo limite de tempo e acorda o app com `varanda-seen-sync`. O app acorda o agendador com motivo `remote` e também fecha avisos lidos localmente por `varanda-notices-close`; no nativo, o fechamento local não faz nada nesta versão.
- Termos e Política de Privacidade na versão 100, data 19/11/2026, com digest e páginas do site regenerados. Acréscimos em `docs/protocol.md`, `docs/design.md` e `docs/app.md`, preservando o texto anterior.

## Testes automatizados

Aterrissagem na `849a73b4`, já com `feat/group-message-notice` incorporada: `npm run lint` passou, os 147 arquivos de teste que o diff alcança passaram, e `npm run demo` terminou com `DEMO OK`. `node apps/site/scripts/render-legal.js --check` passou. Os arquivos desta mudança:

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/app/test/account.test.js` | 91/91 | 1420/1420 |
| `apps/app/test/avisosHosted.test.js` | 33/33 | 233/233 |
| `apps/app/test/noticeClose.test.js` | 5/5 | 38/38 |
| `apps/app/test/noticeReads.test.js` | 7/7 | 53/53 |
| `apps/app/test/noticeReadsWiring.test.js` | 10/10 | 112/112 |
| `apps/app/test/noticeTags.test.js` | 11/11 | 342/342 |
| `apps/app/test/sw.test.js` | 121/121 | 2077/2077 |
| `apps/app/test/legal.test.js` | 72/72 | 2185/2185 |
| `apps/site/test/legal.test.js` | 7/7 | 115/115 |
| `packages/core/test/notice-tags.test.js` | 4/4 | 150/150 |
| `packages/core/test/terms.test.js` | 8/8 | 126/126 |
| `apps/cli/test/account-push.test.js` | 86/86 | 2127/2127 |
| `apps/cli/test/account-seen.test.js` | 17/17 | 383/383 |
| `apps/cli/test/account-delete.test.js` | 34/34 | 278/278 |
| `apps/cli/test/account-phone-gates.test.js` | 7/7 | 43/43 |
| `apps/cli/test/push-caps-store.test.js` | 5/5 | 70/70 |
| `apps/cli/test/push-caps-wiring.test.js` | 1/1 | 4/4 |
| `apps/cli/test/cli.test.js` | 6/6 | 1397/1397 |

Na revisão T22, os quatro arquivos de teste passaram, assim como `node apps/site/scripts/render-legal.js --check`. A primeira execução isolada do teste legal falhou só no digest antigo (71/72 testes, 2184/2185 asserções); após atualizar o digest com o `actual`, passou (72/72 testes, 2185/2185 asserções). O Node emitiu `MODULE_TYPELESS_PACKAGE_JSON` ao importar `legal.js`, sem impedir os testes ou a renderização. `XDG_CACHE_HOME=/tmp/t22-standard-cache npm run lint` e `git diff --check` passaram. A comparação com a base confirmou que todas as linhas anteriores dos três documentos foram preservadas; nenhum acréscimo contém U+2014.

## No aparelho

- a fazer: em duas instalações da mesma conta, conferir DM, Página DM, grupo público, grupo privado e aviso social com push local simulado. Ler em uma instalação e conferir o fechamento na outra, só para avisos com `g <= asOf`.
- a fazer: manter um aviso na fila, ler e confirmar a retirada com devolução de cotas, tanto com o sinal ligado quanto desligado. Um aviso já em voo não é retirado.
- a fazer: conferir a união dos hashes e o menor `asOf` em 20 s, o teto separado de 30 por hora e a ausência de sinal para worker sem a capacidade.
- a fazer: abrir o app, voltar à janela visível e atualizar Conversas e Avisos; conferir o fechamento local. Receber `varanda-seen-sync` deve acordar a sincronização de vistos.

## O que não foi conferido

- Android, iOS e navegadores não foram conferidos no aparelho: as conferências de "No aparelho" continuam devidas.
- A suíte completa (`npm test`) não rodou localmente: roda na CI do GitHub. Não houve envio de push real nem teste em rede externa.

## Limites conhecidos

- O serviço aprende quando o aparelho mostrou como lido um aviso que ele próprio enfileirou ou enviou nas últimas 24 h, pela tag, e quais inscrições suportam o sinal. Não aprende por esse sinal sobre itens que não notificou. O serviço de push vê o momento do sinal. Logs nunca levam tag, chave de membro ou destinatário.
- Marcas de Página DM não são sincronizadas. Uma marca de grupo só se aplica em outro aparelho que já tenha a publicação.
- O aviso de Página DM nunca é fechado pelo sinal: a tag é a mesma para todas as Páginas que a pessoa administra, e o app só sabe o que foi lido na Página aberta.
- Um aviso de resposta não é fechado em outro aparelho: a linha de Avisos não traz a publicação respondida, que dá nome à tag.
- Avisos sociais só são fechados por workers atualizados: o campo `g` vai apenas para inscrições que anunciaram `seen-sync`, para que workers antigos continuem aceitando o formato anterior.
- Juntando gravações em 20 s, o sinal usa o menor `asOf` entre elas; um aviso recebido depois da primeira gravação pode continuar aberto.
- Uma mensagem guardada antes da resposta de leitura, mas ainda não buscada pelo aparelho que lê, pode ter seu aviso fechado. Fechar um aviso não apaga a mensagem.
- O sinal vem desligado por padrão, depende de capacidade anunciada pelo worker e tem limite de envio. O app nativo ainda não fecha avisos locais por esse mecanismo.
