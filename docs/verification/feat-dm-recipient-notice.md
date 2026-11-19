# Aviso de mensagem nova só para quem recebe (branch feat/dm-recipient-notice)

## O que muda

- O nó de quem envia (nó do navegador, ou nó core com Conversas), depois que o semeador confirma a cópia de quem recebe, a mensagem é guardada no aparelho e o semeador confirma a cópia própria (`docs/rpc.md` 5.167), manda um quadro `{ type: 'wake', id, box }` no canal `varanda/dm-notice/1`: `id` é o envelope que acabou de guardar e `box` é a chave de quem recebe (ou da Página) lacrada com `crypto_box_seal` para a chave de aviso do serviço de conta, sempre com 116 bytes (`DMN1`, versão 1, 32 bytes de chave, 31 zeros). Uma falha na cópia própria não manda o aviso. Sem chave de aviso (`dm.noticeKey`), nada é enviado.
- O semeador responde sempre `{ type: 'ack' }`, nunca abre a caixa e a repassa ao serviço de conta pelo relé local (`{ v: 1, kind: 'dm', box }`) só quando o envelope foi guardado naquela mesma conexão nos últimos 60 s, uma vez só. Uma visita nunca abre um aviso. A opção `dm.onDrop` saiu; no lugar, `dm.onNotice(box)`.
- O serviço de conta cria uma vez o par X25519 de aviso (`push-wake.json`, 0600) e serve a parte pública como `wake` em `GET /account/push/key`. Abre a caixa e manda um Web Push `{ v: 1, kind: 'dm' | 'dm-page', g }` aos aparelhos de quem recebe; para uma Página, ao dono e aos administradores atuais. Tetos: um por destinatário a cada 15 min, 60 por pessoa por hora, no máximo metade da fila, só para quem aceitou os Termos 93. Mesmo enchimento e mesma espera de 0 a 60 s dos outros avisos. O `dm-wake` antigo de um semeador é aceito e descartado.
- O service worker mostra "Nova mensagem nas Conversas" (tag `varanda-dm`) ou "Nova mensagem para uma página que você administra" (tag `varanda-dm-page`), abre as Conversas no toque (no aviso de uma Página, a lista de Páginas, e esse aviso aparece mesmo com a janela em foco) e não aplica o silêncio do aparelho que enviou. O `dm-wake` antigo continua sendo mostrado por mais uma versão.
- Termos e Política de Privacidade na versão 93 (`TERMS_VERSION` e `LEGAL_VERSION`), com novo aceite: descrevem o aviso só para quem recebe, o que o serviço de conta fica sabendo (que a pessoa recebeu uma mensagem e quando, também sem inscrição de push; nunca quem enviou nem o conteúdo), os tetos, a origem da chave e a base legal proposta.
- Documentos: `docs/protocol.md` (seção 11, "Push notice"; seção 3, "Push relay" e a rota `GET /account/push/key`; a linha da via de visitas), `docs/design.md` (Notificações e a linha de mensagens diretas da tabela LGPD), `docs/app.md` (limites das Conversas).

## Testes automatizados

Antes do commit, sobre `main` em 37026ea6: `npm run lint` limpo, `npm run demo` com "DEMO OK" e 409 arquivos de teste, cada um rodado sozinho (`node <arquivo>`, 6 em paralelo), todos passando: os arquivos de teste mudados e todos os que citam um módulo mudado. A suíte inteira roda na CI do GitHub. Os arquivos de teste desta mudança:

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/app/test/account.test.js` | 82/82 | 1366/1366 |
| `apps/app/test/dmNoticeKey.test.js` | 2/2 | 20/20 |
| `apps/app/test/inviteDrop.test.js` | 26/26 | 213/213 |
| `apps/app/test/legal.test.js` | 67/67 | 2010/2010 |
| `apps/app/test/push-state.test.js` | 25/25 | 258/258 |
| `apps/app/test/sw.test.js` | 101/101 | 1262/1262 |
| `apps/app/test/vitrine.test.js` | 55/55 | 4438/4438 |
| `apps/cli/test/account-push.test.js` | 58/58 | 1352/1352 |
| `apps/cli/test/push-e2e.test.js` | 2/2 | 84/84 |
| `apps/cli/test/push-relay.test.js` | 18/18 | 133/133 |
| `apps/cli/test/push-wake-key.test.js` | 3/3 | 57/57 |
| `apps/cli/test/seed-ops.test.js` | 16/16 | 220/220 |
| `apps/site/test/legal.test.js` | 7/7 | 115/115 |
| `packages/core/test/dm-notice-net.test.js` | 11/11 | 54/54 |
| `packages/core/test/dm-notice.test.js` | 13/13 | 65/65 |
| `packages/core/test/dm-session-refuse.test.js` | 2/2 | 58/58 |
| `packages/core/test/seeder-dm.test.js` | 17/17 | 191/191 |
| `packages/core/test/terms.test.js` | 8/8 | 126/126 |
| `packages/core/test/visit-lane.test.js` | 7/7 | 65/65 |
| `packages/rpc/test/methods.test.js` | 167/167 | 7877/7877 |
| `packages/web-member/test/core-dm-e2e.test.js` | 13/13 | 86/86 |
| `packages/web-member/test/dm-link.test.js` | 13/13 | 71/71 |
| `packages/web-member/test/dm.test.js` | 95/95 | 922/922 |

- `node apps/app/test/legal.test.js`: o teste novo da versão 93 confere as duas frases fixas, o que o serviço de conta fica sabendo (também sem inscrição), a origem da chave, os tetos, o aceite dos Termos 93, o que o serviço de push vê e a base legal proposta, e que nenhum dos dois documentos ainda fala em "pode haver uma mensagem nova". O digest do texto foi atualizado.
- `node apps/site/scripts/render-legal.js --check`: as páginas `apps/site/public/termos/` e `apps/site/public/privacidade/` estão em dia com `legal.js`.
- `packages/core/test/dm-wake.test.js` saiu junto com o aviso global antigo.
- As correções da revisão têm teste que falha sem elas: a janela de 15 min contada só quando um aviso entra na fila, o atraso sorteado por pessoa numa Página, o aviso de Página que não chega a quem deixou de administrá-la (ou a uma Página fechada) durante a espera, a chave de aviso de ordem pequena recusada ao lacrar, e o texto novo no aviso mostrado em silêncio com a janela em foco.

## No aparelho

Todas a fazer:

- Duas sessões web (A e B, contas diferentes, B com os avisos no aparelho ligados) contra um serviço de conta e um semeador locais, na DHT local, com o relé de push ligado (`VARANDA_PUSH_TOKEN`). A manda uma mensagem a B com a janela de B fechada: B recebe um aviso "Nova mensagem nas Conversas", em até cerca de um minuto; um toque abre as Conversas de B com a mensagem. A não recebe aviso.
- A manda uma segunda mensagem a B em menos de 15 min: nenhum aviso novo para B; a mensagem aparece no próximo `dm.pull` de B.
- Com a janela de B visível e em foco, uma mensagem de A: o aviso é mostrado em silêncio e fechado, e as Conversas de B recarregam no lugar.
- B administra uma Página e A escreve para ela: B recebe "Nova mensagem para uma página que você administra", também com a janela em foco; um toque abre a lista de Páginas de B.
- B ainda sem aceitar os Termos 93: nenhum aviso.
- Semeador antigo, sem o canal: a mensagem chega, nenhum aviso, nenhum erro na tela de A.
- Serviço de conta antigo, sem `wake` em `GET /account/push/key`: A não manda caixa, a mensagem chega normalmente.

## O que não foi conferido

- Nada acima foi feito num navegador nem num aparelho; esta parte (textos, Termos e documentos) foi conferida só pelos testes acima.
- Safari no iPhone (PWA instalado), Chrome no Android e Firefox não foram conferidos com o aviso novo.
- A rolagem da implantação (serviço de conta, semeadores, apps) não foi ensaiada.

## Limites conhecidos

- O serviço de conta fica sabendo que uma pessoa (ou os administradores de uma Página) recebeu uma mensagem e quando, mesmo sem inscrição de push; nunca quem enviou nem o conteúdo. O serviço de push do navegador vê o momento de cada aviso.
- O semeador não aprende nada novo sobre quem recebe: ele já sabia o grupo de cerca de 500 pessoas, e a caixa tem o mesmo tamanho para todos.
- Uma reação não manda caixa. O semeador fica sabendo, por haver ou não uma caixa logo depois de um envelope, que aquele envelope era uma mensagem e não uma reação (ou que veio de um cliente antigo ou sem a chave de aviso). Fechar isso exigiria caixas de despiste para as reações, uma mudança de desenho que fica para depois.
- Um aviso perdido (semeador sem o canal, tempo esgotado de 3 s, relé ou serviço fora do ar, fila cheia, teto) não é reenviado; a mensagem aparece no próximo `dm.pull`.
- O teto de um aviso por destinatário a cada 15 min pode esconder uma segunda mensagem dentro desse intervalo, até o próximo `dm.pull`.
- A janela de 15 min só é contada quando um aviso entra na fila: uma caixa para quem ainda não aceitou os Termos 93, não tem aparelho inscrito, não cabe na fila ou passou do teto por hora não segura o aviso seguinte.
- Quem tem selos pode lacrar uma caixa com a chave de qualquer pessoa ou Página e causar, a cada envelope novo que guarda, um aviso com a frase fixa, que também ocupa a janela de 15 min daquela chave. O serviço de conta não sabe quem enviou, então um bloqueio não vale para esses avisos. Cada aviso custa um selo.
- Com o arquivo de Páginas do serviço de conta ilegível, uma caixa com a chave de uma Página é tratada como de pessoa e não chega a ninguém; as mensagens para pessoas continuam avisando.
- Quem opera ao mesmo tempo o semeador e o serviço de conta (a associação) poderia cruzar, pelo momento, a conexão de onde veio o aviso (a de quem enviou) com quem recebe. O código só repassa a caixa e não registra nenhum dos dois; para isso seria preciso alterar o semeador ou o serviço.
- O app entrega a chave de aviso só a um nó hospedado (navegador e worklet nativo); um `varanda-serve` cujo cliente não chame `dm.noticeKey` não manda aviso.
- A entrega da chave em `App.js` é coberta por testes que leem o código-fonte, não por um teste que monta a tela.
- O app nativo ainda não tem avisos push: quem usa só o app nativo não recebe o aviso, mas o serviço de conta fica sabendo das mensagens que essa pessoa recebe de quem manda a caixa.
- Clientes antigos não mandam a caixa: as mensagens deles não geram aviso até atualizarem.
