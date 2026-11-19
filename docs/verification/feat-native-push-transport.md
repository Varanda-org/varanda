# Transporte de avisos nativos (branch feat/native-push-transport)

## O que muda

- O serviço de conta ganha as rotas `/account/push/device/info`, `/device/finish` e `/device/check`: descoberta de APNs e FCM, cadastro e remoção com a prova `varanda-push-device-v1` (RPC `pushDevice.sign`, 5.170) e consulta de registro. `/account/push/start` aceita `transport` para a prova nativa.
- Até quatro registros nativos por membro em `push-devices.json`; o quinto aparelho tira o mais antigo, e a rotação do token com a mesma chave atualiza a linha. Um token guardado para outro membro só muda de dono com a mesma chave do aparelho; outra chave recebe `pedido-invalido`.
- Só `dm`, `dm-page`, `group` e `group-private` vão para aparelhos nativos, com frase fixa ou nome do grupo público, dados `k` e `t` e tag própria do aparelho. Sem remetente, texto de mensagem, nome de grupo privado ou título.
- APNs por HTTP/2 com ES256; FCM HTTP v1 com uma troca OAuth compartilhada e uma conexão. APNs 410 `Unregistered` e FCM 404 `UNREGISTERED` removem só a linha exata para a qual o aviso foi enviado. Nenhum aviso é reenviado.
- Configuração ausente ou vazia desliga o transporte; configuração parcial impede o serviço de iniciar. `compose.web.yaml` repassa as seis variáveis. Desligar e consultar funcionam com o transporte desligado. Sem Web Push, `/account/push/key` entrega só a chave `wake` e convites não reservam vaga.
- A exclusão da conta apaga os registros nativos. Termos e Política de Privacidade na versão 101, com novo aceite; o envio exige aceite 101 ou posterior.

## Testes automatizados

Aterrissagem em `cbcdb93f`, Node 24, local: `npm run lint` passou; os 325 arquivos de teste alcançados pelo diff contra `origin/main` passaram, cada um sozinho; `npm run demo` terminou com `DEMO OK`. Os arquivos de teste que este PR mudou:

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/app/test/legal.test.js` | 74/74 | 2351/2351 |
| `apps/cli/test/account-delete.test.js` | 34/34 | 281/281 |
| `apps/cli/test/account-push-device.test.js` | 25/25 | 172/172 |
| `apps/cli/test/apns.test.js` | 11/11 | 129/129 |
| `apps/cli/test/cli.test.js` | 11/11 | 1428/1428 |
| `apps/cli/test/deploy.test.js` | 66/66 | 916/916 |
| `apps/cli/test/fcm.test.js` | 12/12 | 145/145 |
| `apps/cli/test/push-device-store.test.js` | 32/32 | 1677/1677 |
| `apps/site/test/legal.test.js` | 7/7 | 115/115 |
| `packages/core/test/push-device-proof.test.js` | 9/9 | 266/266 |
| `packages/core/test/session.test.js` | 47/47 | 481/481 |
| `packages/core/test/terms.test.js` | 8/8 | 126/126 |
| `packages/rpc/test/methods.test.js` | 170/170 | 8058/8058 |
| `packages/web-member/test/session.test.js` | 89/89 | 858/858 |

Regressões conferidas removendo a correção: os testes da troca de dono de um token com outra chave de aparelho e da resposta `gone` atrasada que apagava uma linha mais nova falham sem ela.

## No aparelho

- Devido: entrega real APNs em iPhone, com chave `.p8`, equipe, topic e ambiente do build fornecidos pelo operador. Conferir cada frase, agrupamento pela tag, rotação do token e remoção de token inválido.
- Devido: entrega real FCM em Android, com conta de serviço do operador e build do mesmo projeto Firebase. Conferir as mesmas frases, agrupamento, rotação e remoção de token inválido.
- Devido: com `feat/app-native-push`, ligar e desligar os avisos, conferir o aceite 101, quatro aparelhos, a troca de conta no mesmo aparelho, exclusão da conta e ausência de remetente, texto ou nome privado na tela bloqueada.
- Devido: depois dos aparelhos, conferir o Web Push no navegador e no PWA. Não registrar tokens, chaves ou conteúdo pessoal como evidência.

## O que não foi conferido

- Nenhuma entrega real APNs ou FCM, nenhum aparelho e nenhum navegador ou PWA. Os testes usam substitutos locais dos provedores. Os segredos do operador não foram acessados. Não houve teste em rede externa.
- A suíte completa roda na CI do GitHub, em Node 20 e 24.

## Limites conhecidos

- O serviço vem desligado sem configuração. O app instalado passa a usá-lo em `feat/app-native-push`.
- Apple ou Google veem o token, o momento, a frase fixa ou o nome do grupo público, o tipo e a tag. O alerta nativo não tem a cifragem de conteúdo do Web Push. Base legal e transferência internacional dependem de parecer jurídico.
- Um membro com nó do core (CLI e `varanda-serve`) não cadastra aparelho: a chave do diário no core não é a chave que assina, e `pushDevice.sign` recusa ali com `USAGE`, como `push.sign` e `age.sign`. O plano previa as duas sessões; isso pede uma mudança de contrato.
- Resposta de sucesso do provedor não comprova exibição no aparelho. Um aviso perdido não é reenviado.
- Avisos sociais, convites e sinais `seen-sync` não vão para aparelhos nativos.
