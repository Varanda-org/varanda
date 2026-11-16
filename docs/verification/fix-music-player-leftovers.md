# Sobras da música e do Audius (branch fix/music-player-leftovers, issue #537)

Este PR fecha a #537: corrige os limites que o dono mandou corrigir, registra os que ele aceitou e leva para o checklist do operador na #224 o que depende do Audius, do servidor ou de uma conta de verdade.

## Decisões do dono (16/11/2026)

- `VARANDA_AUDIUS_MOMENTS` e `VARANDA_AUDIUS_COVERS`: decisão adiada ("don't worry about that now"). Os dois interruptores continuam desligados por padrão, sem frase nova na Privacidade e sem mudança no código. A pergunta por escrito ao Audius (api@audius.co) e as conferências do operador de §185 foram para a #224.
- Orçamento diário do Audius: teto por conta, um décimo do orçamento da instalação.
- Players de música: corrigir os dois limites do #528 (teclado em Publicar e chave "Prévia de links"), com Termos 64.
- Capas: corrigir o caso do host da capa fora do ar; aceitar os outros limites.

## O que mudou

- [x] Serviço de conta, orçamento por conta (`MEMBER_BUDGET_PER_DAY` = 1.200 de `PROVIDER_PER_DAY` = 12.000, em `apps/cli/lib/account/audius-routes.js`): consultas, aberturas de áudio e contatos com o host das capas gastam primeiro a parte da conta e depois o orçamento comum. Passado o teto, a conta recebe 429 `limite-musica`, o uso da rota volta, o orçamento comum não é tocado e as outras contas continuam. O registro `audius` não sai quando quem parou foi a parte da conta.
- [x] Serviço de conta, capa que falhou depois de falar com o host (queda, prazo, 5xx, 429, resposta parcial): fica guardada como falha por `ART_RETRY_MS` (60 s). Nesse tempo, o pedido da mesma capa responde 503 `indisponivel` sem falar com o host e devolve o uso da conta. Uma falha não substitui uma capa boa guardada para outro endereço (a falha era mais antiga) e, com o cache cheio (128 linhas), não é lembrada, para não empurrar capas boas para fora.
- [x] App, chave "Prévia de links" desligada: nenhum player de YouTube, SoundCloud, Spotify ou Apple Music carrega, os carregados fecham (`holdAllEmbeds` em `App.js`) e o cartão aparece como os outros (`LinkCard`, um toque abre o link). O estado vem de `usePreviewsEnabled` (`apps/app/src/ui/usePreviewsEnabled.js`), que segue a chave desta aba (`onPreviewsChange`) e, na web, a de outra aba (evento `storage`, `onPreviewPrefStorage`). A nota de Ajustes diz isso.
- [x] App, teclado: a parte coberta pelo teclado conta como fora da tela para o player (`useKeyboardHeight` em `keyboardAvoid.js`, usado em `MusicEmbedCard.js`). Vale para a prévia de Publicar e para qualquer cartão atrás do teclado no app instalado. Na web o `Keyboard` do react-native-web não emite eventos e a altura da janela já segue o `visualViewport`, então nada muda lá.
- [x] Termos e Política na versão 64 (`packages/core/lib/terms.js`, `apps/app/src/legal.js`, páginas do site geradas com `node apps/site/scripts/render-legal.js`, linhas LGPD de `docs/design.md`, parágrafo da exceção em `AGENTS.md`). O item de §203 "Em Publicar, o player da prévia pode carregar mesmo com o teclado por cima" deixa de valer: agora ele não carrega enquanto o teclado cobre a prévia.

## Limites aceitos pelo dono

- Teto de 3 capas por conta em carga ao mesmo tempo: a quarta recebe 503 (#509).
- O áudio do Audius é cortado em 15 minutos e o cliente pede o resto com `Range` (#501).
- Spotify e Apple Music em geral tocam só a prévia da música (#500).
- Termos 38 a 43 seguem aguardando revisão jurídica na #44.

## Testes automáticos

- [x] `node apps/cli/test/audius-routes.test.js`: 81/81 depois do merge com a `main` (que trouxe os testes do #667; toda abertura de áudio, a do endereço guardado inclusive, passa pelo teto por conta). Testes novos: "a cover fetch that failed after a host contact is answered 503 for ART_RETRY_MS, with no contact and the use given back"; "each member spends at most MEMBER_BUDGET_PER_DAY" (consultas, capas e áudio); "a failed fetch of an older href leaves the newer cover held"; e, no teste do cache cheio, a falha que não é lembrada e não empurra capa boa. Testes antigos ajustados: a falha depois de um contato agora é lembrada (`covers` = número de falhas) e o teste da capa 480 confere a segunda volta sem contato.
- [x] Cada regressão falha sem a correção, conferido revertendo cada uma: sem o orçamento por conta, o teste do teto falha; sem a falha lembrada, o teste dos 60 s falha; sem as duas guardas de `storeArt`, "with the cache full, a failure is not remembered" (1 contra 2), "and pushes no good cover out" (131 contra 132) e "the newer cover is still held" (3 contra 2) falham.
- [x] `npm run lint` limpo e `npm run demo` com "DEMO OK", depois do merge com a `main`.
- [x] `npm test -- --affected=origin/main`: 794 arquivos, 3 falhas. `apps/site/test/legal.test.js` ainda esperava a versão 63 (corrigido para 64; o arquivo passa, 115/115). `apps/cli/test/update.test.js` (tempo do arquivo esgotado) e `packages/core/test/private-member-3.test.js` (um teste passou dos 30 s) falharam sob carga e passam sozinhos com `node <arquivo>`: 73/73 e 5/5. Nenhum dos dois toca o que esta branch muda.
- [x] `apps/app/test/musicEmbedCard.test.js` 84/84, `apps/app/test/previewPref.test.js` 6/6 (inclui o ouvinte da chave e o evento `storage` da web), `apps/app/test/platformGate.test.js` 6/6, `apps/app/test/legal.test.js` e `packages/core/test/terms.test.js` (versão 64, nota de revisão, frase nova e digest do texto).

## Revisão

Revisão por um subagente Claude em outro modelo (Sonnet), um só fornecedor de IA. Nenhum P1. Tratamento:

- P2, Android, corte duplo se a altura da janela encolher com o teclado: não acontece. No Android a altura vem de `context.resources.displayMetrics` (`DisplayMetricsHolder.kt` do React Native), que o teclado não muda; no iOS a janela também não muda; na web a altura da janela muda, mas a do teclado fica 0.
- P2, web, outra aba mudando a chave: corrigido com `onPreviewPrefStorage`, com teste.
- P2, sem teste de comportamento do componente: o padrão do projeto é ler a fonte (`withoutComments`); a lógica pura tem teste.
- P3, falha substituindo capa boa de outro endereço e falha empurrando capas boas com o cache cheio: corrigidos em `storeArt`, com teste.
- P3, teclado flutuante no iPad: aceito, o corte é conservador (o player só deixa de carregar na faixa coberta).
- P3, `holdAllEmbeds` chamado de fora de `Member`: não há outro chamador.

## Aparelhos

Debug pelo Metro (porta 8105) com a Vitrine grande, rica e com players (`EXPO_PUBLIC_VARANDA_VITRINE=1`, `_LARGE=1`, `_RICH=1`, `_EMBEDS=1`), sem conta e sem nó.

- [x] Android, emulador `varanda-api36-parity` (API 36, 1080x2400): o player do YouTube aparece sem toque quando o cartão fica visível e nada soa antes do play. Ajustes mostra a nota nova da chave. Com a chave desligada, de volta a A Rua o cartão do YouTube é "Abrir link: YouTube" e o processo do WebView do player sai; um toque abre o link fora do app (o app do YouTube abriu; a permissão de notificação dele foi recusada). Com a chave religada, o player carrega de novo.
- [x] Android, Publicar: a prévia do YouTube acima do teclado carrega (o teclado não a cobre). O caso da prévia coberta pelo teclado não se reproduziu no emulador: o compositor mantém a prévia acima do teclado e o campo de texto tem altura limitada. A regra fica coberta pelos testes de `musicEmbedCard.test.js` (faixa acima do teclado e `useKeyboardHeight`).
- [x] Android, sob carga (máquina com load ~25 e o emulador a 74% de CPU): um ANR ao mandar 12 teclas ENTER seguidas pelo adb, que não voltou ao repetir devagar; e uma queda do próprio emulador (SIGABRT no netsim/Vulkan), sem relação com o app. Depois de reiniciar o emulador, as conferências acima passaram.
- [x] iOS, simulador iPhone 17 Pro: o player do YouTube aparece sem toque em A Rua. Com a chave desligada em Ajustes (a nota nova aparece), o cartão vira um link ("YouTube, www.youtube.com"), e a chave continua desligada ao reabrir Ajustes. Religada, o player volta a carregar sem toque.
- [x] Web, `http://localhost:8105/` em 375x812: o iframe do YouTube carrega perto da parte visível. Ao desligar a chave, o iframe fecha na hora (1 para 0) com Ajustes ainda aberto, e em A Rua o cartão é "Abrir link: YouTube, www.youtube.com". Com a chave mudada em outra aba da mesma origem (`localStorage`), esta aba segue nos dois sentidos: ligada, o player volta; desligada, fecha. No teclado, a web não muda (veja "O que mudou").

## Fora do alcance desta branch

Na #224 (checklist do operador), sem issue nova:

- Resposta por escrito do Audius (api@audius.co) e as conferências do operador de §185 contra a API real (lugar da chave, resolve e `permalink`, redirecionamento e `Range`, `Content-Type`, forma de `access`, Caddy repassando 206 sem buffer, log do Caddy). `VARANDA_AUDIUS_MOMENTS` e `VARANDA_AUDIUS_COVERS` desligados até a decisão do dono.
- Instalar os Termos 64 junto com o build do app e do site.
- As conferências com conta e com o Audius de verdade que a Vitrine não alcança: §186 (Audius em publicações), §187 (momentos com música), §199 (seletor e editor), §200 (capas, com chave de teste), §201 (aceite dos Termos 42), o aceite dos Termos 64 por uma conta que aceitou a 63, e de §184 e §203 o que pede conversa privada, grupo, citação, Buscar, tela empilhada, folhas por cima, rotação em tela cheia, `on.soundcloud.com`, PWA e inspetor de rede.
- O link do SoundCloud da Vitrine é um exemplo sem faixa ("You have not provided a valid SoundCloud URL"): o player abre, mas não há faixa para tocar. Não é desta mudança.
