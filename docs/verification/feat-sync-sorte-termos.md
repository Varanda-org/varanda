# Sorte do dia, aceite dos Termos em todo aparelho (branch feat/sync-sorte-termos)

A Sorte do dia vem da data local e da chave pública do diário (sal: os 16 primeiros caracteres hex da chave), sem armazenamento e sem rede. O serviço de conta ganha `POST /account/terms/held/start` e `/account/terms/held/finish` (prova `summary` de `invite.sign`, nonce próprio, limite de 30 a cada 10 minutos por membro, cobrado só depois da prova). Na instalação hospedada (web e app instalado), o portão dos Termos não aparece antes de Entrar para uma passkey existente: depois de Entrar, sem registro da versão atual no aparelho, o app pergunta ao serviço por até 4 segundos, com a abertura na tela; se o serviço guarda exatamente a versão atual, o aparelho a registra e nenhum portão aparece. "Criar minha conta" mostra os Termos antes da cerimônia da passkey. Nó core nativo e `varanda-serve` não mudam. Termos versão 65. `GET /account/status` não ganha campo.

Verificações automáticas (arquivos alvo):

- `apps/app/test/sorte.test.js`
- `apps/app/test/terms.test.js`
- `apps/app/test/account.test.js`
- `apps/app/test/termsCreate.test.js`
- `apps/app/test/legal.test.js`
- `apps/cli/test/account-terms.test.js`
- `packages/core/test/terms.test.js`
- `apps/site/test/legal.test.js`
- `npm run lint`, `npm test` (ou `npm test -- --affected=origin/main`) e `npm run demo`.

Resultados: a preencher.

Conferência no aparelho:

- [ ] Web hospedada, duas sessões da mesma passkey: aceitar os Termos na A, Entrar na B: nenhum portão aparece na B; a Sorte do dia é a mesma frase nas duas no mesmo dia: pendente.
- [ ] Criar minha conta num aparelho novo: os Termos aparecem antes de a cerimônia da passkey começar: pendente.
- [ ] Membro sem vínculo Google: depois de Entrar, o portão aparece como antes: pendente.
- [ ] Sem rede (ou serviço lento, acima de 4 segundos): depois de Entrar, o portão aparece e a abertura não fica presa: pendente.
- [ ] Serviço antigo sem a rota (404): depois de Entrar, o portão aparece: pendente.
- [ ] Nó core nativo e `varanda-serve`: o aceite continua por aparelho, sem pergunta ao serviço: pendente.
- [ ] Depois de abrir o app, a chave antiga `varanda-sorte` (navegador) e o arquivo `varanda-sorte.txt` (celular) não existem mais: pendente.
- [ ] Aparelho compartilhado, A já aceitou: B aperta Entrar e a pergunta ao serviço (ou o portão) roda para B; B aperta Criar conta e o portão de criação aparece primeiro: pendente.
- [ ] App instalado com a instalação hospedada, no emulador Android e no simulador iOS (celular primeiro): o mesmo fluxo de Entrar, pergunta ao serviço e portão: pendente.
- [ ] Recomeçar, ou Excluir conta, seguido de Entrar na mesma carga da página: o portão aparece: pendente.
- [ ] Recarregar durante uma criação pendente (`concluir`): o portão de criação aparece primeiro: pendente.
- [ ] "Voltar" no portão de criação leva de volta a Entrar: pendente.
- [ ] Conexão lenta num aparelho que já voltou depois de uma versão nova dos Termos: só a abertura de conexão antes de Entrar, nunca os Termos: pendente.
- [ ] Entrar num aparelho novo sem diário local: a abertura aparece, nunca um lampejo dos Termos, e fica no máximo 15 segundos enquanto a recuperação busca a chave (depois, no máximo 4 segundos pela resposta do serviço): pendente.
- [ ] Instalação hospedada, app bloqueado em Entrar: Ajustes não abre (sem o rodapé Conexão, e um bloqueio fecha Ajustes), então criar a conta por Ajustes > Conta e @nome não é um caminho alcançável; o portão de criação passado a Ajustes é só uma defesa, conferida em `apps/app/test/termsCreate.test.js`: pendente.
- [ ] Código de recuperação num aparelho hospedado novo ("Outras formas de entrar" › código): os Termos aparecem antes de o campo do código abrir; depois de aceitar, o campo abre, a recuperação termina e, na aba de rede, nada chegou a `/account/recovery/*` antes do aceite: pendente.
- [ ] Entrar num aparelho sem registro da versão atual, com o portão na tela: na aba de rede, nenhum pedido a `/account/invites/*` nem a `/account/passkey/*` sai antes de aceitar, e o app não chama `dm.list` no nó; só saem `/account/terms/held/*`, a leitura pública `/account/status` e a leitura de admissão: pendente.
- [ ] Sorte do dia perto da meia-noite em dois aparelhos em fusos diferentes: pode diferir, de propósito (data local): pendente.
