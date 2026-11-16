# Conferência de palavras no serviço de conta (branch fix/word-check-leftovers)

Fecha as sobras da issue #449 (seções 138 e 143 de `docs/verification.md` e `docs/verification/fix-conferencia-palavras-sobras.md`). Decisões de Rodrigo, 16/11/2026:

- **@nome:** o serviço de conta recusa um @nome NOVO com um termo da lista, de membro (vínculo e troca) e de Página (criação e troca), com `nome-invalido`, o token que todo build do app já traduz ("Esse @nome não vale"). Um @nome já emitido fica: o diretório relê nomes antigos sem conferir, a mudança de chave da Página o mantém, e a troca de um membro para o nome que já tem continua sem efeito.
- **App modificado, build antigo e CLI:** o serviço confere o que uma Página publica por ele: nome e bio na criação, publicação, resposta, citação, perfil, anúncio e edição de anúncio (título, texto, cidade e bairro) e mensagem em grupo público, com `termo-recusado` (400), sem gravar nada. O app e a CLI traduzem o token. Publicações de membro são escritas no aparelho e não passam pelo serviço: ficam só com a conferência do app, e a denúncia e a lista assinada respondem pelo resto. O semeador e o protocolo continuam sem a lista.
- **Fotos e áudio:** limite aceito; a detecção de mídia ilegal depende das listas de hashes e do fluxo com SaferNet e Polícia Federal (issue #79).

Os dois itens que já estavam resolvidos pela #652 (números colados como `termo123` e a prévia de link) não mudam. A conferência da prévia passou a ler o cartão que o envio usa no PR #668.

Como foi feito:

- A lista (`packages/rpc/lib/blocked-terms.js`, antes `apps/app/src/blockedTerms.js`) e a regra (`packages/rpc/lib/word-check.js`, `termInTokens`) ficam em `@varanda/rpc`, que o Metro alcança. A dobra continua de cada lado: `wholeTokens` do app (`apps/app/src/search.js`) e o novo `wholeTokens` de `packages/core/lib/search-text.js`, presos um ao outro pelo teste de paridade de `apps/app/test/search.test.js`.
- O serviço usa `apps/cli/lib/account/word-check.js` em `store.js` (`validName`), `pages-routes.js` e `pages-groups.js`. O log da recusa é o de sempre: `refused` com o token no vínculo e na troca de @nome de membro, e `pagina` com a ação e o token numa Página. Sem chave, nome, texto ou termo.
- Termos e Política na versão 65: o parágrafo de conduta dos Termos e a seção Páginas da Política dizem o que o serviço confere e que não guarda o texto recusado.

Como verificar, a partir da raiz:

- `node packages/rpc/test/word-check.test.js` (novo: regra, lista dobrada e sem dependências).
- `node packages/core/test/search-text.test.js` e `node apps/app/test/search.test.js` (`wholeTokens` e a paridade).
- `node apps/cli/test/account.test.js`: "rename: cooldown, ..." recusa um termo da lista já no início da troca de @nome de membro, antes de qualquer assinatura.
- `node apps/cli/test/page-directory.test.js`: "a new @nome with a listed term is refused for pages and people" e "an @nome held before the word check keeps working". Sem a conferência no serviço (`findTerm` devolvendo `null`), os dois falham; sem a troca de ordem em `renamePage`, o segundo falha.
- `node apps/cli/test/account-pages.test.js`: "the word check refuses a new @nome and what a page publishes with a listed term". Sem a conferência, o teste quebra.
- `node apps/cli/test/account-pages-groups.test.js`: a mensagem em grupo público com um termo recebe `termo-recusado`. Sem a conferência, falha.
- `node apps/app/test/wordCheck.test.js`, `node apps/app/test/pages.test.js`, `node apps/cli/test/page-cli.test.js`, `node apps/app/test/legal.test.js`, `node apps/site/test/legal.test.js`, `node packages/core/test/terms.test.js`.
- `npm run lint`, `npm test -- --affected=origin/main` e `npm run demo`.

Caminhada no build de debug (Android 5556, simulador iOS iPhone 17 Pro e web em `http://localhost:8102/`), sem conta:

- [ ] O app abre e mostra os Termos na versão 65, com a frase sobre o serviço de conta no parágrafo de conduta e o parágrafo novo em Páginas na Política.
- [ ] A conferência no aparelho continua: no rascunho de Publicar (ou onde a tela for alcançável sem conta), um termo da lista mostra a recusa.

Fica para a instalação da associação, com conta (o build de debug não entra com passkey numa instalação de produção; veja a issue #224):

- [ ] Depois de implantar o serviço `account`: escolher no vínculo, ou trocar para, um @nome com um termo da lista por um cliente que pule a conferência do app (CLI ou `curl` com pedido assinado) recebe `nome-invalido`. Um @nome já existente continua resolvendo.
- [ ] Criar uma Página com um termo no @nome, no nome ou na bio, e publicar como Página (publicação, resposta, citação, perfil, anúncio, mensagem em grupo público) com um termo pela CLI (`varanda page ...`): recusa `termo-recusado`, com a mensagem em pt-BR, e nada entra no diário da página.
- [ ] No app, uma recusa do serviço numa Página mostra "Não dá para publicar: o texto tem um termo que o Varanda não permite em conteúdo público."
- [ ] O log do serviço mostra só `{"event":"pagina","action":"post","reason":"termo-recusado"}` numa Página e `{"event":"refused","reason":"nome-invalido"}` no @nome de membro, sem nome ou texto.

Limites:

- Publicações de membro feitas por app modificado, build antigo ou CLI não passam por conferência nenhuma (decisão acima). O semeador e as regras do protocolo não leem palavras, de propósito.
- Fotos, vídeos e áudio não são lidos (issue #79).
- Grafias trocadas e números no meio da palavra (uma letra trocada por um número) passam.
- Uma troca de @nome de Página para o próprio nome, quando esse nome tem um termo, é recusada na rota (`nome-invalido`) antes de chegar ao diretório. Não muda nada para quem já tem o nome.
- Uma escrita de Página recusada pela conferência gasta uma operação da cota da página, como as outras recusas de conteúdo (`pedido-invalido`), e nada entra no diário.
- Revisão por IA de um só fornecedor (Claude): codex e grok estavam sem cota.
