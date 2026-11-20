# Páginas da ficha do Google Play (branch feat/play-store-pages)

Só site e texto da ficha. Sem mudança de RPC, formato ou Termos. As páginas `excluir-conta` e `seguranca-infantil` são geradas por `apps/site/scripts/render-legal.js`, que cita parágrafos do `legal.js` (versão 108) por prefixo exato e falha se um sumir ou se repetir.

## O que mudou

- Merge de `origin/main` (51e5f404) na branch. Conflitos em `render-legal.js` (mantidas as páginas de informação, tomada a frase nova de `main`) e em `index.html` (tomado `main`, com os dois links do rodapé recolocados à mão). `termos/` e `privacidade/` foram regerados.
- Prefixo de retenção que não achava mais nada na versão 108 trocado por "Ao excluir a conta, o número do celular lacrado".
- Excluir conta: caminho com passkey, caminho sem passkey (o SMS só registra o pedido, a pessoa escreve para contato@varanda.app e a equipe confirma antes de a exclusão ser agendada), retenção e limites P2P citados do `legal.js`. Sem a passkey, a página cobre o aparelho perdido (passkey sincronizada ou código de recuperação), o número recuperado na operadora, a conta do Google (e-mail da conta) e o caso sem nada que prove a conta, sem inventar procedimento além dos Termos.
- `play-screens.test.js` falha quando falta uma das quatro capturas (antes passava com a pasta vazia).
- Segurança infantil: proibições, denúncia e parágrafo de Contato, sem prometer nada além dos Termos.
- `apps/site/artwork/play/listing.pt-BR.json` e `apps/site/test/play-listing.test.js` (30, 80 e 4000 caracteres, URLs https://varanda.app/, sem travessão).
- Orçamento de tamanho de `public/` em `site.test.js` subiu de 837000 para 1058000 bytes (medido 846273 depois do merge e das duas páginas).
- Correções da auditoria: a página de exclusão (texto sobre recuperação e sobre pedido só com @nome), o FAQ e a lista técnica da página inicial, a frase da ficha do Play sobre conversas de Página e os testes de URL mais rígidos em `legal.test.js`.

## Testes

- [x] `node apps/site/scripts/render-legal.js --check`
- [x] legal, site, brand, calcada, play-screens e play-listing, cada um sozinho
- [x] `npx standard` nos arquivos .js mudados
- [x] `npm run lint` e `npm run demo` (termina com "DEMO OK")

A suíte completa roda na CI do GitHub do PR.

## Para o dono conferir antes de declarar conformidade no Console

Procedimentos operacionais que a página de segurança infantil não afirma e que a associação precisa confirmar:

- [ ] Quem recebe as denúncias de conteúdo ilegal, em que prazo decide e quem é a pessoa de contato
- [ ] O que é feito com material de abuso sexual infantil achado ou denunciado: retirada, preservação e comunicação às autoridades competentes e à SaferNet
- [ ] Que o endereço contato@varanda.app é lido e respondido
- [ ] Que o prazo de 7 dias para o diário sair dos semeadores, citado nos Termos, é cumprido
- [ ] Que o pedido de exclusão sem passkey recebido por e-mail é verificado e confirmado pela equipe

## Conferências que faltam

- [ ] As duas páginas em 390 px de largura, num servidor local do site
- [ ] Depois do deploy do site: os três endereços respondem 200 sem entrar em conta, e o pedido de exclusão por e-mail funciona de ponta a ponta

## Capturas da ficha

- [x] As quatro telas (`a-rua.png`, `diario.png`, `conversas.png`, `conversa.png`) foram recapturadas em 2026-11-20 no commit `78ceabfb`, no AVD `varanda-api36` (Android 16, 1080x2400 redimensionado para 1080x1920, tema claro, barra de status demo 9:41), com o app de debug (`app.varanda.debug`) feito neste worktree e o Vitrine servido pelo Metro (`--clear`, porta 8081, `EXPO_PUBLIC_VARANDA_VITRINE=1`). Só conteúdo fictício do Vitrine. Achatadas com `apps/site/scripts/flatten-png.js` (1080x1920, RGB opaco). A tabela de checksums de `apps/site/artwork/screens.md` foi atualizada.
- Tropeços desta captura, para quem repetir: (1) o `node_modules` do worktree estava atrás do `package-lock.json` (faltavam `expo-task-manager` e outros quatro), o que o `npm ci --ignore-scripts` resolveu; (2) o Gradle reaproveitou `apps/app/android/build/generated/autolinking/autolinking.json` da primeira compilação e deixou `react-native-webview` fora do APK (erro `RNCWebViewModule could not be found`): apague essa pasta e rode o `assembleDebug` de novo; (3) o Metro com `--localhost` escuta só em `[::1]` e o `adb reverse` não o alcança (app mostra "Unable to load script"): um repasse TCP de `127.0.0.1:8081` para `[::1]:8081` resolveu; (4) o AVD tinha `debug_http_host=localhost:8103` nas preferências do app de debug (sobra de outra sessão): foi removido para a captura.
- O Diário no Android agora mostra o perfil (bio, contagens, Sorte do dia, Melhores amigos) até "Seus momentos", e não os posts dela; A Rua abre no post de evento "Mutirão da horta". Vale o dono decidir se prefere outra rolagem do Diário.
- Estado restaurado: demo mode desligado, `wm size reset`, `adb reverse` removido, emulador, Metro, repasse e daemon do Gradle parados.
- [ ] O dono compara as quatro imagens com o build que vai para a revisão antes de enviá-las.
