# Conversas da Página com mídia (branch feat/page-dm-media)

## O que mudou

- `packages/rpc/lib/methods.js`, `docs/rpc.md` 5.114: `dm.pageDraft` aceita `media` e `card` exatamente como `dm.send` (5.75), nunca os dois, e só em `kind: 'msg'`.
- `packages/web-member/lib/dm.js`, `page-dm.js`, `session.js`: o rascunho da Página monta o mesmo inner v3 com as mídias ou o cartão. O aparelho sela e põe os blobs no canal anônimo com os selos da própria identidade antes de devolver o digest; o serviço assina só o digest (`dm-sign`), como antes. As cópias das fotos ficam depois de uma entrega que falhou, para a nova tentativa; uma falha de upload, de trava ou de gravação apaga o rascunho guardado. A troca de identidade ou o bloqueio no meio do envio cancela a entrega.
- `dm.putMedia` (5.88) aceita `page`: a mídia posta como Página só é reaproveitada para a mesma Página e o mesmo destino, e um blob posto pela pessoa nunca entra num rascunho da Página (nem o contrário: `MEDIA_STALE`), para que quem recebe não ligue a Página a quem administra pelo mesmo blob. O nó recusa `page` cuja chave não guarda. O app passa `page` em todo anexo, cartão e encaminhamento feito como Página, também pelo worklet nativo.
- Se o semeador aceita a cópia de quem recebe e recusa a cópia da própria Página, `dm.pageSend` responde incerto: tentar de novo reenvia o mesmo rascunho assinado, sem segunda mensagem.
- `docs/protocol.md` (Páginas, Signing): o aparelho de quem administra põe os blobs com os próprios selos.
- `apps/app/src/dm-screen.js`, `screens/Mensagem.js`, `attach-plan.js`: como Página, a conversa anexa fotos, GIFs, voz e cartão de link. Um envio incerto guarda o rascunho assinado; tocar em tentar de novo o reenvia uma vez, nunca sozinho. Se o nó responde `rascunho expirado`, o app limpa os anexos e o rascunho, mostra "A mensagem pode ter sido enviada. Confira na conversa." e relê a conversa. O composer só de leitura de uma Página antiga continua sem anexos.
- `apps/app/src/forward.js`, `ui/ForwardSheet.js`: encaminhar para uma Página, ou como Página, leva a mídia (sai `PAGE_MEDIA_LEFT`). Uma linha incerta cujo rascunho expirou mostra "Pode ter sido enviada. Confira na conversa." sem botão de tentar de novo.
- `apps/app/src/feiraOffer.js`: a proposta da Página leva a frase, o link e o cartão, como a da pessoa.

## Como verificar

Testes automáticos, a partir da raiz, cada arquivo sozinho:

```sh
node apps/app/test/mensagemPageMedia.test.js
node apps/app/test/attachPlan.test.js
node apps/app/test/forward.test.js
node apps/app/test/forwardSheet.test.js
node apps/app/test/feiraOffer.test.js
node packages/web-member/test/page-dm.test.js
node packages/web-member/test/page-dm-media-e2e.test.js
node packages/web-member/test/page-dm-media-retry.test.js
node apps/app/test/webnodeHandle.test.js
node packages/rpc/test/methods.test.js
```

Casos fixados: `media` e `card` juntos, ou num `ctl`, são recusados; uma Página envia foto, voz e cartão e a pessoa os abre; uma entrega que falhou mantém as cópias e a nova tentativa as reusa; falha de upload ou de gravação apaga o rascunho; troca de identidade no meio do envio cancela; a mesma foto posta como pessoa e como Página tem blobs diferentes, e cada rascunho recusa o item do outro; a cópia da Página recusada depois da entrega a quem recebe responde incerto e o reenvio não duplica; `rascunho expirado` vira "pode ter sido enviada" na conversa e no encaminhar, sem nova assinatura.

## Conferir no app (pessoas)

Ordem: Android (build de debug), simulador iOS, depois web e PWA.

- [ ] Como a Página A, abrir uma conversa e enviar duas fotos e um GIF: a outra pessoa vê a Página A com as fotos. Pendente.
- [ ] Gravar e enviar uma mensagem de voz como a Página A. Pendente.
- [ ] Colar um link (e um link de música): o cartão aparece e chega com a miniatura. Pendente.
- [ ] Encaminhar, como a Página A, uma mensagem com foto para outra conversa: a foto vai junto. Pendente.
- [ ] Na Feira, como a Página A, fazer uma proposta: chega a frase com o cartão do anúncio. Pendente.
- [ ] Com o modo avião ligado no meio de um envio com foto, desligar e tocar em tentar de novo: a mensagem aparece uma vez só. Pendente.
- [ ] Voltar a agir como a própria pessoa: os anexos e o aviso da Página somem. Pendente.

## Não verificado / limites conhecidos

- Não conferido em aparelho.
- Numa conversa da Página, o cartão de um anúncio recebido continua sem a miniatura (o app ainda não lê as fotos da caixa da Página), como antes.
