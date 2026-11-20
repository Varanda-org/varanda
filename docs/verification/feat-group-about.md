# Descrições de grupos e comunidades

## Escopo do PR

- `group.about` e `community.about` aceitam uma linha de até 280 pontos de código Unicode ou `null` para limpar. `group.info` e `community.info` devolvem o texto atual. A raiz controla a escrita. No reparo da comunidade, a gravação passa pelo escritor autorizado de quem criou. Uma descrição igual à atual dispensa uma nova gravação.
- `group-about` público é um registro lateral. Confira que o nome, a entrada, os membros, as publicações, a ordem causal, o `last` e a prévia de avisos continuam seguindo seus próprios registros. Com leitores antigos, confira também a espera por um bloco conhecido quando uma chave depende de um comprimento ou de uma base que aponta para uma descrição no fim do núcleo.
- Em um grupo privado, o registro viaja lacrado e só é aberto com a chave da época. Confira grupo sem chave, troca de chave, leitura por cliente antigo e limpeza da descrição. Um cliente antigo mantém o envelope na ordem causal e o conta como mensagem cifrada. Limpar deixa de mostrar o texto atual, e os registros anteriores continuam nos núcleos.
- O índice do semeador usa descrições públicas de raízes verificadas e vinculadas. Confira a atualização após troca, limpeza e reindexação, e as respostas para chaves privadas, bloqueadas ou desconhecidas. Confira o limite de 32 chaves do índice, a resposta com um semeador antigo e a ausência do texto privado em resultados públicos e prévias de link.
- No app, a descrição é exibida abaixo do nome em **Ajustes do grupo** e **Informações da comunidade**, e em até duas linhas na tela da comunidade. O controle é condicionado ao papel, à autoridade do aparelho e à presença de `about` nas informações. A Vitrine inclui exemplos preenchidos e responde aos dois métodos de gravação.
- Os Termos de Uso e a Política de Privacidade da versão 108 devem descrever a exposição pública e a cifra no grupo privado. Na integração, confira `TERMS_VERSION`, `LEGAL_VERSION`, os textos publicados no site, o digest dos textos e o pedido de novo aceite para quem aceitou a versão 107.

## Testes executados nesta tarefa

Node.js 26.12.1, um arquivo por vez a partir da raiz.

| Comando | Testes | Asserções |
| --- | ---: | ---: |
| `node apps/app/test/groupEdit.test.js` | 12/12 | 54/54 |
| `node apps/app/test/groups.test.js` | 39/39 | 586/586 |
| `node apps/app/test/group-flow.test.js` | 94/94 | 776/776 |
| `node apps/app/test/vitrine.test.js` | 67/67 | 4858/4858 |
| `node apps/app/test/wordCheck.test.js` | 22/22 | 873/873 |
| `node apps/app/test/chatSurfaces.test.js` | 13/13 | 200/200 |
| `node apps/app/test/communityRows.test.js` | 6/6 | 40/40 |
| `node apps/cli/test/changelog.test.js` | 9/9 | 42/42 |

O `npx standard` passou nos sete arquivos JavaScript alterados, e `npm run lint` passou no monorepo, com o cache em diretório temporário. A primeira execução tentou gravar no cache da conta e recebeu `EPERM`. A demo parou com `operation not permitted` em `UDXSocket.bind`, ao abrir a DHT local em `127.0.0.1`.

## Conferência das regressões

- Aceitando todo rascunho em `aboutReady`, `groupEdit.test.js` ficou com 10 de 12 testes e 43 de 54 asserções aprovados. Os testes pegaram texto igual, excesso de pontos de código e quebra de linha.
- Tirando `about` do caminho de releitura de `group.info`, `groupEdit.test.js` ficou com 11 de 12 testes e 50 de 54 asserções aprovados. O cenário de resposta incerta exige exatamente uma escrita, seguida da leitura de `group.info`, e confirma a descrição a partir dessa resposta.
- Trocando a comparação do resultado para sempre retornar `unknown`, `groups.test.js` ficou com 38 de 39 testes e 581 de 586 asserções aprovados. O teste diferencia texto salvo, texto diferente, limpeza e nó antigo.

## Verificações de integração e em dispositivos

Os testes da tabela cobrem a tarefa do app. Os testes do protocolo, dos nós, do semeador e dos Termos devem ser conferidos na integração das demais tarefas. O roteiro visual abaixo ainda não foi executado. Comece pelo Android e pelo simulador iOS, depois confira web e PWA, com instalação de teste e DHT local.

1. No aparelho que criou, abra **Descrição** nos ajustes de um grupo e no painel **Ajustes** da comunidade. Salve, confirme o preenchimento, edite e apague o texto. Em uma comunidade em reparo, confirme a mesma sequência.
2. Confira a exibição como integrante, administrador e visitante quando o texto estiver disponível. No segundo aparelho de quem criou, como outro papel e com um nó que omite `about`, confira a ausência do campo. Em um grupo privado, confirme que a descrição só aparece com acesso ao texto cifrado.
3. Cole 280 caracteres de um ponto de código cada, incluindo emoji. Acrescente mais um e confira **No máximo 280 caracteres.** Confira a rejeição de uma quebra de linha e de um termo recusado em grupo público e comunidade. Em grupo privado, confira que a lista de termos públicos fica fora do caminho.
4. Simule uma gravação que chegou ao nó, com a resposta perdida. Nos ajustes do grupo, observe a releitura e a confirmação do texto. Nos ajustes da comunidade, confira o mesmo aviso e a mesma releitura de **Renomear**. Nos dois casos, conte uma só gravação.
