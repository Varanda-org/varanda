# fix/disconnect-ends-root-charter

Fecha o limite registrado em `docs/rpc.md` 5.154 e em `docs/verification/feat-community-create-any-device-write.md` ("Limite conhecido"): `device.disconnect` nunca marcava uma raiz, então um grupo criado num aparelho perdido continuava com a carta (nome, imagem, sobre, entrada, admins) desse aparelho depois da desconexão.

## O que mudou

- O fold já aceitava a marca de raiz (`group-cut` com `writer` igual ao grupo no diário de quem criou, `docs/protocol.md` seção 10, "Creator marks on group roots"). No nó do navegador todos os aparelhos da conta compartilham o diário, então o aparelho 1 pode escrevê-la. Faltava saber qual aparelho tem qual raiz. Nenhuma mudança de protocolo nem do fold.
- `packages/core/lib/devices.js`: `helloPlan`, `reconnectPlan` e `joinRecord` aceitam raízes só quando quem chama as passa (`roots`, `root: true`). `linkedRoots` lista as raízes que o diário liga agora. `disconnectPlan` com `linkedRoots` nomeia, para um `id`, as raízes ligadas que os registros dele mapeiam, depois dos outros escritores: nunca uma raiz própria, já marcada ou desligada, e nunca em `previous`. Sem esses argumentos o comportamento é o de antes, e o nó do core (`packages/core/lib/member.js`) não mudou.
- `packages/web-member/lib/member-ops.js`: `device.hello` e `device.reconnect` mapeiam as raízes de grupo que o aparelho tem (nunca a de uma comunidade); `group.create` mapeia a raiz nova; `device.disconnect` por `id` marca essas raízes no comprimento contíguo que tem aqui e pula uma raiz de que não tem nenhum bloco (marca em 0 anularia toda a história da raiz).
- `docs/protocol.md` (seção 2, `device`, e seção 10, "Creator marks on group roots") e `docs/rpc.md` 5.152 a 5.154: a regra nova, a consequência e os limites que sobram. O tópico "Limit" de 5.154 foi reescrito.

## Consequência, decidida no plano (pergunta 6, "manter")

A marca de raiz encerra também a carta dos outros aparelhos naquele grupo (`charterLive` falso no fold): depois de desconectar, nenhum aparelho da conta muda nome, imagem, sobre, entrada ou admins do grupo, e um nome que o aparelho 1 tinha posto antes volta ao que a raiz escreveu abaixo da marca. Conferido com uma sonda temporária: o aparelho 1 renomeia para "Sitio", desconecta o aparelho 2, e o nome volta a "Feira". A marca é final, também depois de reconectar. Publicar e ler continuam: num grupo privado criado no aparelho perdido, o aparelho 1 segue com chave e publica depois da marca (teste abaixo).

## Limites que ficam

- Raiz de comunidade: o fold ignora marca nela; fica até uma saída de quem criou.
- Raiz que o aparelho nunca mapeou: um aparelho que não abriu o app (sem `device.hello`) depois desta versão.
- Raiz de que o aparelho que desconecta não tem nenhum bloco.
- `Aparelhos anteriores` nunca marca raiz: nenhum registro diz qual aparelho a tem.

## Testes

`packages/web-member/test/disconnect-root.test.js` (novo, padrão `secondDevice`):

- `a disconnect marks the root of a group the lost device created: its later charter does not count`
- `a root created before the device had an id is mapped by its next hello and marked`
- `the mark ends the charter from device 1 too: the group charter is frozen`
- `a root not held here is not marked`
- `a community root is never marked; the root of its Geral is`
- `a private group created on the lost device: device 1 still reads and posts after the mark`
- `Aparelhos anteriores never marks a root`

`packages/core/test/devices.test.js`: três testes novos (`roots (browser node): ...`, `linkedRoots: ...`, `disconnectPlan with linkedRoots: ...`) e `linkedRoots` no teste de entradas hostis.

## Falha sem a correção

Com `devices.js` e `member-ops.js` da `main` e os testes novos: `disconnect-root.test.js` dá 1/7 testes, 15/30 asserções (só o de `Aparelhos anteriores` passa, como deve). Em `devices.test.js`, `roots (browser node)` falha e o seguinte para em `devices.linkedRoots is not a function`. Com a correção: 7/7 (30/30) e 17/17 (122/122).

## Comandos

```sh
npm run lint
node packages/web-member/test/disconnect-root.test.js
node packages/core/test/devices.test.js
npm run demo
```

Os arquivos de teste que importam `devices.js` ou passam por `device.*` e `group.create` no nó do navegador rodaram um por um; a lista e os números estão no PR. A suíte inteira roda na CI do GitHub.

## Não rodado

Nenhuma conferência em aparelho (Android, iOS, web): a mudança é do nó do navegador e não muda tela. O texto de confirmação de "Desconectar" no app não fala da carta fixa; fica como possível ajuste separado.
