# Rotas antigas de descoberta vazias (branch feat/retire-legacy-discovery)

As rotas `/index/group-search/<segmento>`, `/index/group-browse/<ordem>` e `/index/public-groups/<D>[/<depois>]` do semeador respondem listas vazias e completas, no mesmo envelope de antes. Os métodos do semeador não mudam. Sem mudança de RPC ou Termos. O responsável escolhe quando implantar.

## O que mudou

- `apps/cli/lib/seed-ws.js`: os três montadores de resposta ignoram as linhas do semeador. Busca e navegação respondem `{ groups: [], more: false, indexing: false, complete: true }`; grupos públicos de um diário, `{ groups: [], next: null, hidden, indexing: false, complete: true }`, com `hidden` igual ao do semeador. Resposta nula do semeador (consulta curta, diário bloqueado ou não servido) e ordem desconhecida continuam 404.
- `docs/protocol.md`: os três itens das rotas antigas em "Index routes".

## Testes

Rodados com `node apps/cli/test/seed-ws.test.js`, sozinho:

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/cli/test/seed-ws.test.js` | 120/120 | 3035/3035 |

Regressão: com o corpo antigo de `searchBody` restaurado, 10 asserções do arquivo falham.

## Verificação manual (a cargo do responsável)

Com um app instalado e um semeador atualizado, as prateleiras de Descobrir, a busca e a caixa de grupos do perfil aparecem vazias, e o app precisa de atualização para listar pelas rotas novas.
