# "Ver novidades" não aparece depois das próprias ações (branch fix/own-write-no-pill)

## Automático (executado)

- `node test/syncSignals.test.js` em `apps/app`: passa. Com a leitura da linha `diário próprio escrito neste aparelho (N)` desligada, três testes novos falham (uma escrita feita aqui conta como crescimento vindo de outro aparelho).
- `node test/passkey-e2e.test.js` em `packages/web-member`: passa. Sem a mudança em `lib/session.js`, as novas asserções falham: a linha local aparece logo antes de `diário próprio sincronizado (N)` em cada escrita, uma vez por comprimento, e nunca quando o crescimento veio do outro aparelho (recuperação e execução contínua do aparelho B).
- `node test/session.test.js` em `packages/web-member`: passa. Uma conexão nova ouve de novo que o comprimento atual foi escrito aqui, uma vez por conexão; sem a mudança em `detach()`, o teste falha. Do lado do app, depois de reconectar, um primeiro comprimento sem linha local conta contra o que a tela carregou (publicação de outro aparelho feita durante a queda acende a pílula).
- Lint, testes afetados e demo da CI, rodados antes do PR.

## Manual (roteiro, ainda não executado)

Web, com uma conta de passkey e sincronização automática ligada e depois desligada:

- [ ] Em A Rua e no Diário: curtir, republicar, publicar e responder. A ação aparece na hora e a pílula "ver novidades" não aparece.
- [ ] Ajustes > Sincronização mostra `diário próprio escrito neste aparelho (N)` logo antes de `diário próprio sincronizado (N)` depois de cada escrita.
- [ ] Publicar de um segundo navegador com a mesma passkey: a pílula aparece em A Rua e no Diário do primeiro.
- [ ] Com A Rua carregada, outra aba assume a conexão; publicar do segundo navegador e voltar a esta aba (Reconectar): a pílula aparece. Curtir aqui e reconectar: a pílula não aparece.
- [ ] Uma pessoa seguida publica: a pílula de A Rua continua aparecendo.
- [ ] Uma republicação feita aqui entra na lista de A Rua na próxima carga (puxar para atualizar, voltar à aba ou publicar), sem a pílula.
