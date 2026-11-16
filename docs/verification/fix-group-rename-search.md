# Nome novo do grupo na busca do semeador (branch fix/group-rename-search)

Parte da #350 (item da #241: "Renomear o grupo não aparece na busca do semeador").

## O que mudou

- O semeador passa a varrer a raiz de um grupo público (cabeçalho `kind: 'group'`, `visibility: 'public'`) atrás de `group-meta`, como já fazia com a raiz de uma comunidade. Só `group-meta` é dobrado, validado com `validateGroupRecord(..., { root: true, community: false })`; `group-create` continua só da comunidade. Raiz privada não é varrida (o meta dela vai selado).
- `packages/core/lib/group-index.js`: o nome efetivo de um grupo público é o último `group-meta` dobrado (nome nulo limpa: o grupo deixa de ser achado e a linha fica sem nome), senão o do cabeçalho. `search()` e as linhas de `community()` usam esse nome; `setHeader` e `resetRoot` mantêm os tokens coerentes.
- `packages/core/lib/seeder.js`: `_rootScanBehind` conta a raiz de grupo público em varredura, então `complete` de `indexGroup`, `indexGroupSearch` e das respostas de comunidade só vale com a varredura em dia.
- `docs/protocol.md` (seção 10): a rota de busca e as linhas do catálogo dizem qual nome valem.

## Como verificar

```sh
node packages/core/test/group-index.test.js
node packages/core/test/seeder-groups.test.js
npm run lint
```

- `group-index.test.js`: "a public group root's latest group-meta renames it in the search and the catalogue rows" e "a private group root ignores a meta".
- `seeder-groups.test.js`: "a public group renamed by its root is found by the new name only" (DHT local).

Resultado com a correção: `group-index.test.js` 14/14 testes e 161/161 asserções; `seeder-groups.test.js` 41/41 testes e 252/252 asserções.

Sem a correção (só `lib/group-index.js` e `lib/seeder.js` revertidos): `group-index.test.js` 13/14 testes e 151/161 asserções, falhando o teste novo da renomeação (dobrar o meta, nome novo achado, nome antigo sumido, linha do catálogo, último vence, nome nulo, restauração depois de `setHeader`); o teste privado passa. `seeder-groups.test.js` para no teste novo por tempo esgotado ("raiz varrida": a raiz nunca é varrida).

## Não verificado / limites conhecidos

- A dica ignora autoridade, como o nome de uma comunidade: um `group-meta` que o dobramento do nó anularia ainda renomeia o que o semeador mostra. O nó confere ao abrir o grupo.
- Não rodei a suíte inteira, só os arquivos acima e o lint.
