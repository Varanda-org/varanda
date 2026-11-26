# Miniaturas de publicações, nós do navegador e nativo (branch feat/post-thumbs)

Parte da mudança que grava e lê `post-thumbs` (docs/protocol.md, seção 2, "Thumbnails"; docs/rpc.md 5.7, 5.13, 5.22, 5.27). Aqui, o que cabe ao nó: escrever, ler e apagar.

## Ordem de implantação

Semeadores e o serviço de contas precisam ser atualizados antes de qualquer build do app que grave miniaturas. Um semeador antigo não conhece o tipo `post-thumbs`, não conta os intervalos das miniaturas e não os libera quando a publicação é apagada; um build do app que grave miniaturas antes disso deixa bytes órfãos nele.

## O que mudou

- `post.create`, `post.reply` e `post.quote` (nó do navegador) aceitam `thumbs`: a lista é conferida antes de qualquer append (alinhada com `media`, ao menos uma entrada, JPEG, no máximo 640 por lado e 65536 bytes, em núcleo de mídia próprio declarado, bytes e lados conferidos, sem intervalo em comum com a mídia da publicação nem entre si). Uma lista ruim é recusada e nada é escrito; sem `thumbs` a escrita é a de antes. Não há repetição automática.
- A publicação e o `post-thumbs` entram num só append. O resultado traz `last` (último bloco) para o nó marcar o comprimento.
- Apagar uma publicação inclui a lista de miniaturas e seus intervalos (em até três lápides, no mesmo append); a repetição de um apagamento já feito apaga a lista que um escritor antigo deixou viva. Listas órfãs antigas não são varridas no nó do navegador, só no nativo.
- `feed.read` (os dois nós), `peek.read` e `diary.peek` aceitam `thumbs: true`. As listas vão das mais novas para as mais antigas enquanto a resposta inteira cabe em `MAX_MESSAGE`; linhas e cursores não mudam.
- `diary.peek`: o bloco P + 1 é pedido no mesmo lote de P e só vale como `post-thumbs` válido que nomeia P e tem o tamanho da mídia.

## Testes

- `packages/web-member/test/session-media.test.js`: um append com os dois registros, sete recusas que não escrevem nada, `feed.read` com e sem `thumbs`, apagar libera os dois.
- `packages/web-member/test/delete.test.js`: dez fotos e dez miniaturas, seis lápides num append; repetição que apaga a lista deixada por escritor antigo.
- `packages/web-member/test/diary-peek.test.js`: semeador real, `thumbs: true` devolve a lista verificada, publicação antiga, companheira que nomeia outra publicação e lista de tamanho errado ficam sem.
- `packages/web-member/test/peek.test.js`: `peek.read` com e sem `thumbs`.
- `packages/core/test/delete-session.test.js`: `feed.read` do nó nativo pelo despachante, com e sem `thumbs`.

## Limites

- A lógica de caber em `MAX_MESSAGE` está nos dois nós (`fitThumbs`) e não tem teste com uma página cheia de listas maximais; o teste de tamanhos de `packages/rpc` cobre só o cálculo do envelope.
- O pedido do bloco P + 1 espera o mesmo prazo da espiada: um bloco que o semeador nunca entrega atrasa a resposta até o prazo.
