# Sobras da participação automática de aparelhos (branch fix/device-upkeep-leftovers)

Parte da #350. Duas sobras da participação automática de um aparelho novo da mesma passkey (nó do navegador): uma da #275 e uma da #320.

## O que mudou

1. **Rebox de escritor sem chave (#275).** Um aparelho que entrou num grupo privado antes de a raiz chegar escreveu um escritor com `box: null` (join pendente). Com a raiz privada em mãos, esse escritor nunca conta, e só um toque em "entrar" o trocava. Agora `deviceUpkeepPlan` (`packages/web-member/lib/member-ops.js`) enxerga, num grupo privado, um escritor próprio que o diário liga, que ainda escreve e cujo `box` do cabeçalho não é o deste aparelho, e planeja a entrada com `rebox: true`. `deviceUpkeep` a executa pelo mesmo `groupJoin` do toque: o join do escritor antigo é desligado e um escritor com a chave do aparelho toma o lugar. Depois disso a entrada do kv nomeia o escritor novo e o plano seguinte fica vazio (sem laço).
   - Estados aceitos da dobra para o diário próprio: não listado ou `left` sem nenhuma saída contada do diário (`lastLeave`), `member` ou `requested` por outro aparelho. Nunca `banned`, nunca diário próprio bloqueado, nunca saída escrita em outro aparelho (`status`). Um grupo de aprovação termina como pedido (`requested`), como o toque.
   - Também exigidos: identidade desbloqueada (sem a chave, `locked`, transitório), raiz que não é órfã, comunidade-pai que admite (`parentAdmits`), reserva e vagas (`autoEnrolRoom`). O escritor antigo não pode ter saída própria nem ter sido desligado antes.
   - Raiz ainda não guardada: se o escritor próprio ligado é sem chave e ainda escreve, o plano devolve `unheld` (transitório). Assim a passada continua armada e o `groups-changed` da chegada da raiz planeja o rebox.
   - `deviceUpkeepNeeded` (a pré-checagem barata) não mudou: ela não vê chaves.
2. **Limite do `group-writer` (#320).** `packages/web-member/lib/sync.js` passa a emitir `{ event: 'group-writer', group, writer, private, own, account }` (visibilidade verificada da raiz e se este aparelho tem escritor próprio no grupo). `packages/web-member/lib/session.js` arma a passada só para grupo privado em que o aparelho escreve, no máximo `MAX_UPKEEP_WRITERS = 64` chaves por sessão (era 512). Um escritor para o qual não se arma (teto, aparelho bloqueado, execução `once` ou interna) mantém `upkeepFull = true`, mas só quando pode haver repasse de chaves (privado com escritor próprio); grupo público ou sem escritor próprio não muda nada. O comentário de cabeçalho do `session.js`, `docs/rpc.md` (5.63) e `docs/protocol.md` (eventos do sync do navegador) descrevem isso. Nenhum outro consumidor de `group-writer` existe em `apps/app/src`, `packages/web-member/lib` ou nos testes além dos de upkeep.

## Ajustes da revisão

- O evento `group-writer` ganhou `account` (o diário próprio liga o escritor) e a passada também arma por ele: sem isso, um aparelho novo perdia o gatilho quando o escritor da conta chegava depois de uma passada com `status`. Teste: `the account's writer arriving after a status pass arms the pass, and the new device enrols`.
- Sem rebox quando o diário próprio já desligou, nesta raiz, um escritor que não é deste aparelho (saída em outro aparelho cujo núcleo ainda não chegou). Teste: `a leave on another device whose writer core has not arrived yet is respected too`.
- Rebox só para `box: null`; uma chave diferente e não nula fica para o toque explícito.
- `unheld` vale também para raiz pública (a visibilidade é desconhecida sem a raiz); só mantém a passada armada. Teste: `a public group's boxless writer is never reboxed once its root is held`.
- `AGENTS.md`: a troca do escritor sem chave pelo próprio aparelho entra na exceção das escritas iniciadas pelo nó, como pede a #350.

## Como verificar

```sh
node packages/web-member/test/device-upkeep-ops.test.js
node packages/web-member/test/session-upkeep.test.js
npm run lint
```

Testes novos, em `packages/web-member/test/device-upkeep-ops.test.js`:

- `a boxless private writer is reboxed once the root arrives, then nothing is left to plan`: antes da raiz o plano diz `unheld`; com a raiz planeja `rebox: true`, o grupo de aprovação termina `requested`, o diário desliga o escritor antigo e liga um com a chave do aparelho, o plano seguinte é vazio e um plano velho não escreve nada.
- `a boxless private writer is never reboxed after a leave written on another device`: um segundo aparelho entra e sai; o plano dá `status` e nada é escrito.
- `a banned diary's boxless private writer is not reboxed`: banido dá `status`.
- `a boxless private writer is skipped as locked without this device's box`: sem a chave dá `locked` transitório.

Em `packages/web-member/test/session-upkeep.test.js`:

- `a group-writer arms the pass only for a private group this device writes in, at most 64 keys`: grupo público, grupo privado sem escritor próprio e evento sem campos não armam; 64 chaves de grupo privado com escritor próprio armam; a 65ª não arma.
- `a root arriving after a join by key plans the rebox of the boxless writer`: com a raiz ausente a passada não troca nada e fica armada; ao chegar a raiz, o `groups-changed` planeja e o escritor com a chave do aparelho toma o lugar.
- Os testes antigos de `group-writer` passam a emitir `private: true, own: true`.

## Evidência de regressão

Com só `member-ops.js`, `session.js` e `sync.js` revertidos (`git stash push` dos três arquivos), os testes novos falham:

- `device-upkeep-ops.test.js`: `tests = 23/27 pass`, `asserts = 177/189 pass`; falham os quatro testes do rebox (24 a 27).
- `session-upkeep.test.js`: falha o teste `a group-writer arms the pass only for a private group this device writes in, at most 64 keys`, e o do rebox termina com `tempo esgotado: the rebox` (o escritor sem chave nunca é trocado).

Com as mudanças de volta: `device-upkeep-ops.test.js` `tests = 29/29 pass`, `asserts = 200/200 pass` (depois dos ajustes da revisão); `session-upkeep.test.js` `tests = 26/26 pass`, `asserts = 151/151 pass`. `npm run lint` sem avisos.

## Não verificado / limites conhecidos

- Não rodei a suíte inteira nem a demo; só os dois arquivos de teste acima e o lint.
- Não conferi num navegador real: o rebox foi exercitado com cores por replicação direta e a sincronização simulada, como os demais testes de upkeep.
- Um grupo público cuja raiz ainda não chegou e cujo escritor próprio é `box: null` (sempre o caso num grupo público) também devolve `unheld` até a raiz chegar, o que só mantém a passada armada dentro dos limites de passadas já existentes.
