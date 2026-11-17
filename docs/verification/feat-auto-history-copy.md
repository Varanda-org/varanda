# Cópia automática do histórico (feat/auto-history-copy, #351)

## Decisões

- Quando um aparelho novo da mesma passkey aparece, um aparelho registrado antes dele faz a cópia em segundo plano, uma vez por aparelho novo. Com vários aparelhos antigos abertos, só um copia: o dono da reserva (inner v8) de menor posição no conjunto que não está vencida.
- Primeiro o texto (manifesto v3, sem fotos lacradas de novo), depois as fotos do armazém próprio guardadas no cache, das mais recentes para as mais antigas, em lotes (manifesto v2), só com a cota semanal de cópia. Os dois manifestos nomeiam os aparelhos alvo (`for`), e o recebedor confere isso mesmo sem ter a reserva; o v1 continua aceito só para uma cópia feita à mão numa versão anterior. Versões anteriores do app encerram o v3 como morto e não importam nada.
- Um aparelho desconectado não faz nem recebe cópia. Uma cópia interrompida continua na próxima abertura do app.
- Sem linha nem folha em Conversas: `dm.historyCopy` e `dm.copyProgress` saem; o aviso do aparelho que recebe (`dm.copyImported`, "Conversas copiadas de outro aparelho") fica. Termos 83.
- Nenhuma tela nos aparelhos antigos avisa que um aparelho novo entrou, e nada pede confirmação antes da cópia (decisão da manutenção). Os Termos e a Política dizem isso com todas as letras: qualquer aparelho novo que entrar com a passkey recebe o histórico, então é preciso guardar bem a passkey e desconectar em "Aparelhos conectados" o aparelho que a pessoa não reconhece, o que também interrompe uma cópia em andamento. O `docs/protocol.md` registra o risco na seção 11 e nos riscos residuais das mensagens diretas.
- Uma cópia em andamento confere de novo, antes de cada parte, se o aparelho alvo continua na lista e ligado e se este aparelho não foi desconectado; se não, o trabalho acaba sem contar falha.
- A sessão diz ao motor de cópia que o aparelho está desligado assim que lê um registro de desconexão, e que está ligado só depois que uma sincronização desta destrava, ou a sincronização contínua viva, alcançou o diário próprio: um diário atrasado ainda pode mostrar como ligado um aparelho desconectado. Quando a sincronização contínua perde a conexão ou vê o diário próprio atrasado, a sessão esquece que ele estava em dia e toda importação espera de novo, até essa sincronização alcançar o diário próprio; uma cópia que este aparelho faz para outros continua. O copiador também só lê a lista de aparelhos com o diário próprio em dia. A importação confere de novo antes de cada parte, de cada armazém e de cada foto.
- `copyView` ignora um aparelho cujo primeiro registro tem data mais de uma hora (`COPY_SINCE_SKEW_MS`) depois de agora: essa data vem do relógio de quem registrou, e uma data no futuro manteria o aparelho como alvo depois da janela.

## O que muda

`packages/rpc` (inner v8, `dm.historyCopy` e `dm.copyProgress` removidos), `packages/core` (v8 em `dm.js`, `copyView` em `devices.js`), `packages/web-member` (`dm-copy.js`: reserva, vencedor, etapas de texto e fotos, retomada; recebedor), `apps/app` (sem a linha e a folha, aviso mantido), Termos e Política (versão 83) e o espelho em `apps/site/public`, docs (`protocol.md` seção 11, `rpc.md` 5.156 e seção 6, `design.md`), `AGENTS.md`.

## Testes automáticos

Cada arquivo rodou sozinho (`node <arquivo>`, Node 24.22.1), com a mudança inteira aplicada.

| Arquivo | Resultado | Sem a correção |
|---|---|---|
| `packages/rpc/test/methods.test.js` | 163/163 testes, 7511 asserções | com `dm.historyCopy` de volta, o teste que exige a recusa falha |
| `packages/rpc/test/envelope.test.js` | 17/17, 168 | com `dm.copyProgress` de volta, falha |
| `packages/rpc/test/dm-budget.test.js` | 16/16, 260 | sem `DM_INNER_KEYS_V8`, o teste do v8 falha |
| `packages/core/test/dm.test.js` | 69/69, 1582 | sem o inner v8, os quatro testes do v8 falham |
| `packages/core/test/devices.test.js` | 14/14, 104 | sem `copyView`, falha; sem o limite de `COPY_SINCE_SKEW_MS`, "a first record dated more than the skew ahead: left out" falha |
| `packages/core/test/terms.test.js` | 8/8, 126 | fixa a versão 83 |
| `packages/web-member/test/dm-copy-auto.test.js` | 24/24, 151 | veja as mutações abaixo |
| `packages/web-member/test/dm-copy-auto-e2e.test.js` | 2/2, 24 | com `claimWins` sempre verdadeiro, duas cópias de texto (esperada uma); com o recebedor ignorando `off`, o aparelho desligado busca e importa |
| `packages/web-member/test/dm-copy-auto-e2e-2.test.js` | 1/1, 8 | veja "Outras mutações" (a cópia importa com a conexão caída) |
| `packages/web-member/test/dm-copy-e2e.test.js`, `-2`, `-3`, `-4` | 2/2 e 37, 2/2 e 24, 2/2 e 18, 2/2 e 33 | no `-2`, o semeador de teste recusa a compra de selo de cópia com `teto`; no `-3`, com a sessão passando toda visão do aparelho ao motor, a cópia importa logo depois de destravar de novo, antes de o diário próprio estar em dia |
| `packages/web-member/test/dm.test.js` | 81/81, 782 | sem o `catch` em `pull`, o teste "a pull that fails after a complete one leaves the automatic copy waiting" falha (a reserva sai depois de uma leitura que falhou) |
| `packages/web-member/test/dm-copy-unit.test.js`, `dm-copy-unit-2.test.js` | 4/4 e 37, 18/18 e 97 | |
| `packages/web-member/test/session.test.js`, `session-devices`, `session-dm-unlock`, `devices-auto-e2e`, `devices-ops` | 79/79 e 735, 3/3 e 16, 19/19 e 112, 1/1 e 24, 8/8 e 70 | |
| `apps/app/test/historyCopy.test.js` | 3/3, 21 | |
| `apps/app/test/legal.test.js`, `help.test.js`, `vitrine.test.js`, `terms-version.test.js`, `platformGate.test.js` | 58/58 e 1899 (depois de juntar a `main` com os Termos 82), 15/15 e 566, 49/49 e 4277, 1/1 e 2, 6/6 e 786 | |
| `apps/site/test/legal.test.js` | 7/7, 115 | |

Mutações em `packages/web-member/lib/dm-copy.js`, uma de cada vez, com `dm-copy-auto.test.js` (cada uma desfeita depois, e o arquivo conferido igual ao original com `cmp`):

| Mutação | Teste que falha |
|---|---|
| `claimWins` sempre verdadeiro | "two old devices kick at once: exactly one claim wins and one text copy goes" (duas cópias) |
| o copiador ignora `off` | "an off copier claims nothing, and a target that left the view ends the job" |
| o recebedor ignora `off` | "a disconnected device imports nothing, and one not told who it is waits" |
| a retomada do trabalho vira descarte | "a lock in the text stage: the next open goes on from the record, with no second claim" |
| `TODO_MAX` de volta a 8 | "a pull that brings the text pointer with many photo batches still imports the text" |
| sem a espera do texto antes de um lote de fotos | "a photo batch waits while the text of its copy has not imported yet" |
| sem a contagem de falhas (`failJob`) | "a seeder that keeps refusing the photos ends the job after three kicks, not the weekly allowance" |
| sem a conferência antes do ponteiro de texto | "a target disconnected while the text is sealed: the text pointer never goes" e "this device turned off while the text is sealed..." |
| a conferência ignora este aparelho desligado | "this device turned off while the text is sealed: the text pointer never goes" |
| sem as conferências da etapa de fotos (todas, as duas do lote ou só a primeira do lote) | "a target disconnected in the photo stage: no batch goes and nothing more is sealed" |
| qualquer erro da compra do selo vira fim da cota, ou a fonte que falhou não é marcada | "a copy stamp purchase that fails for now fails the kick, and the next kick buys with a new source" |
| o fim da cota semanal nunca é visto | "the weekly allowance ending mid-photos sends the batch held so far and ends the job" |
| a retomada ignora uma leitura incompleta | "a device whose last pull did not complete resumes nothing and counts no failure" |
| a espera da reserva engole a falha da leitura | "a pull that fails while the claim settles keeps the job at its claim" |
| uma foto que não abre é ignorada no lote | "a photo that does not open keeps its batch for the next pull" |
| um ponteiro sem reserva guardada importa antes de o aparelho saber quem é | "a pointer with no kept claim waits until the device is known, and only a device that is on imports it" |
| reservas de outros aparelhos contam como deste | "claims by other devices do not use up this device's claims for a target" |
| reserva vencida não é tratada como vencida (na escolha dos alvos ou do vencedor) | "a stale claim by another device is taken over, a fresh one is not" |
| sem a conferência no começo do texto | "a job whose claim is already near stale spends nothing on its text" |
| sem a condição de retenção na busca antecipada | "an imported copy prefetches only the originals still inside the retention" |
| o recebedor não confere o `for` do manifesto v3 | "a text copy goes only to the devices its manifest names, even when its claim never reached them" |
| o manifesto de texto volta a ser v1, sem `for` | o mesmo teste |
| sem a conferência antes de cada armazém na importação | "a device turned off while it imports a copy files nothing more and drops the copy" |

Outras mutações, cada uma desfeita e conferida com `cmp`:

| Mutação | Teste que falha |
|---|---|
| `copyView` sem o limite de `COPY_SINCE_SKEW_MS` (`packages/core/lib/devices.js`) | `devices.test.js`, "copyView: on devices registered after this one, inside the window" |
| a sessão passa toda visão do aparelho ao motor, sem esperar o diário próprio (`feedDevice` em `packages/web-member/lib/session.js`) | `dm-copy-e2e-3.test.js`, "a lock right after a page that held the pointer leaves the copy noted: the next unlock imports it once the own diary is caught up" (importa antes de a sincronização alcançar o diário próprio) |
| a queda da conexão da sincronização contínua não segura as importações (`holdCopyImports` sem efeito em `packages/web-member/lib/session.js`) | `dm-copy-auto-e2e-2.test.js`, "a copy that reaches a device whose link dropped waits until its own diary is caught up again" (a cópia importa com a conexão caída) |
| a espera nunca é ligada no motor (`holdImports` em `packages/web-member/lib/dm-copy.js`) | o mesmo teste |

Sem teste próprio: o caminho do diário próprio atrasado (`own-behind`) segura as importações pela mesma função que a queda da conexão, que o teste acima cobre; a conferência antes de cada parte na importação (só economiza leituras; a que impede arquivar é a de antes de cada armazém, acima), a conferência no começo de cada pendência em `importPass` (repete a primeira conferência de `importOne`) e a regra de que o copiador (`copyKick`) só lê a lista de aparelhos com a sincronização contínua em dia com o diário próprio (reproduzir um diário que fica para trás no meio da execução pede dois escritores disputando a conexão, sem jeito determinístico no e2e).

## No emulador Android (build de debug), no simulador iOS e na web

Em 17/11/2026, nesta ordem: emulador Android (build de debug), simulador iOS (iPhone 17 Pro) e web (navegador com tela de 375 x 812), todos no modo vitrine (`EXPO_PUBLIC_VARANDA_VITRINE=1`, conta de exemplo, sem conta real). A vitrine não tem nó, então o aviso do aparelho que recebe foi disparado aplicando `dm.copyImported` (12 mensagens) ao `copyStore` do app: pelo inspetor do Hermes no Android e no iOS, pelo console na web.

- [x] Conversas, destrancado: não aparece a linha "Copiar conversas para outro aparelho" embaixo dos filtros (Android, iOS, web).
- [x] Ajuda de Conversas (ⓘ): a linha da cópia diz que, num aparelho novo com a mesma passkey, as conversas chegam sozinhas, primeiro o texto e depois as fotos (Android, iOS, web).
- [x] O aviso "Conversas copiadas de outro aparelho" ("12 mensagens chegaram de outro aparelho seu...") aparece no topo de Conversas e some no "Entendi" (Android, iOS, web).
- [x] Ajustes › Termos e privacidade mostra a versão nova com a data de 17/11/2026 (conferida com o número 84, antes de a numeração passar a 83; o número é conferido por `apps/app/test/legal.test.js`), e os parágrafos da cópia nos Termos e na Política descrevem a cópia automática (Android, iOS, web). A vitrine simula uma conta que já aceitou a versão atual, então o pedido de aceite da versão nova não aparece nela; ele fica para a conferência com conta na #224.
- [ ] PWA instalada: não foi aberta. Ela roda o mesmo pacote da web.

A frase dos Termos e da Política sobre a passkey ("Qualquer aparelho novo que entrar com a sua passkey...") entrou depois destas capturas; o texto exato é conferido por `apps/app/test/legal.test.js` e `apps/site/test/legal.test.js`.

Visto no iOS: no iPhone 17 Pro, a última linha do parágrafo da cópia na Política sai cortada (a palavra "conversas" encosta na borda e "dele." não aparece, com uma linha em branco embaixo). O Android e a web mostram o parágrafo inteiro, o texto só tem caracteres e espaços comuns, e a tela dos Termos (`Termos.js`) não muda neste PR: o corte vem do jeito como essa tela desenha o parágrafo no iOS, e a causa exata não foi isolada. Fica como acompanhamento.

## Com conta real e dois aparelhos (fica para a #224)

- [ ] Aparelho A com conversas e fotos; entrar com a mesma passkey num aparelho B novo: o texto chega em B em poucos minutos sem nenhum toque em A, e depois as fotos, das mais recentes para as mais antigas; B mostra o aviso.
- [ ] Dois aparelhos antigos abertos (A e C) quando B entra: só um deles copia (uma reserva vencedora, um só gasto da cota semanal).
- [ ] Fechar o app de A no meio das fotos e abrir de novo: a cópia continua de onde parou.
- [ ] Desconectar B em "Aparelhos conectados" antes da cópia: A não copia para B, e B não importa nada.
- [ ] Um aparelho que já recebeu uma cópia não recebe outra quando um terceiro aparelho entra.
