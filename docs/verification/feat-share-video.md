# Vídeo na folha de compartilhar, parte 2 (branch feat/share-video, fecha a #535)

A parte 1 (`docs/verification/fix-share-leftovers.md`) corrigiu os limites do Android e da PWA. Esta parte leva vídeo à folha de compartilhar nas três plataformas, com a linha nova da Política de Privacidade, e fecha a issue.

## Decidido pelo dono do produto na #535

- Vídeo entra nas três plataformas.
- A Política de Privacidade ganha uma linha: o que outro app compartilha fica só no aparelho (armazenamento privado do app, grupo de apps no iOS, cache do navegador na PWA) até Publicar, por no máximo 1 hora. Termos e Política vão para a versão 65, e todo mundo aceita de novo.

## O que muda

- **Um vídeo por vez.** Uma publicação leva um vídeo ou fotos. No Android, o receptor ganha `SEND video/*` (sem `SEND_MULTIPLE`); no iOS, a extensão ganha `NSExtensionActivationSupportsMovieWithMaxCount` 1. Com dois vídeos escolhidos, a Varanda não aparece na folha dessas duas plataformas. Na PWA, o alvo do manifesto aceita `video/mp4` no mesmo campo das fotos, e o service worker guarda só o primeiro MP4.
- **Fotos ganham do vídeo.** Quando chegam fotos e vídeo juntos (no iOS e na PWA; no Android, a Varanda só aparece na folha para um vídeo sozinho), só as fotos são guardadas (o vídeo nem é copiado no iOS e na PWA) e o Publicar diz "o vídeo ficou de fora, uma publicação leva um vídeo ou fotos". Um vídeo que não pôde ser copiado diz "o vídeo não pôde ser recebido"; na PWA, um segundo vídeo diz "só o primeiro vídeo foi anexado". Um compartilhamento só com um vídeo que não pôde ser guardado: no Android e no iOS, a própria folha diz "Não deu para receber esse conteúdo.", como antes; na PWA, o service worker guarda só a contagem, e o app abre o Publicar com "o vídeo não pôde ser recebido" em vez de abrir sem nada. O manifesto de cada plataforma ganha `videos`, quantos vídeos foram oferecidos, separado de `total`, que continua contando as fotos.
- **O tipo é conferido, não aceito do remetente.** No Android, o arquivo copiado (até 512 MiB) precisa começar com uma caixa `ftyp` de mídia ISO; a marca `qt  ` vira `0.mov` (`video/quicktime`), qualquer outra `0.mp4`. No iOS, a extensão só copia um arquivo (nunca bytes em memória), até 512 MiB, e o app confere a mesma caixa `ftyp` na cópia antes de guardá-la (`admitVideo`). A leitura do lado JS só aceita os nomes `N.mp4` e `N.mov`. Na PWA, o vídeo é um MP4 de até 50 MB, o limite que já valia para fotos.
- **Preparo no Publicar.** O vídeo compartilhado passa pelo mesmo caminho do vídeo escolhido na galeria (`createVideoDraft().pick`): no aparelho, é codificado de novo para caber (até 30 s); na PWA, só um MP4 que já cabe (até 8 MiB e 30 s) é aceito, como na galeria do navegador. Enquanto ele é preparado, o Publicar avisa o shell com `loaded` (o compartilhamento sai da fila sem apagar o arquivo) e o apaga com `free` quando o preparo termina. Se o rascunho já tem um vídeo, o compartilhado não entra e o Publicar diz "o rascunho já tem um vídeo"; o texto compartilhado entra do mesmo jeito.
- **Termos e Política, versão 65.** Linha nova na Política, logo depois da de Posts salvos, e linha nova na tabela LGPD de `docs/design.md`.

## Testes

Cada arquivo rodou sozinho (`node <arquivo>`) nesta branch e, com os mesmos testes, sobre as fontes da parte 1 (`git archive fix/share-leftovers`, com os testes desta branch postos no lugar).

| Arquivo | Branch | Fontes da parte 1 |
|---|---|---|
| `apps/app/test/sharedIntent.test.js` | 35/35, 229/229 | falha nos dois testes de vídeo (`acceptShare`, `shareNote`) |
| `apps/app/test/shareShell.test.js` | 8/8, 49/49 | falha no teste do vídeo compartilhado no Publicar (`loaded`, `free`, rascunho com vídeo) |
| `apps/app/test/shareIntakeModule.test.js` | 17/17, 198/198 | falha em `videos` e no teste de entrada de vídeo |
| `apps/app/test/shareTargetAndroid.test.js` | 12/12, 137/137 | falha no filtro `SEND video/*`, na cópia do vídeo e no limite próprio de `fetch` |
| `apps/app/test/shareTargetIos.test.js` | 16/16, 68/68 | falha no teste do vídeo (`admitVideo`, `isoMedia`, `videos`) |
| `apps/app/test/hardening.test.js` | 24/24, 234/234 | falha na regra de ativação com vídeo e na cópia do vídeo na extensão |
| `apps/app/test/sw.test.js` | 92/92, 996/996 | falha nas chaves do meta, na contagem de vídeos e quebra no teste do MP4 |
| `apps/app/test/shareIntakeWeb.test.js` | 27/27, 193/193 | falha em `videos` e na leitura do MP4 |
| `apps/app/test/pwa.test.js` | 8/8, 123/123 | falha no `accept` do alvo de compartilhar |
| `apps/app/test/legal.test.js` | 47/47, 1702/1702 | falha na versão, no digest e no texto da versão 65 |
| `apps/site/test/legal.test.js` | 7/7 | falha na versão das páginas |
| `packages/core/test/terms.test.js` | 8/8, 126/126 | falha em `TERMS_VERSION` |

## Nos aparelhos

Em 16/11/2026, com o Metro desta branch (`EXPO_PUBLIC_VARANDA_VITRINE=1`, porta 8103). A vitrine não tem vídeo na instalação (`media.video`), então o Publicar diz "não dá para anexar vídeos agora" e apaga o arquivo: o caminho até o Publicar e a limpeza foram conferidos, o preparo do vídeo não.

- **Android** (emulador API 36, build de debug `app.varanda.debug` desta branch), vídeos compartilhados pelo app Arquivos:
  - Um `.mp4` sozinho é copiado como `0.mp4` (`video/mp4`, `videos: 1`) em `no_backup/varanda-share/<id>/`; o Publicar abre com "não dá para anexar vídeos agora", e a pasta fica vazia.
  - Um `.mov` sozinho vira `0.mov` (`video/quicktime`, `videos: 1`), com o mesmo aviso, e a pasta também fica vazia.
  - Um arquivo com nome `.mp4` sem a caixa `ftyp`: o receptor abre, não guarda nada e o app não abre (o caminho do aviso "Não deu para receber esse conteúdo.").
  - Um `.mp4` longo com o app fechado: a cópia termina, o app abre o Publicar com o aviso e a pasta fica vazia.
  - Um compartilhamento que chega com o Publicar já aberto espera até ele fechar e então abre o Publicar, como na `main` (o compositor aberto conta como uma folha por cima); nada se perde.
- **iOS** (simulador iPhone 17 Pro, build de debug desta branch): com um vídeo escolhido no app Fotos, a folha mostra a Varanda; a extensão diz "Pronto. Abra o app Varanda para publicar." e guarda `0.mov` (`video/quicktime`, `videos: 1`) no grupo de apps. Ao abrir, o app move o arquivo para a própria pasta, confere a caixa `ftyp` e abre o Publicar com o aviso; as duas pastas ficam vazias.
- **Web** (`localhost:8103` no navegador): o painel de navegador usado aqui não registra service worker, então os compartilhamentos foram escritos no cache `varanda-share` no formato exato do service worker (o lado do service worker está coberto por `sw.test.js`). Um MP4 sozinho chega ao Publicar com "não dá para anexar vídeos agora"; foto e vídeo juntos anexam a foto com "o vídeo ficou de fora, uma publicação leva um vídeo ou fotos"; um vídeo contado e não guardado diz "o vídeo não pôde ser recebido". O cache fica vazio depois de cada um. O manifesto servido aceita `video/mp4` no alvo de compartilhar, e a tela dos Termos mostra a versão nova com a linha da Política.

Não alcançado aqui, e listado na #224: o preparo de um vídeo compartilhado (precisa de uma instalação com vídeo e de conta); o alvo de compartilhar numa PWA instalada a partir da origem hospedada, com o service worker de verdade; um Android de verdade com o APK de preview e conta; um iPhone de verdade com o grupo de apps assinado; o novo aceite dos Termos e da Política na versão 65 em produção.

## Fica de fora

- Dois vídeos de uma vez: no Android e no iOS a Varanda não aparece na folha; na PWA só o primeiro MP4 entra, com o aviso.
- Na PWA, um vídeo que não é MP4 (MOV, WebM) não entra, com o aviso "o vídeo não pôde ser recebido": o navegador não codifica de novo.
- Um vídeo com mais de 30 s é recusado no preparo, como na galeria, com o mesmo aviso; ele não é cortado.
- O arquivo compartilhado (até 512 MiB) ocupa o armazenamento do app até o preparo terminar, o compartilhamento ser substituído ou passar 1 hora.
- Sem como anexar vídeo naquele momento (sem rede, vídeo desligado na instalação, publicação como Página), o vídeo compartilhado não fica esperando: o Publicar diz "não dá para anexar vídeos agora" e o arquivo é apagado, ao contrário das fotos, que entram sem rede. Fechar o Publicar ou bloquear durante o preparo cancela o preparo e apaga o arquivo; é preciso compartilhar de novo.
- Um compartilhamento novo que chega durante o preparo (a pessoa saiu da Varanda e compartilhou outra coisa) substitui o anterior no armazenamento, como já vale para as fotos; o preparo em andamento pode falhar com o aviso do formato.
- A cópia confere só a caixa `ftyp`: outro arquivo de mídia ISO enviado como vídeo (HEIC, AVIF, M4A) é guardado e recusado no preparo, com o aviso do formato.
- No Android, a folha de compartilhar não mostra progresso enquanto copia; um vídeo grande leva alguns segundos, e sair da folha nesse tempo cancela a cópia.
