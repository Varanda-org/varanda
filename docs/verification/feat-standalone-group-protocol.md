# Grupos sem comunidade no protocolo

A seção 10 de `docs/protocol.md` passa a descrever as duas formas de raiz de grupo v2: com comunidade (`community` e `member` em hex64) e sem comunidade (os dois nulos, e quem escreve nomeia `member` igual à chave da raiz G). Uma mistura de nulo e hex64 continua malformada. O único predicado da forma é `isStandaloneHeader(header)`, em `packages/core/lib/group.js`, e uma comunidade ausente nunca conta como grupo sem comunidade.

## Regra de lançamento

Atualizar os semeadores antes de qualquer nó que possa criar um grupo sem comunidade. Um semeador antigo recusa a raiz como `header-invalid` e apaga a própria cópia; um nó antigo a lê como cabeçalho inválido e a ignora. Nada é apagado como legado.

## Arquivos de teste

Cada arquivo roda sozinho com `node <arquivo>`. A lista reúne o que o plano prevê por tarefa; os resultados ficam nos PRs de cada uma.

| Tarefa | Arquivo | O que cobre |
|---|---|---|
| T1 | `packages/core/test/group.test.js` | forma do cabeçalho e validadores |
| T1 | `packages/core/test/community-fold.test.js` | formas do cabeçalho: com comunidade, sem comunidade e mistura recusada |
| T1 | `packages/core/test/group-standalone.test.js` | dobra de um grupo público sem comunidade, `member` igual a G; a dobra do grupo ignora o catálogo de uma comunidade C que o nomeia |
| T1 | `packages/core/test/group-standalone-private.test.js` | direito de ler e época de um grupo privado sem comunidade |
| T1b | `packages/core/test/group-standalone-read.test.js` | um nó membro do core carrega uma raiz sem comunidade guardada sem erro |
| T3 | `packages/core/test/seeder-standalone.test.js` | admissão, réplica e reinício de raízes sem comunidade, pública e privada; cabeçalho misto recusado; nenhum aviso |
| T3 | `packages/core/test/group-index.test.js` | a busca antiga omite a raiz sem comunidade e continua listando grupos de comunidade |
| T4 | `packages/core/test/sync-standalone.test.js` | sincronização do nó: raiz aceita como grupo, `member` igual a G, caixa de escrita do grupo privado |
| T5 | `packages/web-member/test/sync-standalone.test.js` | o mesmo no nó do navegador |

## Conferido na documentação

- `grep -n 'Standalone groups' docs/protocol.md` mostra a nova subseção da seção 10, e a mesma seção traz a linha da tabela de resolução do pai, a regra do grupo privado e o risco residual.
- Nenhum travessão no texto novo.
