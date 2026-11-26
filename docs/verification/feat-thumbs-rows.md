# Verificação: feat/thumbs-rows

Miniaturas nas linhas de publicação e nomes em lote nas telas.

## Testes direcionados (`cd apps/app && node test/<arquivo>`)

- `mediaVariant`: escolha entre miniatura e tamanho inteiro, limites do leitor (JPEG, 640 px, 65536 bytes, exatos aceitos), GIF e vídeo sem miniatura, a miniatura por baixo acima de 640 px físicos, a máquina de passos (erro no passo 0 vai ao 1, no último fica, chave nova recomeça).
- `mediaFetch`: 404 da própria origem marcado como ausente; a miniatura cede logo, o tamanho inteiro mantém a escada de novas tentativas.
- `mediaCache`: apagar uma publicação revoga também as faixas da miniatura, nas duas formas de apagamento.
- `feedSnapshot`, `peekSnapshot`, `listsSnapshot`, `screenSnapshot`: `thumbs` opcional faz ida e volta; lista malformada segue a regra de `media` de cada codec; linhas antigas abrem iguais.
- `peek`: a Espiadinha guarda a miniatura ao lado das fotos.
- `paging`: 25 linhas de 25 autores fazem 2 pedidos ao índice (16 e 9).
- `topics`, `conversaScreen`: a busca e a semente da conversa repassam `thumbs`.
- Cada teste novo de regressão falha sem a correção, por exemplo `not ok 3 - 25 authors need exactly two index requests` (25 pedidos em vez de 2) e `not ok 1 - the GIF itself at a small width`.

## Aterrissagem

`npm run lint`, os arquivos de teste direcionados sobre o diff contra `origin/main` (134 arquivos) e `npm run demo` ("DEMO OK"). A suíte inteira roda na CI do GitHub (Node 20 e 24).

## Não conferido

Sem verificação manual em Android, iOS ou web nesta branch: o comportamento visual (miniatura por baixo, troca para o tamanho inteiro) foi conferido por testes de módulo puro e de texto.
