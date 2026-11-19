# Fotos de grupo e comunidade pelo índice: verificação

## Testes executados

No Node.js 24, na cópia de trabalho local, com a DHT local dos testes:

- `npm run lint`: passou.
- `npm run demo`: terminou com `DEMO OK`.
- Os 673 arquivos de teste alcançados pelo diff contra `origin/main`, em quatro grupos paralelos: todos passaram (10492 testes, 172714 asserções).
- A suíte completa roda na CI do GitHub.

Arquivos de teste da mudança, com as contagens locais:

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/cli/test/seed-ws.test.js` | 113 | 2743 |
| `packages/core/test/seeder-groups.test.js` | 68 | 520 |
| `apps/app/test/indexClient.test.js` | 86 | 1743 |
| `apps/app/test/comunidadesRow.test.js` | 17 | 163 |
| `apps/app/test/vitrineIndex.test.js` | 34 | 1985 |
| `apps/app/test/vitrine.test.js` | 66 | 4804 |
| `apps/app/test/platformGate.test.js` | 6 | 847 |
| `apps/app/test/mediaHash.test.js` | 7 | 38 |
| `packages/web-member/test/e2e-social.test.js` | 1 | 91 |

O que os testes cobrem:

- Semeador (`seed-ws.test.js`, `seeder-groups.test.js`): a rota `GET /index/group-image/<chave>(,<chave>){0,31}` responde na ordem pedida, só para grupos e comunidades públicos servidos; chave privada, oculta ou desconhecida recebe a mesma resposta vazia; uma raiz privada com foto cifrada real nunca aparece, nem com cache antigo; chave em maiúsculas, repetida, com vírgula sobrando, 33 chaves e `POST` são recusados sem consulta; o orçamento e o limite de pedidos em andamento do índice valem antes da consulta; semeador sem o método é 404.
- Cliente (`indexClient.test.js`): o caminho pedido é exatamente `/index/group-image/` com chaves distintas em minúsculas; linhas extras, repetidas, não pedidas, WebP, item privado, autor inválido e falha de transporte viram um mapa vazio ou são descartadas.
- Telas (`comunidadesRow.test.js`): a linha ganha `picture` e `mediaAuthor` do mapa sem mudar a original; linhas com resposta do nó e linhas privadas ficam fora do pedido; 32 grupos públicos mais o cabeçalho pedem as 33 fotos em lotes de 32 e 1; falha, nó não hospedado ou offline, página antiga e saída da tela não aplicam resposta; na busca, um grupo que o nó guarda mantém a foto do nó (inclusive removida) e o índice só é consultado depois de `group.list`, e não é consultado se essa leitura falhar.
- Vitrine (`vitrineIndex.test.js`): a rota singular está na lista e as fixtures sem foto ficam com as iniciais.

## Conferência das regressões

- O caminho do cliente: com `/index/group-images/` (plural), o teste do caminho exato em `indexClient.test.js` falha.
- Os lotes de 32: sem a divisão, o teste das 33 fotos e o da geração cancelada falham (7 de 9 na época).
- A busca com grupos do nó: sem `heldSearchRows`, os cinco testes novos da busca falham.

## Verificações em dispositivos, não executadas

Não conferido em Android, iOS nem na web. Roteiro, primeiro no build de debug do Android e no simulador iOS, depois na web:

1. Com nó hospedado e online, sem participar do grupo, buscar um grupo público com foto: a foto aparece na linha da busca.
2. Abrir o catálogo da comunidade desse grupo: as fotos dos grupos públicos e a do cabeçalho aparecem, também num catálogo com 32 grupos. Um grupo privado mantém o ícone da cadeira.
3. Buscar um grupo de que a pessoa participa e cuja foto foi removida: a linha mostra as iniciais.
4. Com um semeador anterior à rota, as linhas públicas mantêm as iniciais, sem mensagem.
5. Sair da tela durante a consulta não aplica a resposta antiga e não entra em grupo nem comunidade.
