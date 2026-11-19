# Transporte de avisos nativos (branch feat/native-push-transport)

## O que muda

- T27 documenta o contrato do serviço implementado por T26: descoberta de APNs e FCM, cadastro e remoção com prova `varanda-push-device-v1`, consulta de registro e seleção de transporte em `/account/push/start`. A prova e o RPC `pushDevice.sign` (5.169) já existiam.
- Até quatro registros nativos por membro em `push-devices.json`, com rotação na mesma chave. Somente `dm`, `dm-page`, `group` e `group-private`, com frase visível fixa ou nome público, dados `k` e `t` e tag própria do aparelho para agrupamento. Sem remetente, texto de mensagem ou nome de grupo privado.
- APNs por HTTP/2 com ES256 e FCM HTTP v1 com token OAuth reaproveitado. Configuração ausente desliga o transporte; configuração parcial impede iniciar. APNs 410 `Unregistered` e FCM 404 `UNREGISTERED` removem só o registro correspondente; não há repetição automática. Exclusão da conta remove seus registros nativos.
- Termos e Política de Privacidade na versão 101, data 19/11/2026, com novo aceite, digest atualizado e páginas do site regeneradas. Os acréscimos descrevem dados recebidos por Apple e Google, retenção e base legal proposta, a confirmar em parecer jurídico. O envio exige aceite 101 ou posterior; o cadastro exige a versão corrente.
- Acréscimos em `docs/protocol.md`, `docs/design.md` e `docs/development.md`, preservando todas as linhas anteriores. A opção de ligar os avisos no app fica para `feat/app-native-push`.

## Testes automatizados

Resultados locais de T27 em Node v26.12.1. A tabela de aterrissagem fica aberta para a revisão conjunta com T26; um resultado local de documentação não valida as rotas ou os transportes.

| Verificação local T27 | Testes | Asserções | Resultado |
|---|---|---|---|
| `node apps/app/test/legal.test.js` | 74/74 | 2351/2351 | Passou |
| `node apps/site/test/legal.test.js` | 7/7 | 115/115 | Passou |
| `node packages/core/test/terms.test.js` | 8/8 | 126/126 | Passou |
| `node apps/app/test/terms-version.test.js` | 0/1 | 1/2 | Falhou duas vezes: dependência aponta para outro checkout, com versão 100 |
| Mesmo teste com resolução temporária para o core desta cópia | 1/1 | 2/2 | Passou; ver procedimento abaixo |
| `node apps/site/scripts/render-legal.js --check` | Não se aplica | Não se aplica | Passou |
| `XDG_CACHE_HOME=/tmp/t27-standard-cache npm run lint` | Não se aplica | Não se aplica | Passou |
| `git diff --check`, preservação das linhas anteriores e ausência de U+2014 nos acréscimos | Não se aplica | Não se aplica | Passou |

O primeiro teste legal isolado falhou apenas no digest antigo: 73/74 testes e 2350/2351 asserções. Saída: `actual: ccc96904a5d8a43938a7f61f4bbb3f269ed4eafded6852a89beed1a60ac70487`, `expected: 43326cda81ed5471aa52b35c311a44250ae21e1c65c7ecabccc185bfb6ba7c74`. O digest foi atualizado com esse `actual`, e a execução seguinte passou. Ao restaurar temporariamente o `legal.js` da base, o novo teste `legal: version 101 describes native device notices` e a fixação da versão falharam: 72/74 testes e 2274/2311 asserções. O arquivo atualizado foi restaurado antes da execução final.

Nesta cópia privada, `node_modules` é um link para outro checkout. `require.resolve('@varanda/core/lib/terms')` alcança o core daquele checkout, ainda na versão 100. O comando direto de `terms-version.test.js` e sua repetição isolada falharam igualmente: `actual: 101`, `expected: 100`, 0/1 teste e 1/2 asserções. Para conferir os arquivos entregues sem alterar dependências ou testes, um preload temporário em `/tmp/t27-local-terms.cjs` redirecionou só essa entrada do cache CommonJS para `packages/core/lib/terms.js` desta cópia:

```js
const modulePath = require.resolve('@varanda/core/lib/terms', { paths: [process.cwd()] })
const localPath = process.cwd() + '/packages/core/lib/terms.js'
require(localPath)
require.cache[modulePath] = require.cache[localPath]
```

`node --require /tmp/t27-local-terms.cjs apps/app/test/terms-version.test.js` passou, 1/1 teste e 2/2 asserções. O comando direto ainda deve ser repetido na aterrissagem com os workspaces apontando para a mesma árvore. O Node emitiu `MODULE_TYPELESS_PACKAGE_JSON` ao importar `legal.js`, sem impedir os demais testes ou a renderização. As duas páginas foram escritas somente por `node apps/site/scripts/render-legal.js`.

| Verificação na aterrissagem com T26 | Testes / asserções | Resultado |
|---|---|---|
| Rotas e armazenamento nativo, prova, rotação, limite de quatro e exclusão da conta | A preencher | Pendente |
| APNs e FCM com substitutos locais: payload, tag, autenticação, `gone` e ausência de reenvio | A preencher | Pendente |
| Configuração ausente, parcial, APNs apenas e FCM apenas; aceite anterior a 101 e cadastro com Termos pendentes | A preencher | Pendente |
| Regressões de Web Push, avisos sociais, convites e sinais de leitura | A preencher | Pendente |
| `npm run lint` | A preencher | Pendente |
| `npm test` ou `npm test -- --affected=origin/main` | A preencher | Pendente |
| `npm run demo` | A preencher | Pendente |

## No aparelho

- Devido: entrega real APNs em iPhone, com chave `.p8`, equipe, topic e ambiente do build fornecidos pelo operador. Conferir cada frase, agrupamento pela tag, rotação do token e remoção de token inválido.
- Devido: entrega real FCM em Android, com conta de serviço do operador e build do mesmo projeto Firebase. Conferir as mesmas frases, agrupamento, rotação e remoção de token inválido.
- Devido: com a integração de `feat/app-native-push`, ligar e desligar os avisos, conferir o aceite 101, quatro aparelhos, exclusão da conta e ausência de remetente, texto ou nome privado em tela bloqueada. Conferir o nome utilizável e o fallback do grupo público.
- Devido: após os aparelhos, conferir o Web Push no navegador e no PWA. Não registrar tokens, chaves ou conteúdo pessoal como evidência.

## O que não foi conferido

- T27 não implementa nem executa as rotas de T26. Os resultados de integração e da suíte conjunta devem ser preenchidos na aterrissagem.
- `npm test`, a seleção por `--affected=origin/main` e `npm run demo` não foram executados nesta tarefa de documentação. A suíte completa, a demo e os testes em Node 20 e 24 ficam devidos na aterrissagem.
- Nenhuma entrega real APNs ou FCM, nenhum aparelho Android ou iOS e nenhum navegador/PWA foram conferidos. Os segredos do operador não foram acessados. Não houve teste em rede externa.

## Limites conhecidos

- Esta entrega prepara o serviço, desligado sem configuração. A ativação no app instalado é trabalho do próximo PR, `feat/app-native-push`.
- A Apple ou o Google vê o token, o momento, a frase fixa ou o nome do grupo público, o tipo e a tag própria do aparelho. O alerta nativo não tem a cifragem de conteúdo do Web Push. A base legal e o mecanismo da transferência internacional ainda dependem de parecer jurídico.
- Resposta de sucesso do provedor não comprova exibição no aparelho. Um aviso perdido não é reenviado. Apenas os códigos de token inválido previstos removem a linha correspondente.
- Avisos sociais, convites e sinais `seen-sync` não são enviados aos registros nativos. O fechamento de avisos no sistema pelo app nativo continua fora desta entrega.
