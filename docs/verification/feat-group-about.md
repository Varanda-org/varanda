# Descrições de grupos e comunidades

## Escopo do PR

- `group.about` e `community.about` aceitam uma linha de até 280 pontos de código Unicode ou `null` para limpar. `group.info` e `community.info` devolvem o texto atual. A raiz controla a escrita. No reparo da comunidade, a gravação passa pelo escritor autorizado de quem criou. Uma descrição igual à atual dispensa uma nova gravação.
- `group-about` público é um registro lateral. Confira que o nome, a entrada, os membros, as publicações, a ordem causal, o `last` e a prévia de avisos continuam seguindo seus próprios registros. Com leitores antigos, confira também a espera por um bloco conhecido quando uma chave depende de um comprimento ou de uma base que aponta para uma descrição no fim do núcleo.
- Em um grupo privado, o registro viaja lacrado e só é aberto com a chave da época. Confira grupo sem chave, troca de chave, leitura por cliente antigo e limpeza da descrição. Um cliente antigo mantém o envelope na ordem causal e o conta como mensagem cifrada. Limpar deixa de mostrar o texto atual, e os registros anteriores continuam nos núcleos.
- O índice do semeador e a prévia de link com a descrição ficam no PR seguinte, com a verificação em `docs/verification/feat-group-about-index.md`.
- No app, a descrição é exibida abaixo do nome em **Ajustes do grupo** e **Informações da comunidade**, e em até duas linhas na tela da comunidade. O controle é condicionado ao papel, à autoridade do aparelho e à presença de `about` nas informações. A Vitrine inclui exemplos preenchidos e responde aos dois métodos de gravação.
- Os Termos de Uso e a Política de Privacidade da versão 109 devem descrever a exposição pública e a cifra no grupo privado. Na integração, confira `TERMS_VERSION`, `LEGAL_VERSION`, os textos publicados no site, o digest dos textos e o pedido de novo aceite para quem aceitou a versão 108.

## Testes executados

Node.js 24, a partir da raiz: `npm run lint`, os 378 arquivos de teste que tocam ou importam um arquivo alterado (cada um com `node <arquivo>`, quatro por vez), `node apps/site/scripts/render-legal.js --check` e `npm run demo` (terminou com `DEMO OK`). Todos passaram: 6814 testes e 121725 asserções. A suíte completa roda na CI do GitHub.

| Comando | Testes | Asserções |
| --- | ---: | ---: |
| `node packages/core/test/group.test.js` | 166/166 | 1425/1425 |
| `node packages/core/test/group-private.test.js` | 140/140 | 1067/1067 |
| `node packages/core/test/community-fold.test.js` | 131/131 | 1203/1203 |
| `node packages/core/test/group-notice.test.js` | 51/51 | 706/706 |
| `node packages/core/test/records.test.js` | 75/75 | 2012/2012 |
| `node packages/core/test/session-groups.test.js` | 19/19 | 693/693 |
| `node packages/core/test/terms.test.js` | 8/8 | 126/126 |
| `node packages/rpc/test/methods.test.js` | 178/178 | 8400/8400 |
| `node packages/web-member/test/group-ops.test.js` | 68/68 | 547/547 |
| `node packages/web-member/test/community-ops.test.js` | 80/80 | 628/628 |
| `node packages/web-member/test/private-ops.test.js` | 32/32 | 346/346 |
| `node packages/web-member/test/session-groups.test.js` | 26/26 | 257/257 |
| `node apps/app/test/groupEdit.test.js` | 13/13 | 70/70 |
| `node apps/app/test/groups.test.js` | 39/39 | 586/586 |
| `node apps/app/test/vitrine.test.js` | 67/67 | 4858/4858 |
| `node apps/app/test/legal.test.js` | 77/77 | 2484/2484 |
| `node apps/site/test/legal.test.js` | 7/7 | 115/115 |

## Conferência das regressões

- Na primeira versão da tarefa, aceitando todo rascunho em `aboutReady`, `groupEdit.test.js` ficou com 10 de 12 testes e 43 de 54 asserções aprovados. Os testes pegaram texto igual, excesso de pontos de código e quebra de linha.
- Depois da revisão, `aboutReady` aplica a regra completa de caracteres. Revertendo essa regra, `groupEdit.test.js` ficou com 61 de 70 asserções aprovadas.
- Tirando `about` do caminho de releitura de `group.info`, `groupEdit.test.js` ficou com 11 de 12 testes e 50 de 54 asserções aprovados. O cenário de resposta incerta exige exatamente uma escrita, seguida da leitura de `group.info`, e confirma a descrição a partir dessa resposta.
- Trocando a comparação do resultado para sempre retornar `unknown`, `groups.test.js` ficou com 38 de 39 testes e 581 de 586 asserções aprovados. O teste diferencia texto salvo, texto diferente, limpeza e nó antigo.

## Verificações de integração e em dispositivos

O roteiro visual abaixo ainda não foi executado. Comece pelo Android e pelo simulador iOS, depois confira web e PWA, com instalação de teste e DHT local.

1. No aparelho que criou, abra **Descrição** nos ajustes de um grupo e no painel **Ajustes** da comunidade. Salve, confirme o preenchimento, edite e apague o texto. Em uma comunidade em reparo, confirme a mesma sequência.
2. Confira a exibição como integrante, administrador e visitante quando o texto estiver disponível. No segundo aparelho de quem criou, como outro papel e com um nó que omite `about`, confira a ausência do campo. Em um grupo privado, confirme que a descrição só aparece com acesso ao texto cifrado.
3. Cole 280 caracteres de um ponto de código cada, incluindo emoji. Acrescente mais um e confira **No máximo 280 caracteres.** Confira a rejeição de uma quebra de linha e de um termo recusado em grupo público e comunidade. Em grupo privado, confira que a lista de termos públicos fica fora do caminho.
4. Simule uma gravação que chegou ao nó, com a resposta perdida. Nos ajustes do grupo, observe a releitura e a confirmação do texto. Nos ajustes da comunidade, confira o mesmo aviso e a mesma releitura de **Renomear**. Nos dois casos, conte uma só gravação.
