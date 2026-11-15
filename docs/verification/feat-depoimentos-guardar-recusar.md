# Depoimentos: guardar só para mim ou recusar (branch feat/depoimentos-guardar-recusar)

Este arquivo confere as três escolhas de um depoimento recebido na tela Depoimentos, em "Para aprovar": **Mostrar no perfil** (como antes, `testimonial.show`, registro público), **Guardar só para mim** (vai para "Guardados", que só o dono vê) e **Recusar** (depois de uma confirmação). Guardar e recusar não gravam registro em diário nenhum e não chamam a rede: quem escreveu vê só "Enviado" e não distingue guardado, recusado e não visto. A escolha vai para todos os aparelhos da mesma passkey pelo documento cifrado de vistos, que passa à versão 3 (cabeçalho de 78 bytes, entradas de decisão de 41 bytes, janela de mensagens diretas de 256, até 64 guardadas e 64 recusadas; o pior caso ocupa 32722 dos 32768 bytes; as versões 1 e 2 ainda são lidas e sempre se grava a 3; um cliente antigo lê a 3 como não suportada). A lista antiga "Agora não" de cada aparelho migra uma vez para decisões de guardado. Termos e Privacidade passam à versão 54. Veja docs/protocol.md seções 2, 5 e 14 e docs/rpc.md 5.96 e 5.100.

Ordem: Android (build de debug), simulador iOS, depois web e PWA. Registrar aparelho, sistema e, na web, o navegador, e o resultado de cada item.

- [ ] Três escolhas: com um depoimento recebido, a linha em "Para aprovar" tem "Mostrar no perfil", "Guardar só para mim" e "Recusar"; mostrar publica como antes. Android, iOS, web, PWA: pendente.
- [ ] Guardar só para mim: a linha passa para "Guardados" na hora, com a nota "Só você vê. Quem escreveu não fica sabendo."; o Diário mostra "Depoimentos guardados (N)". Nada novo no diário (conferir o registro de rede e o diário próprio). Android, iOS, web, PWA: pendente.
- [ ] Segundo aparelho da mesma passkey: depois de uma sincronização de vistos, o depoimento guardado aparece em "Guardados", e um recusado some de "Para aprovar", sem recarregar à mão. Pendente.
- [ ] Recusar: a confirmação "Recusar depoimento?" aparece; cancelar não muda nada; confirmar tira a linha da lista, e ela não volta nem em "Guardados". Android, iOS, web, PWA: pendente.
- [ ] Quem escreveu: em Enviados a linha mostra só "Enviado" nos três casos (não visto, guardado e recusado). Pendente.
- [ ] Quem escreveu usa "Retirar" num depoimento guardado: ele some de "Guardados" de quem recebeu. Pendente.
- [ ] Instalação antiga com a lista "Agora não": ao abrir a tela, os depoimentos escondidos passam uma vez para "Guardados"; uma escolha feita de propósito antes não é desfeita; abrir de novo não repete. Pendente.
- [ ] Termos e Privacidade na versão 54: o app pede o aceite de novo, e a página do site mostra o texto novo. Pendente.

Testes automáticos desta mudança, a partir da raiz, cada arquivo sozinho. Conferem o código, não montam a interface num aparelho.

```sh
node packages/core/test/testimonial-decision.test.js
node packages/core/test/seen-blob.test.js
node packages/web-member/test/seen-sync.test.js
node packages/web-member/test/testimonial-decide-e2e.test.js
node apps/app/test/depoimentos.test.js
node apps/app/test/testimonialMigrate.test.js
node apps/app/test/testimonials.test.js
```

Na raiz, na ordem da CI, `npm run lint`, `npm test` e `npm run demo` têm de passar. A demo termina com `DEMO OK`.
