# Nome novo do grupo na busca do semeador (branch fix/group-rename-search)

Parte da #350 (item da #241: "Renomear o grupo não aparece na busca do semeador").

## O que mudou

- O semeador passa a varrer a raiz de um grupo público (cabeçalho `kind: 'group'`, `visibility: 'public'`) atrás de `group-meta`, como já fazia com a raiz de uma comunidade. Só `group-meta` é dobrado, validado com `validateGroupRecord(..., { root: true, community: false })`; `group-create` continua só da comunidade. Raiz privada não é varrida (o meta dela vai selado).
- `packages/core/lib/group-index.js`: o nome efetivo de um grupo público é o último `group-meta` dobrado (nome nulo limpa: o grupo deixa de ser achado e a linha fica sem nome), senão o do cabeçalho. `search()` e as linhas de `community()` usam esse nome; `setHeader` e `resetRoot` mantêm os tokens coerentes.
- `packages/core/lib/seeder.js`: `_rootScanBehind` conta a raiz de grupo público em varredura. `complete` de `indexGroup` e da busca só vale com a varredura em dia (a busca olha só raízes de grupo, não de comunidade), e `/index/community/<C>` também espera a varredura da raiz de cada grupo que o catálogo nomeia (`_catalogueRootPending`).
- As varreduras de raízes de grupo público rodam uma de cada vez (`_rootScanQueue`) e só decodificam o bloco que contém os bytes `group-meta`; o validador continua sendo a checagem. A raiz de comunidade segue como antes.
- `indexGroup` e as linhas do catálogo usam o nome e, nas linhas, o `join` do último `group-meta`.
- `docs/protocol.md` (seção 10): a rota de busca e as linhas do catálogo dizem qual nome valem.

## Como verificar

```sh
node packages/core/test/group-index.test.js
node packages/core/test/seeder-groups.test.js
node packages/core/test/seeder-private.test.js
node packages/core/test/seeder-communities.test.js
node packages/core/test/seeder-groups-3.test.js
npm run lint
```

- `group-index.test.js`: "a public group root's latest group-meta renames it in the search and the catalogue rows" e "a private group root ignores a meta".
- `seeder-groups.test.js` (DHT local): "a public group renamed by its root is found by the new name only"; "a rename appended after admission is picked up, and a null rename clears the name" (caminho ao vivo); "public group root scans run one at a time and decode only blocks that contain group-meta" (no máximo uma leitura em andamento entre duas raízes, e `rootDecoded` igual a 2 numa raiz de 23 blocos).
- `seeder-communities.test.js`: "a catalogue row shows the new name of a renamed public group, and is incomplete while that root scan is behind".
- `seeder-private.test.js`: a raiz privada fica com `rootScanned === 0`.

Resultados (cada arquivo sozinho, com a correção): `group-index` 14/14 testes e 161/161 asserções; `seeder-groups` 43/43 e 262/262; `seeder-private` 4/4 e 34/34; `seeder-communities` 9/9 e 59/59; `seeder-groups-3` 6/6 e 33/33; `npm run lint` limpo.

Sem a correção, revertendo só um trecho de cada vez:

- Sem `|| this._rootScanBehind(G)` em `_catalogueRootPending`: `seeder-communities` 8/9 testes e 58/59 asserções, falha "incomplete while the group root scan is behind".
- Sem a chamada de `_scanRoot` no `watchContiguous` (caminho ao vivo): `seeder-groups` para por tempo esgotado em "R completo" num teste anterior, que também depende da varredura de crescimento; o teste da renomeação ao vivo não chega a rodar. Foi a falha observada, não uma falha isolada do teste novo.
- Sem `lib/group-index.js` e `lib/seeder.js` (primeira versão da correção): `group-index` 13/14 testes e 151/161 asserções, e `seeder-groups` para no teste da renomeação por tempo esgotado ("raiz varrida").

## Não verificado / limites conhecidos

- A dica ignora autoridade, como o nome de uma comunidade: um `group-meta` que o dobramento do nó anularia ainda renomeia o que o semeador mostra. O nó confere ao abrir o grupo.
- Não rodei a suíte inteira, só os arquivos acima e o lint.
