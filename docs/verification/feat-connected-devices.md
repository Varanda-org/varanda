# Aparelhos conectados no nó (branch feat/connected-devices)

Parte da #350. Este arquivo confere o lado do nó: o registro `device` no diário, os métodos `device.hello`, `device.list`, `device.disconnect` e `device.reconnect` (`docs/rpc.md` 5.151 a 5.154), o evento `devices.changed` e o corte dos escritores de um aparelho perdido. A tela do app fica para outro PR; nada aqui mexe em `apps/app`.

## Passo 0: leitores antigos

Um nó ou semeador antigo não conhece o tipo `device`. Em `packages/core/lib/records.js`, `check()` devolve `malformed` para um tipo desconhecido, e quem lê o diário pula o que não valida: `packages/core/lib/feed.js:79`, `packages/core/lib/name-index.js:138`, `packages/core/lib/sync.js:1496` e `:3391`, `packages/core/lib/seeder.js:463` e `:2397`, `packages/web-member/lib/notices.js:685`. `packages/core/lib/store.js` (579 a 606) só valida ao gravar. `docs/protocol.md` (linha 219) já diz que um semeador antigo continua servindo o diário. Conclusão: lançar os semeadores primeiro é recomendado (o índice passa a reconhecer o registro), não obrigatório.

## Como conferir

Testes, cada arquivo sozinho:

```sh
node packages/core/test/devices.test.js
node packages/core/test/devices-member.test.js
node packages/core/test/devices-session.test.js
node packages/core/test/records.test.js
node packages/core/test/browser-safe.test.js
node packages/rpc/test/methods.test.js
node packages/rpc/test/envelope.test.js
node packages/web-member/test/devices-ops.test.js
node packages/web-member/test/session-devices.test.js
node packages/web-member/test/session-upkeep.test.js
npm run lint
```

O que cobrem:

- [x] Chave: K = BLAKE2b-256 com chave (os primeiros 32 bytes da chave secreta do diário) sobre `varanda/device/1` mais a chave do diário. O mesmo diário dá a mesma chave nos dois nós; outra conta não abre o bloco.
- [x] `device.hello` grava id e nome só quando o id ainda não tem nome, e repete sem gravar nada (`registered: false`).
- [x] `device.list` mostra os aparelhos da conta, o próprio com `self: true`, e `off: true` quando este aparelho foi desconectado.
- [x] `device.disconnect` grava uma marca `group-cut` em cada escritor do aparelho, no comprimento que este aparelho tem, e depois grava o registro `on: false`. Recusa o próprio aparelho, um id desconhecido, `id` com `previous`, e um aparelho desconectado ("este aparelho foi desconectado da conta").
- [x] Um par que já tem marca nunca ganha outra, em nenhum comprimento, por `id` ou por "Aparelhos anteriores": a marca mais baixa vale, então uma segunda só esconderia o que o primeiro aparelho guardou. Cenário: A corta W em 100, aparece um escritor novo sem dono, C (sem W, comprimento 0) desconecta "Aparelhos anteriores": só o novo é marcado e W continua em 100.
- [x] Um aparelho sem id cujo escritor atual tem marca de corte está desconectado: `device.hello` responde `off: true` e não grava nada; a manutenção do navegador não entra em grupos nem repassa chaves; só `device.reconnect` o registra de novo.
- [x] Um aparelho desconectado (pelo id ou, sem id, por um escritor cortado) não entra por conta própria: `group.join` (grupo guardado ou não), `community.join`, `group.create` e `community.create` recusam com "este aparelho foi desconectado da conta" antes de gravar qualquer coisa, nos dois nós.
- [x] A desconexão incompleta responde "a desconexão ficou incompleta: tente de novo"; o app mostra como incompleta e nunca repete sozinho. Repetir é seguro: os pares já marcados são pulados.
- [x] Núcleo: antes de marcar, uma sincronização interna de no máximo 15 s, com ou sem sincronização ligada, sem `sync.started` nem `sync.stopped`, e `sync.status` continua `idle`.
- [x] Navegador: um comprimento novo da sincronização contínua que torna este aparelho desconectado manda `devices.changed { off: true }` uma vez, lendo nos núcleos emprestados, sem parar a sincronização (com a manutenção fora do teste). O comprimento só conta como lido depois de uma leitura que deu certo, e a manutenção que vê o aparelho desconectado também avisa.
- [x] `foldDevices`, `linkedPairs` e `cutMarks` não lançam com entradas hostis (getters que lançam, Proxy, tipos errados); uma caixa de 8193 bytes e base64 não canônico (sem `=`, com quebra de linha, alfabeto de URL) são ignorados no fold, e uma de 8192 bytes é lida.
- [x] `device.reconnect` no navegador só depois de entrar com a passkey nesta abertura ("para conectar de novo, entre com a passkey"); no núcleo, sem essa exigência.
- [x] `devices.changed` sai só quando o estado muda (nenhum enviado vale `off: false`): `[{ off: true }, { off: false }]` no fluxo desconectar e reconectar.
- [x] Depois dos cortes, a chave gira nos grupos privados em que este nó distribui (melhor esforço; uma falha não desfaz o corte).
- [x] Regressões (regra removida, teste rodado, regra de volta): sem a recusa do aparelho desconectado em `disconnectPlan`, falham 2 testes de `devices.test.js` e 2 de `devices-member.test.js`; sem a regra da manutenção desligada, falha o teste 3 de `devices-ops.test.js`; com o `hello` renomeando sempre, falha o teste 5 de `devices.test.js`; sem a exigência da passkey, o teste 2 de `session-devices.test.js` quebra (a reconexão passa); sem a troca de chave no navegador, falha o teste 6 de `devices-ops.test.js`.
- [x] Regressões da revisão, com as bibliotecas de c8ef9b55 e os testes novos: em `devices.test.js` falham 2 (a marca repetida e o plano de "Aparelhos anteriores", 92/95 asserções); em `devices-member.test.js` falham 3 (a marca baixada de 100 para 0 e as entradas e criações por conta própria, 59/71); em `devices-ops.test.js` o teste da marca repetida falha (2/6) e o das entradas recusadas falha e deixa o aparelho voltar sozinho (o diário passa de 9 para 14 registros e `device.reconnect` responde "este aparelho está conectado"). Sem a chamada de `scheduleDeviceCheck`, o teste do comprimento novo em `session-upkeep.test.js` esgota o tempo esperando `devices.changed`.

Conferência manual, com duas instalações da mesma conta (A e B) e um grupo privado:

- [ ] Em A, `device.list` mostra A e B; `device.disconnect` de B responde `{ cut, empty }` e `groups.changed` sai para cada grupo.
- [ ] B, na próxima sincronização, recebe `devices.changed { off: true }` e não posta no grupo; `device.reconnect` (no navegador, depois da passkey) o traz de volta com um id novo.

## Não verificado / limites conhecidos

- O efeito do corte nas leituras do grupo vem do `fold` de `feat/diary-writer-cut`; esta branch não muda `packages/core/lib/group.js`.
- O aparelho que criou um grupo ou uma comunidade mantém os poderes da raiz: desconectá-lo corta o escritor, não a raiz.
- Um ladrão com a identidade destravada age como a pessoa: pode desconectar os outros aparelhos antes que ela o desconecte.
- Semeador: o operador atualiza o semeador para o índice reconhecer o registro `device`; sem isso o diário continua servido e o registro é pulado.
- Quem hospeda o nó passa `fresh` (passkey nesta abertura) ao destravar; sem isso `device.reconnect` no navegador recusa.
- A troca de chave depois do corte é melhor esforço: uma falha vira aviso e não é repetida.
- No navegador, a conferência de `devices.changed` a cada novo comprimento só acontece quando a sincronização contínua empresta os núcleos na hora; um comprimento pulado fica sem conta como lido e é lido de novo no próximo aviso, na manutenção ou na próxima chamada `device.*`. O teste usa uma sincronização simulada, sem rede.
- Núcleo: a sincronização interna antes de marcar não tem teste com pares; o teste só confere que ela não aparece como `sync.started` ou `sync.stopped`. Esse teste também passa em c8ef9b55, onde, com a sincronização desligada, ela nem rodava.
- Nenhuma conferência em aparelho foi feita.
