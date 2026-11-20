# Descrição de grupos e comunidades pelo índice: verificação

## Testes executados

No Node.js, na cópia de trabalho local, com a DHT local dos testes. Cada arquivo rodou sozinho com `node <arquivo>`, a partir da raiz:

| Arquivo | Testes | Asserções |
|---|---|---|
| `packages/core/test/group-index.test.js` | 18 | 215 |
| `packages/core/test/seeder-groups.test.js` | 70 | 575 |
| `packages/core/test/seeder-link-public.test.js` | 8 | 177 |
| `packages/core/test/seeder-communities.test.js` | 10 | 66 |
| `apps/cli/test/seed-ws.test.js` | 115 | 2798 |
| `apps/cli/test/seed-ws-link.test.js` | 10 | 390 |
| `apps/cli/test/link-page.test.js` | 19 | 1134 |
| `apps/cli/test/caddyfile.test.js` | 27 | 388 |
| `apps/cli/test/changelog.test.js` | 9 | 42 |

`npx standard` passou nos arquivos de código alterados. A suíte completa roda na CI do GitHub.

O que os testes cobrem:

- Índice de grupos (`group-index.test.js`): numa raiz de comunidade ou de grupo público, a descrição é a do último `group-about`; um `group-about` com `null` a apaga; `resetRoot` e a perda do cabeçalho a esquecem; descrição que não é texto é recusada; a busca não muda. Uma raiz privada não guarda descrição, nem depois de o cabeçalho virar público.
- Varredura da raiz (`seeder-groups.test.js`): o registro só chega ao índice pelo filtro de bytes e de tipo de `_scanRoot`, e passa por `validateGroupRecord`. A palavra `group-about` dentro de uma publicação, um texto com espaços nas bordas e o registro de reparo de quem escreve na comunidade (CW) não entram. `groupAboutPublic` devolve `null` com a raiz ou o diário bloqueados, o cabeçalho não verificado, a raiz que o diário do cabeçalho não vinculou e a varredura atrasada. Um núcleo de escritor nunca é lido como raiz. `indexGroupAbouts` mantém a ordem pedida, uma linha por raiz, no máximo 32 chaves, e devolve uma lista vazia para entrada inválida, sem lançar erro.
- Grupos privados: uma raiz privada não guarda descrição, e um valor sentinela posto à força no índice de uma raiz privada não aparece em `groupAboutPublic` nem em `indexGroupAbouts`. No teste replicado, um `group-about` com sentinela anexado ao núcleo do grupo privado também não aparece.
- Prévia de link (`seeder-link-public.test.js`): `linkPublic` dos tipos `g` e `c` traz `about` (texto ou `null`), em memória e com núcleos replicados de verdade; a limpeza com `null` vale; grupo privado continua `null`.
- Rota e página de link (parte HTTP): `GET /index/group-about/<chave>(,<chave>){0,31}` responde como a rota de imagens, com `{ abouts: [{ group, about }], indexing }`; chave privada ou desconhecida fica de fora; chave repetida ou malformada é recusada. Em `/p/g/<chave>` e `/p/c/<chave>` de um grupo ou comunidade pública com descrição, ela vira `description`, `og:description` e o parágrafo da página, escapada e cortada em 200 caracteres; sem descrição, a página fica como antes. Grupo privado ou desconhecido recebe a página genérica, idêntica byte a byte.

## Conferência das regressões

- O filtro de tipo de `_scanRoot`: sem `'group-about'` na lista, o teste da varredura de descrições em `seeder-groups.test.js` falha; com a lista restaurada, os 70 testes passam.
- A rota: sem ela em `seed-ws.js`, os dois testes novos de `seed-ws.test.js` falham (113 de 115).
- A página de link: com a versão anterior de `link-page.js`, os dois testes novos de descrição em `link-page.test.js` falham (17 de 19), e `seed-ws-link.test.js` falha no portão de grupo privado e no teste de `og:description` (8 de 10).

## Verificações em dispositivos, não executadas

Não conferido com um semeador implantado nem num aparelho. Roteiro:

1. Num grupo público com descrição, abrir `https://<semeador>/index/group-about/<chave>`: a resposta traz a descrição.
2. Compartilhar o link do grupo ou da comunidade num aplicativo de mensagens: a prévia mostra a descrição.
3. Apagar a descrição e esperar a varredura: a rota deixa de trazer o grupo e a prévia volta a "Grupo na Varanda." (ou o texto da comunidade).
4. Num grupo privado, a rota não traz o grupo e o link mostra a página genérica.
5. Depois da implantação, `curl -A Twitterbot https://<domínio>/g/<chave>` de um grupo público com descrição traz `og:description` com ela.
6. No app, primeiro no simulador iOS e no emulador Android, depois na web: abrir sem participar uma comunidade e um grupo público com descrição, pelo índice e com a raiz já guardada no aparelho (grupo da própria comunidade). O cartão mostra a descrição sob "Descrição" no grupo e abaixo do nome na comunidade; um grupo privado não mostra nenhuma.

## Cartões de entrada no app

Cada arquivo rodou sozinho com `node <arquivo>`, a partir da raiz.

| Arquivo | Testes aprovados | Asserções aprovadas |
|---|---:|---:|
| `apps/app/test/indexClient.test.js` | 89 | 1780 |
| `apps/app/test/vitrineIndex.test.js` | 35 | 1999 |
| `apps/app/test/group-flow.test.js` | 94 | 777 |
| `apps/app/test/groups.test.js` | 41 | 607 |
| `apps/app/test/groupScreen.test.js` | 35 | 258 |
| `apps/app/test/vitrine.test.js` | 67 | 4858 |
| `apps/app/test/communityRows.test.js` | 6 | 40 |
| `apps/cli/test/changelog.test.js` | 9 | 42 |

`npx standard` passou nos arquivos JavaScript alterados no app.

O cliente aceita até 32 chaves e descarta a resposta inteira se uma linha trouxer uma chave de outro grupo, um campo extra ou uma descrição inválida. Se a rota responder 404 ou a consulta falhar, a descrição fica ausente. Na Vitrine, a rota devolve as descrições das comunidades e dos grupos públicos das amostras, na ordem pedida. Chaves inválidas ou repetidas são recusadas.

Retirar a validação de quebras de linha fez o teste do cliente falhar. Retirar o filtro de visibilidade da Vitrine fez o teste da rota falhar ao receber a descrição de um grupo privado. Os dois testes passaram com as proteções restauradas.

No grupo, a descrição vem de `outsideAbout` (`apps/app/src/groups.js`): do nó quando ele responde, só de grupo público, e do índice apenas quando o nó não conhece o grupo. Com o nó ignorado nesse auxiliar, o teste do cartão em `groupScreen.test.js` falha (34 de 35); restaurado, passa.
