# test/deletion-roteiro

Fecha o último critério de aceite de #31: "Um roteiro verifica eliminação ou retenção fundamentada em cada componente". Nenhum código de produto muda. O roteiro tem duas partes: o teste de ponta a ponta `apps/cli/test/deletion-roteiro.test.js` e os passos manuais abaixo, para o que o teste não alcança.

## O teste

`roteiro: Excluir conta clears every component or keeps exactly what the docs say` sobe numa DHT local presa a `127.0.0.1` a cerimônia do operador pela CLI (associação, emissor, chave de moderação), um semeador real com os registros de selos ligados (`dm`), o serviço de conta real com todos os arquivos e um relógio que o teste adianta, e dois nós do navegador (`packages/web-member`): Ana, que exclui a conta, e Bia, o controle. As duas se vinculam pelo celular com convite, aceitam os Termos, e o semeador admite os diários (o de Ana com uma foto, então também o núcleo de mídia dela).

Depois, o teste planta os dados de Ana (e os de Bia) em todos os arquivos do serviço. Ana pede a exclusão pela rota real (`/account/delete/start`, `account.sign` com `phase: 'delete'`, `/account/delete/finish` com `wait: true`), sem passkey conferida, então ela fica agendada para 7 dias. O teste confere que nada sai antes da data, adianta o relógio, roda `deletionSweep()` e confere cada componente. Em seguida roda `mod apply --yes` no mesmo processo (a mesma função que o comando agendado chama) e confere o semeador. Por fim, adianta o relógio para 180 dias depois da exclusão e confere a retenção. Cada asserção nomeia o componente.

| Componente | O que a exclusão faz | Fundamento e prazo | Onde o teste confere |
|---|---|---|---|
| Diretório (`directory.*`) | Apaga o vínculo (sub, e-mail, certificado, registros, convite usado). Retém a chave pública, a data e os @nomes usados | Impedir que a chave volte e que o @nome vá para outra pessoa. Sem prazo (#38; `docs/design.md`, LGPD, "Conta excluída") | `directory: the link ... is gone`, `the deleted mark stays`, `the name resolves to no one`; depois, `/account/start` com a chave dela responde `conta-excluida` e outra chave com `ana` responde `nome-em-uso` |
| `terms.json` | Apaga | Sem base depois da exclusão | `terms.json: gone` |
| `age.json` | Apaga | ECA Digital: só enquanto a conta existe (LGPD, "Faixa etária do membro") | `age.json: gone` |
| `push.json` | Apaga | Consentimento: até desligar ou excluir a conta | `push.json: gone` |
| `recovery.json` | Apaga as entradas. Retém a marca de remoção de 30 dias, com a chave pública | Recusar uma entrada antiga reenviada | `recovery.json: gone`, `the 30-day removal mark stays, with her public key` (lido do arquivo) |
| `invites.json` | Apaga os convites que ela criou | Sem base depois da exclusão | `invites.json: the invites she issued are gone` |
| `invite-drops.json` | Apaga as marcas dela | Sem base depois da exclusão | `invite-drops.json: her marks are gone`, `Bia keeps hers (the week of the sweep)`. As linhas são por semana e saem quando a semana acaba, então cada uma das duas tem também uma marca na semana da varredura, que ainda vale nela: só a purga leva a de Ana |
| `seen/<chave>` | Apaga o bloco cifrado | Sem base depois da exclusão | `seen/<member>: the blob is gone` |
| `passkeys.json` | Apaga a chave da passkey e o agendamento. Retém a marca de 30 dias | Recusar a chave antiga reenviada | `passkeys.json: the key and the schedule are gone`, `no member row names her`, `the 30-day removal mark stays` (lido do arquivo) |
| `deletion-requests.json` | Apaga o pedido de Excluir conta sem a passkey (chave da conta e data) | Nenhuma: o pedido serve só até a operação agendar a exclusão | `deletion-requests.json: her SMS request is gone`; o de Bia fica |
| `phone.json` | Encerra a linha viva (`excluida`). Retém o número lacrado por 180 dias e então apaga | Impedir que uma conta bloqueada volte com o mesmo número (LGPD, "Número de celular selado"; Termos versão 36) | `phone.json: the live row is ended`, `the sealed number stays`; aos 179 dias, com a varredura do `phone.json` rodada (o teste a chama com as mesmas funções que `server.js` passa, porque a varredura de hora em hora não roda no teste e a passagem da moderação só a chama quando vencem os 180 dias), `nor the sealed number, with the phone sweep run`; aos 182 dias `the sealed number is gone` |
| `pages.json` | Apaga o convite pendente dela. Retém a lista assinada de administradores de uma página de outra pessoa | A lista é a declaração assinada do dono, que só ele muda (Remover) | `pages.json: her pending invite is gone`, `the owner's signed admins list waits`, `Bia's invite stays` |
| `page-invite-rosters.json` | Apaga as linhas dos convites dela | Sem base depois da exclusão | `page-invite-rosters.json: her roster is gone` |
| Triagem com IA (leituras, marcas, precedentes) | Apaga as que têm a chave dela como alvo | Sem base depois da exclusão. As cópias `.corrupt-<ms>` não saem (README, "Excluir conta") | `AI triage: the cached read about her is gone`, `the mark about her is gone`, `her precedents are gone`, `the copy about Bia stays`, `the precedent about Bia stays` |
| `moderation.json`, até 180 dias | Retém as denúncias. Enfileira o bloqueio da chave, `by: 'titular'` | Moderação e pedido legal: 180 dias depois da exclusão | `the reports stay until the 180-day pass`, `her block is queued, asked by the member`, `the block is acked` |
| `moderation.json`, depois de 180 dias | Apaga a denúncia sobre ela e a denúncia em aberto que ela fez. Retém, sem quem denunciou e com o trecho, a denúncia dela que levou a um bloqueio que continua | `forgetDeleted` (LGPD, "Denúncias de membros") | `the report about her is gone`, `her open report is gone`, `her report behind a block still in force stays`, `with no reporter`, `her comment goes`, `the quote stays` (a denúncia dela sobre uma publicação de Carol, com trecho: `carries a quote`) |
| Lista de bloqueio | Retém a chave para sempre (uma das 16384 vagas) | É o que tira o diário da rede e impede a volta | `blocklist: Ana (titular) and Carol (moderation)`, e `her block stays for good` aos 182 dias |
| `GET /account/status` | `pendente` até a lista chegar ao semeador e o painel confirmá-la, depois `concluida` | O app avisa a pessoa | `status: pendente ...`, `status: concluida ...` |
| Registro do serviço de conta | Nenhuma linha leva a chave dela | Sem dado pessoal em log | `account service log: no line names her key` |
| Semeador: diário e núcleo de mídia | Para de servir e apaga ao adotar a lista | Diretriz de 7 dias dos Termos | `seeder: still serving until the list arrives`, depois `her media core is dropped`, `Bia stays`, e Ana fora de `admittedKeys()` |
| Semeador: `admitted.json` | Nenhuma linha cita o diário nem o núcleo de mídia | Idem | `seeder admitted.json: written, and it names Bia`, depois `no row names her diary`, `... her media core` |
| Semeador: `dm-stamps.json`, `blob-stamps.json`, `copy-stamps.json` | Apaga as linhas do diário dela; as de Bia ficam | Idem | `seeder <arquivo>: her stamp rows are pruned, Bia's stay` |
| Semeador: nova admissão | Recusa (`rejected`, `blocked`) | Idem | `seeder: her diary is refused (rejected, blocked)` |

Componentes que o teste não alcança, e por quê:

- **Grupos no semeador** (núcleos de escritor dela e as raízes que ela vinculou): o `_drop(key, 'blocked')` os leva junto (`docs/design.md`, "Reter os núcleos"), mas montar uma comunidade no teste custaria mais que o resto. O bloqueio de grupos no semeador tem testes próprios em `packages/core/test/` (por exemplo `blocklist-seeder.test.js` e `seeder-communities.test.js`); este roteiro não conferiu se eles cobrem uma conta excluída.
- **Blobs de momentos no semeador**: o bloqueio os apaga (`_purgeMomentBlobs`, PR #687, testado em `packages/core/test/blocklist-seeder.test.js`).
- **Índices e avisos do semeador**: saem no mesmo `_drop`. O teste não os planta.
- **Réplicas de páginas** (`pages-replicas`): apagadas a cada partida e, as de uma chave bloqueada, na varredura seguinte à publicação da lista (README, "Excluir conta"). O teste não cria página nem grupo de página.
- **Dados locais do nó do navegador** (`packages/web-member`, kv no IndexedDB) e **do app nativo**: o teste usa armazenamento em memória. A web fica nos passos manuais 1 a 6; o app nativo, na issue #224 (tabela abaixo).
- **Provedores fora da Varanda** (serviço de push do fabricante, Didit para idade e SMS): não há como conferir de dentro do teste. Ficam na tabela abaixo.

## Fora do serviço e do semeador

| Componente | O que a exclusão faz | Fundamento e prazo | Como se confere |
|---|---|---|---|
| Nó do navegador (`packages/web-member`: kv no IndexedDB, cache de mídia das conversas de até 256 MiB, posts salvos, cópia da primeira página da Rua) | Com passkey conferida, o app desliga o push enquanto a chave ainda assina e apaga o aparelho como Recomeçar (`node.passkey.reset()`, a fila de envio da conta), guardando só o recibo (chave pública e data). Na exclusão agendada, nada se apaga até a data; depois, a tela `ContaExcluida` bloqueia o app até Apagar deste aparelho | `apps/app/src/screens/ExcluirConta.js`; LGPD, "Recibo da exclusão no aparelho": até tocar em Entendi | Exclusão na hora e apagamento do aparelho que pediu: passos 3 e 4. `ContaExcluida` e o apagamento de um segundo aparelho: passos 5 e 6. Caminho agendado: só a decisão é conferida, em `apps/app/test/accountDeletion.test.js` (`requestDeletion: without a stored passkey ... asks to wait and keeps push on`); a espera de 7 dias na tela fica para a issue #224 |
| App nativo (Android e iOS: dados do nó no worklet, `varanda-saved-posts.json`, caches) | O mesmo código de tela: `identity.reset` no nó do worklet e o registro local da passkey (`apps/app/src/identity.native.js`, `reset`) | Idem | Não conferido aqui: o build de debug não entra numa instalação de produção, então os passos 9 e 10 só abrem a tela. O apagamento no Android e no iOS fica para a issue #224 |
| Cópias em aparelhos de quem segue e em semeadores fora da associação | Retém | A associação não controla essas cópias (LGPD, "Publicações e perfil") | Não se confere |
| Serviço de push do fabricante (FCM, Mozilla, Apple) | O `push.json` sai; o endereço registrado no fabricante só some quando o navegador ou o sistema o descarta | Consentimento; fora do Brasil (LGPD, "Inscrição de Web Push") | Não se confere |
| Didit, verificação de idade | A Varanda nunca recebe rosto nem documento; o `age.json` sai | Retenção mínima configurada no parceiro (LGPD, "Imagem do rosto e documento") | Painel do parceiro, pelo operador |
| Didit, SMS | A Varanda guarda só o número lacrado (linha `phone.json` acima) | Retenção mínima no parceiro (LGPD, "Número de celular e código de uso único") | Painel do parceiro, pelo operador |
| Cache HTTP do cliente: `/media/*` | Retém no navegador de quem já viu até o cache sair | `Cache-Control: public, max-age=31536000, immutable` (`apps/cli/lib/seed-ws.js`, linha 389): o endereço é a chave do conteúdo, e o semeador para de servir ao adotar a lista | Passo manual 8 |
| Cache HTTP do cliente: `/blob/*` | Retém até 7 dias no navegador de quem já abriu | `Cache-Control: private, max-age=604800` (`apps/cli/lib/seed-ws.js`, linhas 228 e 398), mais curto que os 14 dias do conjunto | Passo manual 8 |
| Backups do volume `account-data` e do semeador | Retêm o que estava no volume na data da cópia | Rotação de no máximo 30 dias e refazer as exclusões ao restaurar (decidido, ver "Decidido" abaixo) | Não se confere: é prática do operador |

### Decidido

Os mantenedores decidiram (Rodrigo: "30 days, docs only"): os backups do volume `account-data` e do diretório de dados do semeador giram em no máximo 30 dias, e depois de uma restauração o operador refaz as exclusões concluídas desde a data da cópia. Está na última linha da tabela da seção "LGPD" de `docs/design.md` e no parágrafo "Backups e exclusões" do README, na seção da exclusão de conta. Não houve mudança na Política de Privacidade nem nos Termos. Limite: nenhum comando lista as exclusões por data, então o operador guarda a lista do `directory.json` (objeto `deleted`) antes de restaurar, como o README descreve; este roteiro não confere a rotação nem o refazer, que são prática do operador.

Resíduos: (1) `account delete --yes` só agenda; até a varredura do serviço, depois que ele abre, o vínculo da cópia (e-mail, `sub`, celular, passkey, recuperação) volta a valer, o bloqueio publicado só mantém o diário fora dos semeadores e a pessoa pode cancelar por um aparelho em 7 dias, sem comando que conclua antes. (2) Uma cópia mais antiga que `directory.hwm` é recusada pelo serviço e pelo `--yes` até o operador a reconhecer como o README descreve, o que uma cópia de dias costuma não permitir: então se procura uma cópia mais recente.

## Entradas que este roteiro não percorre

- Excluir conta sem a passkey (PR #770, já na `main`): o código certo só grava um pedido em `deletion-requests.json`, sem agendar nada, e é coberto por `apps/cli/test/account-delete-sms.test.js`. A operação agenda depois com `varanda account delete --yes --force`, a mesma espera do item abaixo. O roteiro grava um pedido para Ana e Bia e confere que a purga apaga o de Ana e mantém o de Bia.

- `varanda account delete` (PR #762, já na `main`): grava a mesma espera (`passkeys.schedule`) que a rota e é coberto por `apps/cli/test/account-delete-cli.test.js`. O roteiro agenda pela rota, e a varredura depois de qualquer um dos dois caminhos é a mesma (`apps/cli/lib/account/deletion.js`).

## Passos manuais

Laboratório web primeiro (`docs/development.md`, "Instalação hospedada local"):

1. `npm run web -w apps/app` e `node apps/cli/scripts/hosted-lab.js`. Abra `http://localhost:8080` num perfil A do Chrome com o autenticador virtual com PRF e entre com um celular e o código `123456`.
2. Publique uma foto, salve uma publicação, abra uma conversa com uma segunda conta (perfil C, outro celular) e mande uma foto. No perfil A, crie um código de recuperação (Ajustes › Passkeys e recuperação) e abra a mesma conta num perfil B com ele (Entrar › Outras formas de entrar › Entrar com código de recuperação, depois uma passkey nova), como em `docs/development.md`.
3. No perfil A, Ajustes > Excluir conta: digite o @nome e confirme com a passkey. Esperado: a exclusão roda na hora (a passkey de A foi registrada logo depois do vínculo) e o app volta para Entrar com o recibo.
4. No perfil A, DevTools > Application: o IndexedDB do nó e o armazenamento local da conta estão vazios, exceto o recibo; o cache de mídia das conversas não tem entradas da conta.
5. No perfil B, recarregue: esperado, a tela `ContaExcluida` ("Apagar deste aparelho") no lugar do app, com o texto de `pendente`.
6. No perfil B, toque em Apagar deste aparelho e repita a conferência do passo 4.
7. `curl http://localhost:8080/account/status?member=<chave>` responde `{"linked":false,"deleted":"pendente"}`. O laboratório não tem chave de moderação, então não chega a `concluida`: o semeador é conferido pelo teste.
8. No perfil C, a foto de Ana já vista continua no cache HTTP (DevTools > Network, `from disk cache`), como a tabela diz. No laboratório o semeador continua servindo o diário, porque a lista não é publicada (passo 7).

Depois, no emulador Android e no simulador iOS, com o build de debug. Eles só conferem a tela, não o apagamento:

9. Android (emulador, `docs/development.md`, "Android"): abra Ajustes > Excluir conta e confira a tela, os textos e a digitação do @nome.
10. iOS (simulador, `docs/development.md`, "iOS"): os mesmos passos do 9.

Entrar com passkey numa instalação de produção não funciona no build de debug. A exclusão com sessão de verdade no Android e no iOS (`identity.reset` no worklet, o aparelho apagado, a tela `ContaExcluida` num segundo aparelho, o recibo) e a espera de 7 dias do caminho agendado ficam para a issue #224.

## Comandos

```sh
npx standard apps/cli/test/deletion-roteiro.test.js
node apps/cli/test/deletion-roteiro.test.js
```
