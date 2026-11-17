# Trava conferida antes do rename e prazo de 30 dias sem gravações no recovery.json (branch fix/recovery-store-lock-fence)

Parte da #444, sobre a branch `fix/recovery-store-floor`. Duas mudanças no `recovery.json` (`apps/cli/lib/account/recovery-store.js`).

## O que muda

- **Gravação recusada a um processo sem a trava.** Antes, cada gravação perguntava a trava antes de reler o arquivo e depois do rename; o `writeJsonAtomic` fazia o rename sempre. Um processo parado mais de 30 s (`LOCK_STALE_MS`) dentro desse trecho síncrono (um fsync longo, um processo suspenso) podia perder a trava para outro processo e, ao voltar, trocar o arquivo pelo seu: a gravação que o novo dono já tinha confirmado sumia do arquivo, e o processo antigo respondia `indisponivel` embora a sua gravação estivesse lá. Agora:
  - `writeJsonAtomic` (`packages/core/lib/store.js`) aceita um quarto argumento opcional, `{ beforeRename }`, chamado depois de o arquivo temporário ser escrito, sincronizado e fechado, logo antes do rename. Se ele lança, não há rename, o temporário é apagado e o destino fica como estava. Quem não passa o argumento (todos os outros usos) não muda.
  - O `recovery-store.js` pergunta a trava também ali. Resposta falsa (ou erro) recusa o pedido com `indisponivel`: o arquivo fica idêntico byte a byte, a memória não muda e o arquivo de recuperação não fica indisponível de vez nem pendente, como na recusa antes da releitura. Uma trava que lança erro conta como recusa nas quatro perguntas (antes da releitura, antes do rename, depois do rename e no `heal()`). A pergunta depois do rename continua e decide se a gravação é confirmada.
  - A trava ganhou `held()` (`apps/cli/lib/account/server.js`): verdadeiro só enquanto o arquivo da trava tem o token deste processo e o mtime tem menos de `LOCK_STALE_MS` menos um heartbeat (20 s no serviço), lidos numa única abertura do arquivo. Um processo cujo próprio heartbeat atrasou pode estar no meio de uma tomada da trava por outro, então não grava, e um heartbeat atrasado faz `held()` recusar antes de outro processo poder dar a trava por vencida. Com um heartbeat tão longo quanto a janela (só nos testes), vale a janela inteira. Na próxima batida, se o token ainda é dele, o mtime é renovado e as gravações voltam. Só o `recovery.json` usa `held()` (`apps/cli/lib/commands/account.js`).
- **Prazo de 30 dias num arquivo sem gravações.** As marcas de remoção só eram apagadas dentro de `normalize()`, que roda nas gravações e uniões. O `heal()` (a cada `LOCK_HEARTBEAT_MS`) saía cedo quando o arquivo não tinha mudado e não havia pendência, então num serviço sem gravações uma marca ficava além de 30 dias. Agora o `heal()` segue adiante quando a memória tem uma marca com `removedAt` mais antigo que 30 dias: a união a apaga, sobe a marca por membro (`floors`) e grava. A conferência percorre `state.removed`, sem timer novo. Fora isso o `heal()` não muda: não grava com o arquivo inválido, em modo só leitura ou sem a trava, e sem pendência e sem marca vencida responde falso sem ler o arquivo. O teto de 32 por membro só é alcançado por gravações, que já normalizam.

## Comandos e resultados

Da raiz, um arquivo por vez (antes, os mesmos arquivos da branch-base):

- `node apps/cli/test/recovery-store.test.js`: 44 testes, 434 asserções, todos passam (antes 39 testes, 390 asserções). Novos:
  - "heal() keeps the 30-day removal on an idle store: the tombstone goes and the floor rises" (só `heal()` depois de 31 dias: grava, a marca sai do arquivo, `floors` sobe ao `gen`, um arquivo reaberto não tem a marca nem traz a entrada de volta, nem a partir de uma cópia antiga);
  - "heal() on a clean store with no expired tombstone writes nothing" (com 29 dias o arquivo fica igual byte a byte, com o mesmo mtime e inode);
  - "a writer that lost the lock before the rename leaves the new holder's acknowledged write in place" (o novo dono confirma um `put` ou um `remove` numa cópia do diretório; o arquivo dele entra no lugar durante a gravação do antigo, pelo relógio injetado, e a trava do antigo vira falsa);
  - "a replaced code refused before the rename leaves the acknowledged code live";
  - "a guard that throws right before the rename refuses the request only".
  Cinco testes existentes contavam as chamadas da trava (antes, depois do rename) e agora contam a nova chamada do meio: "guard() false after the write does not acknowledge and heal rewrites", "reads after a write refused past the rename show the file, never stale memory", "a read after an uncertain write refuses when the file cannot be read", "code rows tied on gen after a stale rename both stay: the acknowledged code is never deleted" e "a read after an uncertain write never brings back a row under the floor". O que eles conferem não muda.
- `node apps/cli/test/account.test.js`: 63 testes, 989 asserções, todos passam (antes 60 testes, 975 asserções). Novos: "data-dir lock: held() is true only while the token is ours and the mtime is live", "data-dir lock: held() keeps one heartbeat of margin before the stale window" e "data-dir lock: the recovery store guarded by held() refuses a put while the lock is stale".
- `node apps/cli/test/account-recovery.test.js`: 16 testes, 251 asserções, passam (antes os mesmos números). As sequências de respostas da trava ganharam a chamada do meio.
- `node packages/core/test/store.test.js`: 55 testes, 368 asserções, passam (antes 54 testes, 361 asserções). Novo: "writeJsonAtomic: beforeRename runs once before the rename, and a throw keeps the target".
- `node apps/cli/test/account-delete.test.js` (15 testes, 158 asserções) e `node apps/cli/test/account-recovery-e2e.test.js` (2 testes, 100 asserções): passam.
- `npx standard` nos arquivos alterados: sem apontamentos.

## Falha sem a correção

Conferido em 17/11/2026, com o código restaurado e os arquivos rodados de novo, todos passando:

- Sem a pergunta antes do rename (`writeJsonAtomic` sem `beforeRename` no `recovery-store.js`): `recovery-store.test.js` com 36/44 testes, 407/434 asserções. Falham os três testes novos de gravação ("a writer that lost the lock before the rename ...": "the file is B's" e "B's row is there after a reopen" nos dois casos; "a replaced code refused before the rename ...": "the file is byte-identical", "the acknowledged code is live after a reopen"; "a guard that throws right before the rename ...": "nothing was renamed into place") e os cinco testes existentes que contam a chamada do meio.
- Com `held()` sem a regra do mtime (só o token): `account.test.js` com 60/62 testes, 982/986 asserções; falham "ours but stale: another process may be taking it over" e, no teste do arquivo de recuperação, "a put under a stale lock resolved" e "the file is unchanged".
- Com `held()` sem a margem de um heartbeat (janela de 30 s inteira): `account.test.js` com 62/63 testes, 988/989 asserções; falha "within one heartbeat of the stale window: not held".
- Sem a condição da marca vencida no `heal()`: `recovery-store.test.js` com 43/44 testes, 430/434 asserções; falham "heal prunes and writes", "the tombstone is gone from the file", "the member's floor is raised to its gen" e "and holds no tombstone".
- Com `writeJsonAtomic` sem chamar `beforeRename`: `store.test.js` com 54/55 testes, 365/368 asserções.

## Limites

- Fica uma janela de poucas instruções síncronas entre a pergunta logo antes do rename e o rename: um processo suspenso exatamente ali enquanto outro pega a trava ainda faz o rename depois disso. Com a margem, a suspensão precisa passar de um heartbeat (10 s), ou menos quando o processo já tinha parado por mais que a janela de 30 s e a batida dele renovou o mtime logo antes de outro processo, que já tinha lido a trava vencida, trocá-la. Ele responde `indisponivel` (a pergunta depois do rename falha), e o `heal()` do novo dono, se ainda estiver no ar, regrava o que confirmou.
- A escolha de `lock.held()` para o `recovery.json` em `apps/cli/lib/commands/account.js` não tem teste próprio: os testes montam o arquivo com `guard: () => lock.held()`. Voltar aquela linha para `lock.owned()` não quebra nenhum teste.
- Uma marca apagada pelo prazo de 30 dias faz o `heal()` gravar, e o serviço registra `{ event: 'recovery', reason: 'reparado' }`, como depois de um conserto.
- Só servidor: nenhuma conferência em aparelho é necessária.
- Nenhum texto dos Termos muda: a Política de Privacidade já fala em 30 dias.
