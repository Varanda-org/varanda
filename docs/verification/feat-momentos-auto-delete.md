# Apagamento automático dos momentos vencidos

Escopo: PR `feat/momentos-auto-delete`. O app da própria pessoa apaga, pelo `moment.delete` de sempre, os momentos dela publicados há pelo menos 48 h (24 h na tela mais 24 h de margem para relógio errado), nunca os de Página. A escolha dos candidatos e o registro por identidade ficam em `apps/app/src/momentCleanup.js`, a passagem em `momentCleanupPass.js`, os registros no aparelho em `momentCleanupStore.native.js` (um arquivo com troca atômica e cópia de segurança) e `momentCleanupStore.web.js` (localStorage, com Web Locks para uma passagem por vez entre abas), e o hook `useMomentCleanup.js` é montado em `App.js` depois da capa automática, com o mesmo portão. Termos e Privacidade na versão 108. Sem método novo e sem formato de registro novo.

Limites conferidos por teste: no máximo 4 apagamentos por passagem e uma passagem por abertura; só com o app aberto, desbloqueado, online, visível e ocioso; nunca durante uma sincronização avulsa, exceto as que o próprio apagamento inicia; três tentativas por momento e por aparelho; recusa antes da escrita (identidade bloqueada, sincronização pendente, conexão encerrada, pedidos demais) não gasta tentativa; resposta incerta encerra a passagem; depois de falha ou incerteza, o mesmo momento só volta numa abertura posterior e se o diário local ainda o mostrar sem apagamento; um registro que não se lê nunca é sobrescrito.

## Testes executados

Node 24.22.1, sem rede. Seleção: todo arquivo de teste alterado ou novo e todo arquivo de teste que cita o nome de um arquivo alterado, cada um executado sozinho com `node <arquivo>`: 261 arquivos (86 de `apps/app`, 56 de `apps/cli`, 2 de `apps/site`, 56 de `packages/core`, 4 de `packages/rpc`, 57 de `packages/web-member`). Todos passaram, sem falha intermitente.

Os arquivos que exercitam a mudança diretamente:

```text
node apps/app/test/momentCleanup.test.js: # tests = 17/17 pass; # asserts = 151/151 pass
node apps/app/test/momentCleanupPass.test.js: # tests = 18/18 pass; # asserts = 98/98 pass
node apps/app/test/useMomentCleanup.test.js: # tests = 20/20 pass; # asserts = 224/224 pass
node apps/app/test/coverBackfill.test.js: # tests = 19/19 pass; # asserts = 214/214 pass
node apps/app/test/coverBackfillPass.test.js: # tests = 23/23 pass; # asserts = 156/156 pass
node apps/app/test/legal.test.js: # tests = 77/77 pass; # asserts = 2464/2464 pass
node apps/site/test/legal.test.js: # tests = 7/7 pass; # asserts = 115/115 pass
node packages/core/test/terms.test.js: # tests = 8/8 pass; # asserts = 126/126 pass
node apps/cli/test/changelog.test.js: # tests = 9/9 pass; # asserts = 42/42 pass
```

Outros comandos:

- `npm run lint`: código 0.
- `npm run demo`: código 0, terminou com `DEMO OK`.
- `node apps/site/scripts/render-legal.js --check`: código 0 (as páginas de Termos e Privacidade do site batem com `legal.js`).

A suíte completa (`npm test`) roda na CI do GitHub, no Node 20 e no 24.

Testes que falham sem o que conferem (cada mudança foi desfeita numa cópia e restaurada byte a byte):

- `outcomeOf` olha `notSent` antes de `uncertain` (um pedido que nunca saiu da fila é recusa, mesmo quando a queda copiou um motivo incerto): com a ordem trocada, "outcomeOf maps the node answers" falha (16/17 testes, 150/151 asserções).
- Store da web: sem a proteção depois de uma leitura que falhou, "moment cleanup web store uses identity keys and refuses failed reads and writes" falha.
- Store nativo: sem a leitura da cópia de segurança, "moment cleanup native store keeps one atomic file and falls back to the backup" falha.
- Web Locks: com outro nome de lock, "web moment cleanup exclusive requires Web Locks and holds the lock until the pass settles" falha.
- Recusas: com uma mensagem a mais na lista da fila de envio (`outbox.js`), "cleanup refusals match the outbox retry messages" falha. O teste lê as duas listas e confere que cada mensagem da fila é tratada como recusa.

## Riscos residuais aceitos

1. **Esgotamento.** `moments.read` devolve no máximo 16 momentos em `past`. Se os 16 vencidos mais novos esgotarem as três tentativas naquele aparelho, os mais antigos que eles deixam de ser escolhidos ali. Com 17 momentos e 12 passagens com falha o caso se reproduz. Não corrigido: o limite de tentativas é o que impede repetir sem fim um pedido que falha.
2. **`LOCKED` no meio da escrita.** Um `LOCKED` do servidor depois de o pedido sair conta como recusa: a passagem termina e não tenta de novo nela. O mesmo momento volta numa abertura posterior.
3. **Sincronização vista um render depois.** `node.sync.starting` chega ao hook no render seguinte, a mesma exposição da drenagem da fila de envio. Fechar isso pede um getter síncrono em `node.js`, numa mudança separada.
4. **Relógio adiantado.** Um relógio do aparelho mais de 24 h adiantado apaga antes de 48 h reais; a margem cobre até 24 h.
5. **Sincronização de outro escritor.** Uma sincronização avulsa iniciada por outra escrita do nó (a passagem da capa automática, por exemplo) encerra a passagem, que pode terminar sem apagar nada naquela abertura. As sincronizações que o próprio apagamento inicia não encerram a passagem.
6. **Hora do apagamento visível.** O registro de apagamento leva a hora do aparelho, como qualquer registro do diário. Quem replica o diário vê quando o app apagou, poucos segundos depois de o app ficar ocioso numa abertura. Antes, abrir o app com momentos vencidos não escrevia nada. Arredondar essa hora mudaria o formato do registro.
7. **Texto da Privacidade.** O texto diz que o app apaga sozinho os momentos da pessoa dois dias depois de publicados, sem dizer que ele desiste de um momento depois de três tentativas por aparelho. Decisão da manutenção.

## Verificações em dispositivos, não executadas

1. **Android debug build: NÃO EXECUTADO.** Com um momento publicado há mais de 48 h e outro publicado entre 24 h e 48 h: abrir o app desbloqueado e online e esperar que fique ocioso. O primeiro sai de "Momentos anteriores" e o segundo fica. Com 5 vencidos, 4 saem e o quinto sai na abertura seguinte. Bloqueado, offline ou em segundo plano, nada é apagado e nenhuma tentativa é gasta. Um segundo aparelho da mesma conta vê o apagamento. Agindo como uma Página, os momentos da Página ficam. O aviso dos Termos 108 aparece. O debug não entra com passkey numa instalação de produção; a conferência com conta requer o APK de preview, conforme `docs/development.md`.
2. **Simulador iOS: NÃO EXECUTADO.** O mesmo roteiro. A entrada com passkey depende do domínio associado da conta Apple Developer.
3. **Web e PWA: NÃO EXECUTADO.** O mesmo roteiro, e duas abas abertas fazem uma passagem só (Web Locks).

A lista "Momentos anteriores" continua no perfil neste PR; ela sai no PR seguinte (`feat/profile-slim`).

Não executados: a suíte completa local (`npm test`, que roda na CI do GitHub), builds, emulador, simulador e navegador. Nenhuma rede externa foi usada.
