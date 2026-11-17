# Exclusão agendada pelo operador (branch feat/account-delete-cli)

Parte da #31. Quem não tem passkey, código de recuperação nem celular confirmado (contas antigas que entraram com o Google) não consegue pedir a exclusão pelo app. O operador confere o pedido pelo e-mail do vínculo e agenda a mesma exclusão de 7 dias que o app agenda. Sem mudança de Termos.

## O que muda

- **Comando novo.** `varanda account delete (--member <hex> | --username <@nome>) [--yes] [--undo] [--json]` em `apps/cli/lib/commands/account.js`.
  - Sem `--yes` nem `--undo`: só leitura (todas as lojas abertas `readOnly`, pode rodar com o serviço no ar). Imprime a chave (`membro:`), o @nome atual, o e-mail do vínculo ou "sem e-mail no vínculo", o que a conta ainda tem para entrar (`passkeys guardadas: N`, as chaves que o serviço conta com `countedKeys`; `códigos de recuperação: N` e `passkeys extras de recuperação: N`, as entradas vivas de `recovery.json` por tipo; `celular: confirmado` ou `sem registro`, uma linha viva e selada de `phone.json`, lida sem a chave de selo), a data já agendada ou "nenhuma exclusão agendada", a página ativa que impede, se houver, e "nada foi gravado; rode de novo com --yes".
  - `--yes`: pega a trava do serviço (`takeLock`; com o serviço no ar, "pare o serviço de conta antes de agendar uma exclusão"), abre o `passkeys.json` com `guard: () => lock.held()`, recusa enquanto a conta tiver algum desses meios de entrar ("a conta ainda tem 1 passkey guardada, 1 código de recuperação, 1 passkey extra de recuperação e celular confirmado: confira que a pessoa perdeu o acesso a eles e rode de novo com --force"), salvo com `--force`, recusa a dona de página ativa e chama `passkeys.schedule` com `runAt` = agora + `WAIT_MS` (importado de `delete-routes.js`). Imprime as mesmas linhas de identidade e meios de entrar da prévia e depois "exclusão agendada para dd/mm/aaaa (ISO)" ou "exclusão já agendada para ..." (a primeira data fica); o JSON é `{ member, username, email, passkeys, recoveryCodes, recoveryPasskeys, phone, scheduled, already }`. Todo `--yes` que termina bem põe a chave em `deletion-notices.json` (`{ "v": 1, "members": [...] }`, modo 0600, gravado com a guarda da trava, uma entrada por chave), também num "já agendada", para que rodar de novo conserte a fila. Uma gravação incerta diz se o aviso entrou na fila (", e o aviso push entrou na fila" ou ", e o aviso push não entrou na fila: rode de novo com --yes antes de ligar o serviço"). Uma gravação que falhou dá "não foi possível confirmar a gravação: confira com account delete --member <chave>", sem nova tentativa.
  - `--undo`: a mesma trava ("... antes de cancelar uma exclusão"), `passkeys.cancel`, tira a chave de `deletion-notices.json` (o arquivo sai com a última), "exclusão cancelada" ou "nenhuma exclusão agendada", saída 0 nos dois casos; nunca pede `--force`.
  - Recusas: nem um nem os dois de `--member`/`--username`, ou `--yes` com `--undo`, são erro de uso (saída 2). Nome de página "o nome é de uma página", nome nunca emitido "nome não encontrado", conta excluída "conta já excluída", chave sem vínculo "chave sem vínculo", arquivo ilegível "passkeys.json inválido", "pages.json inválido" (também na prévia) ou "deletion-notices.json inválido" (antes de gravar o agendamento) (saída 1). Um `directory.json` restaurado de cópia antiga faz o `--yes` e o `--undo` recusarem ("diretório de contas restaurado de uma cópia antiga; confira o backup"); a prévia só avisa.
  - Aviso push: na partida seguinte, antes da primeira varredura, o serviço (`apps/cli/lib/account/deletion-notices.js`, `drainNotices`, e `notifyScheduledDeletion` em `server.js`) manda o aviso "exclusão agendada" (o mesmo `notifyDeletion` do caminho do app, só navegadores) a cada chave da fila que ainda tem agendamento e não foi excluída, registra `{"event":"exclusao","reason":"avisos-operador","sent":N,"skipped":M,"kept":K}`. Sem agendamento ou excluída sai da fila; quem o serviço não conseguiu ler (`passkeys.json` inválido, loja que lança) fica no arquivo para a próxima partida, e o arquivo sai quando ninguém fica. Um arquivo inválido é registrado (`avisos-invalidos`) e apagado, porque mantido seria recusado de novo a cada partida. Os aparelhos com o app veem o agendamento pelo `/account/status` (`scheduledDeletion`).
- **Ajudante compartilhado.** `ownsLivePage` sai de `delete-routes.js` para `apps/cli/lib/account/live-page.js`, usado pelas rotas e pelo comando. As rotas continuam respondendo `indisponivel` quando o `pages.json` não responde.
- `dateOf` de `apps/cli/lib/post-page.js` passa a ser exportado (dd/mm/aaaa no horário de Brasília, como o `scheduleDate` do app).
- Documentos: duas linhas no `HELP`, no bloco "Ajuda" do README e no bloco Help de `docs/protocol.md`; o `USAGE` do `account`; o procedimento do operador em README "Excluir conta"; um item em `docs/protocol.md` "Account deletion" (mesmo `hold { at, runAt }`, sem mudança de formato, sob a trava do serviço, os meios de entrar, `--force`, a forma de `deletion-notices.json`, recusa da página só no `--yes`). README: o `account reports` deixa de dizer que é o único caminho do e-mail do vínculo; o procedimento traz o "não cole a saída em chamado ou chat", quando `--force` cabe e o que acontece com a dona de página que não consegue entrar (nenhum comando do operador encerra ou transfere página). O comentário de `contact()` em `apps/cli/lib/account/store.js` cita o `account delete`.

## Comandos e resultados

Da raiz, um arquivo por vez (`node <arquivo>`):

- `apps/cli/test/account-delete-cli.test.js` (novo): 18/18 testes, 235/235 asserções.
- `apps/cli/test/account-delete.test.js`: 32/32, 266/266.
- `apps/cli/test/cli.test.js`: 5/5, 1336/1336.
- `apps/cli/test/readme-help.test.js`: 1/1, 2/2.
- `apps/cli/test/account.test.js`: 65/65, 999/999. `apps/cli/test/account-phone-cli.test.js`: 10/10, 157/157. `apps/cli/test/account-phone-lookup.test.js`: 6/6, 99/99. `apps/cli/test/post-page.test.js`: 27/27, 1097/1097.
- `apps/cli/test/account-push.test.js`: 51/51, 1083/1083. `push-e2e`: 1/1, 72/72. `push-relay`: 17/17, 115/115. `push-store`: 29/29, 198/198. `push-text`: 11/11, 67/67. `seeder-push`: 7/7, 80/80. `web-push`: 18/18, 120/120.
- `npm run lint` (standard): sem apontamentos.

## Falha sem a correção

Conferido em 17/11/2026, desfazendo uma parte por vez e rodando `account-delete-cli.test.js` (e `account-delete.test.js` no caso do ajudante), depois com a correção de volta.

Primeira rodada (10 testes, 143 asserções na época):

- Sem o subcomando: o arquivo cai na primeira leitura do JSON (saída 1).
- Sem a trava: 9/10, 137/143.
- Sem a recusa da página ativa no `--yes`: 9/10, 140/143.
- Sem a conferência do vínculo: 9/10, 130/143.
- Sem a recusa do nome de página: 9/10, 141/143.
- Sem a recusa da conta excluída: 8/10, 138/143.
- Sem a troca para minúsculas do nome: o arquivo cai (saída 1).
- Sem abrir e conferir o `passkeys.json` antes de agendar: 9/10, 142/143.
- Com `runAt` a 14 dias: 8/10, 138/143.
- Com o `--undo` sem cancelar: o arquivo cai (saída 1).
- Com a prévia gravando um agendamento: 7/10, 138/143.
- Com `ownsLivePage` sempre falso: `account-delete-cli` 8/10, 139/143; `account-delete` 30/32, 259/266.

Revisão 1 (17 testes, 222 asserções):

- Sem a recusa por meios de entrar: 16/17, 216/222.
- Celular sempre "sem registro": 15/17, 218/222. Passkeys contadas como 0: 15/17, 218/222. Códigos de recuperação contados como 0: 15/17, 218/222.
- Sem pôr o aviso na fila: 14/17, 217/222.
- `--undo` sem tirar o aviso: 16/17, 220/222.
- Sem conferir `deletion-notices.json` antes de gravar: 16/17, 220/222.
- Sem ler a fila na partida do serviço: 16/17, 218/222.
- Aviso para quem não tem mais agendamento: 16/17, 221/222. Aviso para conta excluída (com agendamento sobrando): 16/17, 221/222.
- `drainNotices` lançando com arquivo inválido: o arquivo cai (saída 1). Arquivo inválido mantido: 15/17, 220/222.
- `--yes` sem as linhas de identidade: 15/17, 218/222. JSON do `--yes` sem @nome e e-mail: 15/17, 217/222.
- Nova tentativa do `schedule` depois de uma falha: 16/17, 219/222. O mesmo no `cancel`: 16/17, 219/222.
- Diretório restaurado aceito no `--yes`/`--undo`: 16/17, 217/222.
- `pages.json` inválido ignorado: 16/17, 216/222.
- Data em UTC em vez de Brasília: 16/17, 221/222.

Revisão 2 (18 testes, 235 asserções):

- Aviso na fila só num agendamento novo: 17/18, 234/235 (o teste do agendamento já existente sem aviso falha).
- Gravação incerta sem dizer se o aviso entrou na fila: 17/18, 233/235.
- `passkeys.json` ilegível contado como sem agendamento: 17/18, 233/235.
- `drainNotices` descartando quem não pôde ser lido: 16/18, 230/235.
- `drainNotices` apagando o arquivo mesmo com chaves mantidas: 16/18, 232/235.

## Limites

- Os 7 dias contam a partir do comando, e o aviso só sai quando o serviço sobe: o tempo de serviço parado depois do `--yes` sai do prazo para cancelar, e um serviço que só sobe depois da data exclui a conta (primeira varredura) antes de o push (enfileirado 0 a 60 s adiante) chegar. O operador liga o serviço logo depois do `--yes`.

- Só servidor e CLI: nenhuma conferência em aparelho. Nenhum texto dos Termos ou da Política muda.
- O comando não confere quem pediu: isso é a resposta do operador ao e-mail do vínculo. Uma conta sem e-mail no vínculo fica a critério do operador.
- A varredura na data é conferida chamando o `runScheduled` das rotas em processo, com o relógio adiantado. A fila de avisos é conferida subindo o serviço de verdade (`account --json --account-port 0`) três vezes, mas sem push configurado: o teste vê a decisão de avisar (`sent`/`skipped`), não a entrega ao navegador.
