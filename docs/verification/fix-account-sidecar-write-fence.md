# Trava conferida antes do rename em todos os arquivos do serviço de conta (branch fix/account-sidecar-write-fence)

Parte da #444, sobre a branch `fix/recovery-store-lock-fence`. Leva aos outros arquivos que o serviço de conta grava sob a trava a pergunta logo antes do rename que o `recovery.json` já fazia.

## O que muda

- **Um ajudante só.** `apps/cli/lib/account/guarded-write.js` exporta `writeGuarded(file, obj, mode, guard, write = writeJsonAtomic)`: chama o `writeJsonAtomic` com `beforeRename` e pergunta a guarda ali, depois de o temporário ser escrito e sincronizado. Resposta diferente de `true`, ou erro, apaga o temporário, deixa o destino como estava e lança um erro `indisponivel` marcado como recusa (`isRefused(err)`). Uma falha ao apagar o temporário não esconde a recusa. `held(guard)` responde a guarda sem lançar.
- **Cada arquivo trata a recusa como a recusa antes da gravação que já tinha:**
  - `terms-store.js`, `passkey-store.js`, `invites-store.js` (também os códigos da Feira), `push-store.js`, `age-store.js`: o pedido responde `indisponivel`, a memória não muda e o arquivo não fica pendente.
  - `invite-drops.js`: o arquivo da chave, na abertura, e o registro. Uma criação da chave recusada pela trava é tentada de novo na próxima chamada ou no próximo `heal()`; até lá os convites liberados ficam indisponíveis.
  - `phone-store.js`: a recusa cai no tratamento de falha que já existia (relê o arquivo), como a recusa da guarda dentro da operação.
  - `seen-store.js` grava blocos crus com o próprio rename: pergunta a guarda logo antes do `renameSync` e logo antes do `unlinkSync` do apagamento.
  - `page-keys.js`, `pages-store.js` (mantém o escritor injetado), `pages-writer.js` (estado e chave de ruído) e `pages-groups.js` (chave de ruído e `rebox.json`): recusa com `indisponivel`.
  - `pages-dm.js` grava os pedaços do pacote antigo das Conversas com o próprio rename: pergunta a guarda logo antes de cada rename e antes de apagar os pedaços antigos, e numa falha só apaga o diretório se a trava ainda responde.
  - `pages-routes.js` recebe a mesma guarda (`guard`, pelas opções `pages` do servidor) e grava `page-nonce-key.json` e `page-invite-rosters.json` pelo `writeGuarded`; as recusas caem nos tratamentos que já existiam (chave de nonce só em memória, convite `indisponivel`).
  - `age-check-state.js`: qualquer erro continua respondendo `{ ok: false }`.
- **Uma guarda para todos.** Em `apps/cli/lib/commands/account.js`, `serve` cria `const held = () => lock.held()` logo depois de pegar a trava e passa essa mesma guarda a todos os arquivos, ao laço dos convites liberados, às Páginas e ao `recovery.json`; o `releasePhone` usa `lock.held()`. Antes, todos menos o `recovery.json` usavam `lock.owned()`, que só confere o token. Ficam em `lock.owned()`: as estatísticas de uso (`usage.json`), o registro de Páginas indisponíveis e a conferência no fechamento.
- **Recusa passageira não muda estado duradouro.** `held()` responde falso por um instante quando um heartbeat atrasa, com a trava ainda deste processo. Por isso: uma Página cuja gravação do estado depois de um append foi recusada pela trava não pausa (`saveOrPause` em `pages-writer.js`), continua aceitando escritas e a próxima grava o estado inteiro; o `pages.json`, recusado depois do rename, segue o arquivo que acabou de gravar e responde `indisponivel` só naquele pedido, em vez de ficar indisponível até reiniciar. Uma perda de verdade chega a todos pelo `fail()`, e um novo dono que abre uma Página com o diário mais longo que o estado a pausa como antes.
- `docs/protocol.md`: novo item "Account service sidecars" em "Files and replicas" e o texto do vistos sincronizado (seção 14).

## Comandos e resultados

Da raiz, um arquivo por vez:

- `node apps/cli/test/guarded-write.test.js`: 6 testes, 69 asserções. Testes do ajudante (guarda verdadeira renomeia; falsa, nula ou que lança deixa o destino idêntico byte a byte, sem temporário, e lança a recusa; falha comum não é recusa; falha ao apagar não esconde a recusa; escritor injetado recebe o gancho), "every guarded store: a refusal right before the rename leaves the file untouched" (tabela com terms, passkeys, invites, Feira, convites liberados, push, age, phone, page-keys e pages; a guarda só recusa enquanto há um temporário ao lado do destino, isto é, no momento logo antes do rename) e "age-check.json: a refusal right before the rename leaves the file untouched and answers ok: false".
- Novos testes de regressão: "a writer that lost the lock before the rename leaves the new holder's acknowledged write in place" em `terms-store.test.js` e `invites-store.test.js` (o novo dono confirma uma gravação; o arquivo dele entra no lugar durante a gravação do antigo, pelo relógio injetado); "a key refused right before the rename is not created and the drops stay unavailable" em `invite-drops.test.js`; "a guard lost right before the rename or the unlink leaves the blob as it was" em `account-seen-store.test.js`; "a guard lost right before the state file's rename leaves it as it was" em `pages-writer.test.js`; em `account.test.js`, "data-dir lock: the terms store guarded by held() refuses an accept while the lock is stale" e "data-dir lock: every store the service opens is guarded by held()" (lê `account.js` e exige ao menos 18 guardas, todas `held` ou `lock.held()`).
- Testes existentes que contavam as chamadas da guarda ganharam a chamada do meio (o que conferem não muda): `terms-store.test.js` (2), `account-terms.test.js`, `invites-store.test.js` (2), `push-store.test.js`, `account-seen-store.test.js`, `age-store.test.js`, `pages-store.test.js`.
- Todos passam: `terms-store` 37/242, `account-terms` 13/223, `passkey-store` 6/43, `account-passkey` 3/31, `account-delete` 15/158, `account-phone` 34/405, `account-phone-e2e` 1/58, `invites-store` 34/276, `account-invites` 28/372, `invites-pair` 18/100, `account-invites-cli` 5/57, `invite-drops` 27/152, `invite-drop-time` 17/73, `push-store` 29/198, `account-push` 51/1083, `push-e2e` 1/72, `account-phone-gates` 7/43, `account-seen-store` 16/109, `account-seen` 13/178, `age-store` 24/152, `phone-store` 44/389, `account-age` 65/712, `account-age-serve` 4/32, `account-age-e2e` 8/154, `account-phone-lookup` 6/99, `account-phone-cli` 10/157, `page-keys` 16/124, `pages-store` 41/318, `account-pages` 14/268, `pages-lifecycle` 7/104, `pages-writer` 30/373, `pages-dm` 24/384, `pages-groups` 4/156, `account` 65/999 (testes/asserções).
- `npm run lint`: sem apontamentos.

## Falha sem a correção

Conferido em 17/11/2026, rodando só o teste novo com a correção desfeita naquele arquivo e depois com ela de volta:

- Sem o gancho no ajudante: testes do ajudante 0/4, 11/23 asserções.
- `terms.json`: regressão 0/1, 4/9 (com a correção 9/9). `invites.json`: 0/1, 5/9 (9/9). Chave dos convites liberados: 0/1, 3/6 (6/6). Vistos: 0/1, 4/10 (10/10). Estado da Página: 0/1, 1/3 (3/3). `age-check.json`: 0/1, 2/4 (4/4).
- Tabela, um arquivo desfeito por vez: terms 18/20, invites e Feira 16/20, convites liberados 18/20, passkeys 6/8, push 22/24, age 30/32, phone 30/32, page-keys 37/40, pages 38/40 (o total de asserções cresceu com a tabela).
- Rodada de revisão 1:
  - `pages-writer.test.js`, "a guard lost right before the state file's rename leaves it as it was", estendido: depois da recusa a Página não está pausada, um novo `setFollow` passa e o arquivo de estado guarda os dois. Sem a correção falha "not paused" e o `setFollow` seguinte lança `pausada`; com ela 1/1, 7/7. "a committed append whose state save fails pauses the page" passou a usar uma falha que não é da trava (um diretório no lugar do arquivo de estado) e passa com e sem a correção (3/3).
  - `pages-dm.test.js`, "a guard lost right before a bundle chunk's rename writes no chunk and keeps the legacy secret": sem a correção 0/1, 1/5; com ela 5/5.
  - `account-pages.test.js`, "a nonce key refused right before its rename is not written": sem a correção 0/1, 1/3; com ela 3/3.
  - `pages-store.test.js`, "a lock refused after the write is not acknowledged; the store keeps working once it answers again" (substitui o teste que esperava a parada até reiniciar) e "after fail() every write and read is refused": sem a correção o primeiro passa 2 asserções e o `isPage` lança `indisponivel`; com ela 1/1, 4/4.
  - `invite-drops.test.js`, "a key refused right before the rename is not created, and the next heal creates it once the lock answers" (sem a nova tentativa 0/1, 5/7; com ela 7/7) e "a key refused at the open is retried by the next call too" (sem a nova tentativa o `opened` lança `indisponivel`; com ela 3/3).
- `account.test.js`: com o teste dos Termos guardado por `owned()`, 0/1 e 3/7; com o `terms.json` ligado de volta a `lock.owned()` em `account.js`, o teste das guardas dá 0/1 e 2/3.

## Limites

- Fica a mesma janela do `recovery.json`: um processo suspenso nas poucas instruções síncronas entre a última pergunta e o rename enquanto outro pega a trava ainda faz o rename. Ele responde `indisponivel`, porque a pergunta depois do rename falha.
- `pages-groups.js` não tem teste próprio da recusa antes do rename (a montagem é pesada); `pages-writer.js` cobre o mesmo `writeChecked`.
- Ficam de fora, sem guarda no serviço: `moderation-store.js`, `ai/ledger.js` e `ai/exemplar-store.js`. Comandos da CLI fora do `serve` (`dm-postage-file.js`, `commands/mod.js`, o certificado em `account.js`) não passam pela trava do serviço. `usage.json` fica em `lock.owned()`.
- Uma Página cujo estado ficou sem gravar por uma recusa passageira e que não recebe outra escrita antes de o serviço reiniciar abre pausada (o diário está mais longo que o estado), como antes.
- O `startAgeCheck` com a verificação de idade desligada ainda lança se a gravação de `{ on: false }` for recusada, e o serviço não sobe. Só é chamado na partida, logo depois de pegar a trava e sem nenhum `await` no meio, então `held()` só responde falso ali se esse trecho síncrono passar de 20 s. Não há troca em execução.
- Só servidor: nenhuma conferência em aparelho é necessária. Nenhum texto dos Termos ou da Política muda.
