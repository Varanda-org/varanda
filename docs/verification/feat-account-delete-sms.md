# Excluir conta sem a passkey (SMS)

Termos e Privacidade versão 84, sobre a 83 (o texto da cópia automática das conversas, da 83, continua igual e o teste dela continua passando). Os textos legais não citam contagens de SMS, então nenhuma foi acrescentada. Decisão da manutenção (opção A, "a operação confirma"): o código certo só registra um pedido; a exclusão é agendada pela operação depois que a pessoa escreve para contato@varanda.app, e os 7 dias contam a partir daí.

## Comportamento decidido

- O envio responde `200 { sent: true }` com os mesmos bytes quando o número bate ou não. Com o teto diário da exclusão (`min(50, VARANDA_PHONE_DAILY_LIMIT)`) cheio, o envio é pulado com a mesma resposta `200`, e só a linha de log `exclusao-teto-diario` mostra isso.
- Os limites da exclusão são próprios e nenhuma outra rota os lê: 3 por dia por par (membro, número), 3 por dia por número, 1 a cada 60 s. Um número pode receber, no mesmo dia, 3 SMS de verificação e 3 de exclusão.
- A conferência responde `codigo-invalido` em `SMS_CHECK_FLOOR_MS` (3000 ms) a toda recusa que dependa da conta, inclusive a falha, o tempo esgotado e a linha recusada do provedor; a chamada ao provedor tem o piso menos 500 ms. Corpo malformado responde na hora.
- Um código vale 5 minutos e até 3 tentativas; o serviço guarda o pedido por 10 minutos. Se a rota do SMS estiver fechada para a pessoa (os 3 envios do par ou as 3 tentativas de um código gastos, a zona do Caddy cheia, o provedor recusando o número), ela escreve para contato@varanda.app com o @nome.
- Só uma conferência que de fato compara um código gasta a janela por membro (10 conferências em 10 min). Um número que não é o do código pendente, nenhum código, um envio ainda não confirmado ou outra conferência em andamento não mudam nada: não gastam tentativa nem janela. Com a janela cheia, a resposta é a mesma `codigo-invalido` no piso.
- O provedor guarda um código por número e o `Retry` dele reenvia o código pendente. Por isso um envio de verificação para o número nos 5 minutos (mais os 5 s da chamada ao provedor) antes do envio de exclusão, durante ele ou depois dele, e um envio de exclusão nos primeiros 5 minutos (mais 5 s) depois que o serviço inicia, não registram pedido: a conferência responde `codigo-invalido` no piso sem consultar o provedor e sem gastar tentativa nem janela. Um envio de exclusão dentro dessa janela a estende pelos mesmos 5 minutos (mais 5 s), já que um `Retry` pode reiniciar a vida do código pendente; um envio de exclusão fora de toda janela não estende nada. A pessoa pede um novo código de exclusão mais tarde ou escreve para contato@varanda.app.
- Depois da aprovação, uma falha do armazenamento responde `503 indisponivel` e guarda o código aprovado para repetir.
- O código certo responde `200 { requested: true }` e só grava a linha do membro em `deletion-requests.json` (`{ v: 1, requests: { <chave>: <ms> } }`, modo 0600): nenhuma espera em `passkeys.json`, nenhum push, nada no status da conta. Um novo pedido atualiza a hora; um pedido com mais de 30 dias deixa de valer e a varredura de exclusão o apaga; a exclusão da conta apaga a linha; no máximo 4096 linhas, e a mais antiga sai com o log `pedidos-cheio`. Uma gravação que falha responde `503 indisponivel` (log `pedido-sms-incerto`) e guarda o código aprovado, então o mesmo código registra o pedido sem nova checagem no provedor. A caminho `agendada-sms` saiu.
- O SMS de exclusão manda `options.sms_sender_name: 'Varanda excluir conta'` ao provedor (lugar confirmado na documentação da Didit: dentro de `options`, 1 a 30 caracteres, letras, números, espaço e ' & - !); o envio da verificação não leva a chave, e o corpo dele não muda.
- App: depois do código certo, "Pedido registrado. Ainda falta um passo: escreva para contato@varanda.app com o seu @nome. Nada acontece antes disso. Depois que a equipe confirmar, a conta fica marcada para exclusão em 7 dias.". Um resultado incerto não é reenviado nem decidido pelo status (o pedido não aparece nele): a tela pede que a pessoa escreva do mesmo jeito.
- O aviso push de um agendamento vai só aos navegadores e aparelhos com os avisos ligados e pode não chegar; com a opção A, a operação fala com a pessoa antes de agendar.
- O provedor guarda um estado por número que a verificação do celular e a exclusão dividem (o código pendente, as tentativas, os 5 minutos, os envios por hora), e os envios e conferências da exclusão só o mudam quando o @nome e o número batem. Por isso as rotas de verificação (`/account/phone/send` e `/check`) não respondem a partir desse estado: uma pessoa cujo número recebeu códigos de exclusão na mesma hora não recebe SMS nem aviso ao pedir um código de verificação (o serviço responde como se o código tivesse sido enviado, `enviado`, e guarda o pedido como depois de um envio), e um código que o provedor recusou ou deu por vencido antes da janela de 5 minutos do próprio serviço conta como código errado (`codigo-invalido`, uma das 3 tentativas). Só o relógio do serviço, 5 minutos a partir do pedido de envio, e a terceira tentativa respondem `codigo-expirado`. O app não muda: "Código incorreto. Confira e tente de novo." e "Reenviar código" continuam na tela.
- App: a leitura do status ao voltar para o primeiro plano só zera o estado da exclusão quando muda o membro ou a instalação hospedada, só atualiza com uma resposta boa e não faz a inscrição de novo. A tela lê o status antes de enviar e, com a exclusão já agendada, mostra a data sem enviar código. Aberta pela tela de Entrar, qualquer saída fecha a folha; o passo final (o pedido registrado ou a data já agendada) tem "Fechar".
- App: só uma leitura boa do status segura a próxima por 10 minutos. Uma leitura que falhou (sem rede, 429) é tentada de novo no máximo uma vez por minuto, ao voltar para o primeiro plano, quando o nó volta a ficar online e num relógio enquanto o app está em primeiro plano (parado em segundo plano). Nunca duas leituras ao mesmo tempo para o mesmo membro.

## Feito

Cada arquivo rodou sozinho (`node <arquivo>`):

- `apps/cli/test/account-delete-sms.test.js`: 25/25, 366 asserções (rodada da opção A; a contagem abaixo descreve o que já existia). Mesmos bytes no envio para nome desconhecido, número errado, sem número, exclusão pendente, conta excluída, teto por par, janela por número e teto diário cheio (o caso de uma página não está nesse teste); janelas por número separadas da verificação; teto diário cheio pulado em silêncio com o log; 11 conferências com número errado seguidas do código certo registram o pedido; 12 conferências antes de o provedor confirmar o envio seguidas do código certo registram o pedido; linha recusada; piso de tempo (com envio e conferência atrasados no provedor falso); falha e tempo esgotado do provedor; envio incerto deixa o código pronto; janela por membro; conferência em andamento; conta excluída depois da aprovação; falha do armazenamento depois da aprovação guarda o código; nenhum log com número, código ou nome.
- `apps/app/test/accountDeletion.test.js` 20/20 (186 asserções) e `apps/app/test/account.test.js` 79/79 (1326 asserções) (429 cru da borda vira "Muitos pedidos agora. Tente de novo em uma hora.").
- Conferência de regressão: cada correção foi desfeita, o teste correspondente falhou, e a correção voltou.

| Correção desfeita | Teste que falhou |
|---|---|
| Piso de tempo da conferência | piso de tempo e tempo esgotado do provedor (21/23) |
| Falha do provedor como `codigo-invalido` | tempo esgotado do provedor |
| Janela por número própria | janelas por número separadas |
| Janela cobrada só depois de o envio estar confirmado | 12 conferências antes da confirmação seguidas do código certo (23/24) |
| Número errado sem mudar estado | número errado e 11 conferências seguidas do código certo |
| Janela por membro como `codigo-invalido` | janela por membro |
| Código guardado na falha do armazenamento | falha do armazenamento depois da aprovação |
| Estado mantido numa leitura que falha | `statusUpdate` (18/19) |
| Inscrição só na primeira leitura | `statusUpdate` |
| Saída fecha a folha aberta por Entrar | `ajustesTarget` |
| Status lido antes de enviar | `requestSmsCode` com exclusão agendada |
| Leitura que falhou tentada de novo em 1 min | `statusReadDue` |

- `apps/cli/test/account-phone.test.js`: 43/43, 512 asserções. Um `Declined` e um `Expired or Not Found` respondem `codigo-invalido`, guardam o pedido (a conferência seguinte chega ao provedor) e a terceira tentativa o descarta como os códigos errados; o pedido vence 5 minutos depois do pedido de envio, mesmo com o provedor demorando 10 s para responder, sem chamar o provedor; um 429 do provedor responde `200 { state: 'enviado' }`, segura o reenvio por 60 s, deixa a conferência seguinte chegar ao provedor e registra só `didit-envio-limite`; dois envios simultâneos que dividem o 429 respondem `enviado`. O teste antigo "provider refusals" esperava `limite-telefone` para o 429 e agora espera `enviado` (e avança 61 s antes do caso `Blocked`, que senão cairia na espera do reenvio).
- Conferência de regressão da verificação (`account-phone.test.js`): `expirado` respondendo `codigo-expirado` e descartando o pedido, 42/43; o 429 respondendo `limite-telefone`, 40/43; o pedido valendo 10 minutos, 42/43; o relógio começando depois da resposta do provedor, 42/43.
- O pulo silencioso do teto diário não teve conferência de regressão própria (a checagem antiga deixou de existir); o teste confere os mesmos bytes e nenhuma chamada ao provedor.
- `apps/cli/test/caddyfile.test.js`: a zona `/account/delete/sms/*` e seus limites.
- Opção A (`apps/cli/test/account-delete-sms.test.js`): o código certo responde `{ requested: true }`, grava a linha, não cria espera nem log de agendamento; um segundo código certo uma hora depois atualiza a hora; um armazenamento aberto de novo no mesmo diretório lê o pedido (reinício); antes de 30 dias o pedido vale e a varredura o mantém, depois de 30 dias não vale e a varredura o apaga do arquivo; uma gravação recusada responde `503 indisponivel` e o mesmo código registra o pedido com uma só checagem no provedor; a exclusão agendada pela operação (com e sem bloqueio) apaga a linha na purga; um pedido ao lado de uma espera assinada não muda a data, e o cancelamento não apaga o pedido; nas rotas isoladas, nenhum push (`notify`) e o envio com o remetente. Com `deletion-requests.json` ilegível, as duas rotas respondem `indisponivel` e nenhum código sai. Testes que esperavam agendamento e mudaram: o primeiro (agora "only file a request"), "checks with a wrong number", "a signed wait keeps its date" (agora "a request beside a signed wait"), "an uncertain write is retried" (agora a gravação do pedido, `indisponivel` em vez de `resultado-incerto`), os dois da varredura na data (agora com o agendamento da operação), "checks before the send is confirmed", o piso de tempo, "an uncertain provider send", e nas rotas isoladas "one push per schedule" (agora nenhum push), "a full check window", "one check in flight", "a deletion after the approval" e "a store failure after the approval".
- `apps/cli/test/deletion-requests.test.js` (novo): 4/4, 40 asserções: forma e modo do arquivo, leitura por um armazenamento novo, 30 dias e poda, `forget`, tabela cheia com o log fixo, guarda recusada e arquivo inválido ou link simbólico respondem `indisponivel` sem reescrever.
- `apps/cli/test/phone-client.test.js`: 14/14, 391 asserções: o remetente vai em `options.sms_sender_name` e não aparece sem ele; nomes que o provedor recusaria não saem.
- `apps/app/test/legal.test.js` 59/59 (os testes da versão 83 e da 84), `apps/site/test/legal.test.js` 7/7, `packages/core/test/terms.test.js` 8/8: o texto dos Termos (o código só registra um pedido) e da Privacidade (o pedido fica até 30 dias e sai na exclusão), sobre o texto da 83; o digest do texto foi recalculado sobre a 83 com as mudanças da 84.
- `apps/cli/test/account-delete-cli.test.js` 19/19: a prévia de `varanda account delete` mostra `pedido por SMS: <data> (<ISO>)` para um pedido dos últimos 30 dias, `pedido por SMS: nenhum nos últimos 30 dias` para um mais velho ou nenhum, o campo `smsRequest` no `--json`, roda com a trava do serviço tomada sem mudar o arquivo, e um `deletion-requests.json` inválido faz a prévia recusar. Com a linha e o campo desfeitos, o arquivo fica em 16/19.
- Conferência de regressão da opção A (cada correção desfeita sozinha, o arquivo de teste falhou, e voltou):

| Correção desfeita | Resultado |
|---|---|
| O código certo não grava o pedido | `account-delete-sms` 19/25 |
| O código certo volta a agendar e avisar | `account-delete-sms` 20/25 |
| Gravação que falha descarta o código aprovado | `account-delete-sms` 24/25 |
| A purga da exclusão não apaga a linha | `account-delete-sms` 23/25 |
| A varredura não poda | `account-delete-sms` 24/25 |
| Pedido velho ainda vale | `account-delete-sms` 24/25 |
| Novo pedido mantém a primeira hora | `account-delete-sms` 24/25 |
| O envio de exclusão sem remetente | `account-delete-sms` 22/25 |
| O cliente descarta o remetente | `phone-client` 13/14 |
| Tabela cheia continua crescendo | `deletion-requests` 3/4 |
| O armazenamento ignora a guarda | `deletion-requests` 3/4 |
| Arquivo de pedidos ilegível ainda manda código | `account-delete-sms` 24/25 |
| O app aceita a resposta antiga `{ scheduled }` | `account` 78/79 |
| O app diz que a exclusão foi agendada | `accountDeletion` 19/20 |
| Os Termos dizem que o código agenda | `legal` 56/58 |

## Não feito (conferir em aparelho)

- Android (build de debug) e simulador iOS: o link Excluir conta sem a passkey na tela de entrada, fora de Outras formas de entrar; a tela com os dois passos, a contagem de 60 s, o texto "Pedido registrado..." no fim e "Fechar", que volta para a tela de entrada.
- Web e PWA: a mesma tela; o aviso "Se não foi você, troque o celular em Ajustes > Trocar o celular." no cartão da exclusão agendada, só para quem pode trocar o celular.
- Volta do segundo plano: a exclusão agendada pela operação aparece no aparelho com a conta aberta (no máximo a cada 10 min), e sem rede o cartão continua.
- SMS real pelo provedor de verificação (com o remetente "Varanda excluir conta" no SMS de exclusão e o nome padrão no de verificação), o tempo do piso com o provedor real e o Caddy recarregado com a zona nova (o `caddy` não estava instalado; só o teste do Caddyfile rodou).
- O procedimento do operador com um pedido real (a prévia de `varanda account delete` mostrando o pedido, a mensagem para contato@varanda.app e o `--yes --force`) não foi percorrido num servidor; só os testes rodaram.
