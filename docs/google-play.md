# Varanda na Google Play: roteiro do responsável

Roteiro para publicar o app Android `app.varanda` na Google Play, na ordem em que os passos acontecem. A exceção é o passo 8 (qualificação), que é uma lista de conferência consultada antes dos passos 5 e 7, não feita depois do passo 7. Todos os passos são do responsável pelas contas (Google Play Console, Firebase, Google Cloud, Expo e as configurações do GitHub) ou de quem opera o servidor. Nenhum agente roda estes passos: agentes só mudam código e documentos por PR.

## Como ler este roteiro

- Cada passo diz **quem** roda, o **pré-requisito**, o **comando ou a tela**, o **resultado esperado** e a **evidência** a guardar.
- A evidência privada (capturas do Console, e-mails do Google, impressões digitais, números de versão ligados a contas) fica fora do repositório, num lugar só do responsável. Nunca entram no git: chave, senha, arquivo de conta de serviço, `google-services.json`, código de recuperação, número de telefone ou impressão digital de certificado.
- Só está pronto o que é código já na `main`. O que depende do Console, do Firebase, da EAS, das configurações do GitHub ou de um deploy continua devido até o responsável fazer e guardar a evidência.
- Regras do Google mudam. Onde este roteiro cita um requisito da Play (nível de API, 16 KB, teste fechado, nomes de telas e de permissões), confirme no Console e na ajuda do Play Console no dia em que fizer o passo.

Ainda não existe no código: a publicação de `/.well-known/app-release.json` e a variável `VARANDA_ANDROID_STORE_BUILD` (nome planejado). Hoje só o leitor do app existe (`apps/app/src/storeRelease.js`, no PR do aviso de versão nova, `feat/app-store-update-notice`). Nenhum código publica o arquivo ainda.

O que já existe no código, depois dos PRs desta série:

| Peça | Onde |
|---|---|
| Fluxo de envio, desligado por padrão | `.github/workflows/android-release.yml`, ambiente `play-store`, variável `VARANDA_ANDROID_RELEASE`, segredo `EXPO_TOKEN` |
| Perfil de loja | `apps/app/eas.json`: `build.production` gera app bundle; `submit.production.android` envia para a faixa `internal` como rascunho (`draft`) |
| Trava do Firebase no build de loja | `apps/app/scripts/check-firebase-config.js`, chamado por `apps/app/scripts/eas-post-install.sh` só no Android com perfil `production` |
| Certificados do assetlinks.json | `VARANDA_ANDROID_CERT_SHA256` no `.env` da instalação, lido por `ler_associacoes` em `deploy/seeder/well-known.sh` |
| Páginas 16 KB e permissões | `apps/app/scripts/check-page-size.js` (dentro de `link-addons.sh` para android e no job `android-build` do `native.yml`) e `apps/app/scripts/check-apk-permissions.js` (no mesmo job) |
| Ficha e artes | `apps/site/artwork/play/listing.pt-BR.json`, `apps/site/artwork/play/icon-512.png`, `apps/site/artwork/play/feature-graphic-1024x500.png`, `apps/site/artwork/play/screens/` |

## 1. Conta de desenvolvedor

**Quem:** o responsável, com a conta pessoal do Google que é dona do Play Console.

**Pré-requisito:** nenhum.

**Onde:** Play Console, página inicial e Configurações > Detalhes da conta (os nomes podem variar).

1. Concluir a verificação de identidade da conta pessoal e a verificação do aparelho (pelo app Play Console num celular Android) que o Console pedir. Concluir também a verificação de e-mail e telefone de contato, se pedida.
2. Ler e anotar, no próprio Console, os requisitos que valem para a conta e para um app novo naquele dia:
   - o nível mínimo de API de destino (`targetSdkVersion`) para apps novos;
   - a exigência de páginas de memória de 16 KB para apps que miram o Android 15 ou mais novo;
   - se a conta está sujeita ao teste fechado antes do acesso à produção (no passo 7, 12 testadores por 14 dias), e com quais números.
3. Comparar o nível de API exigido com o `targetSdkVersion` e o `compileSdkVersion` que `check-apk-permissions.js` imprime no log do job `android-build` do `native.yml` (não há APK local; o número vem desse log). Se o exigido for mais alto, abrir uma issue antes de seguir: subir o nível é mudança de código.

**Resultado esperado:** a conta mostra as verificações concluídas e libera "Criar app".

**Evidência:** captura das verificações concluídas e dos requisitos anotados, com a data, fora do repositório.

## 2. Firebase e as três credenciais

São três credenciais diferentes. Nenhuma entra no repositório e nenhuma substitui a outra:

| Credencial | Para quê | Onde fica |
|---|---|---|
| Configuração do Firebase do app (`google-services.json` de `app.varanda`) | O app registra o aparelho no FCM e recebe avisos | Variável de arquivo da EAS `VARANDA_GOOGLE_SERVICES_JSON`, ambiente `production` |
| Conta de serviço do FCM do servidor | O serviço de conta envia avisos pelo FCM HTTP v1 | Arquivo no volume do serviço `account`, caminho em `VARANDA_FCM_ACCOUNT_FILE` |
| Conta de serviço de publicação da Play | O EAS Submit envia o app bundle para a Play | Guardada na EAS por `eas credentials -p android` (passo 5) |

**Quem:** o responsável (Firebase e EAS) e quem opera o servidor (FCM do servidor).

**Pré-requisito:** passo 1.

1. No console do Firebase, criar (ou escolher) o projeto do Varanda e adicionar um app Android com o pacote `app.varanda`. Não ligar o Google Analytics para esse app: o módulo `push-device` desliga auto-init e analytics, e o app não tem telemetria.
2. Baixar o `google-services.json` para fora do repositório. Nunca colocar o arquivo em `apps/app` nem em outra pasta do git (`.easignore` já o deixa fora do envio, e o teste confere).
3. Da pasta `apps/app`, criar a variável de arquivo da EAS para o ambiente `production`. Confirme a sintaxe com `eas env:create --help` da versão instalada; a forma esperada é:

   ```sh
   eas env:create --name VARANDA_GOOGLE_SERVICES_JSON --type file --value <caminho local do google-services.json> --environment production --visibility secret
   ```

   O perfil `production` do `eas.json` usa `"environment": "production"`, por isso a variável tem de estar nesse ambiente. Os perfis `preview` não precisam dela: sem ela, o APK de preview sai sem avisos nativos.
4. Apagar a cópia local do arquivo depois de conferir que a variável existe (`eas env:list --environment production` mostra o nome, não o conteúdo).
5. No servidor, quem opera prepara a conta de serviço do FCM do mesmo projeto Firebase, coloca o JSON no volume `account-data` e define `VARANDA_FCM_ACCOUNT_FILE`, como em "Avisos nativos: configuração do serviço de conta" de [development.md](development.md). Recriar o contêiner de conta, não só reiniciá-lo (ele lê o `.env` só quando é criado): `docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml up -d --force-recreate account`. Depois conferir `GET /account/push/device/info`: `fcm: true`.

**Resultado esperado:** a variável aparece na EAS no ambiente `production`; `device/info` responde `fcm: true`.

**Limite:** `fcm: true` confirma a configuração do servidor, não a entrega no aparelho. A entrega real fica para o passo 8.

**Ainda não comprovado:** se uma variável de arquivo da EAS fica visível para o gancho `eas-build-post-install`. O primeiro build de loja (passo 3) prova. Se ele parar com `check-firebase-config: unset` com a variável criada, confira o nome, o ambiente `production` e a visibilidade da variável e rode de novo. Se mesmo assim falhar, abra uma issue: a correção é de código. Nunca contorne a trava tirando a chamada do gancho num build de loja, porque o app sairia sem avisos e ninguém notaria. Os outros motivos (`unreadable`, `invalid-json`, `no-client-for-package`, `missing-api-key`, `missing-app-id`, `missing-project-id`, `missing-project-number`) dizem que o arquivo enviado não é o de `app.varanda` ou está incompleto: baixe de novo do Firebase e recrie a variável.

**Evidência:** a saída de `eas env:list` (só nomes) e a resposta de `device/info`, fora do repositório.

## 3. Chave de upload no EAS e o primeiro app bundle

**Quem:** o responsável, com as contas Expo (`varanda-org`) e Play Console.

**Pré-requisito:** passos 1 e 2.

1. No Play Console, criar o app: nome do `listing.pt-BR.json` (`title`), idioma padrão português (Brasil), app (não jogo), gratuito. Aceitar as declarações que o Console pede é decisão do responsável.
2. Da pasta `apps/app`, preparar a chave de assinatura do Android na EAS:

   ```sh
   eas credentials -p android
   ```

   Escolha o perfil `production` e deixe a EAS gerar o keystore. Com a Assinatura de apps do Google Play (passo 4), essa chave da EAS é a **chave de upload**: ela assina o bundle que vai para a Play, e o Google assina o app instalado com a chave dele. O keystore fica na EAS; nunca baixe para o repositório.
3. Passar a numeração do Android para a EAS. O `eas.json` já usa `"appVersionSource": "remote"` e `autoIncrement` no perfil `production`; o `versionCode` do `android/app/build.gradle` (hoje 1) deixa de valer para a loja. Confirme a sintaxe com `eas build:version:set --help`:

   ```sh
   eas build:version:set -p android
   ```

4. Gerar o primeiro bundle de loja à mão, sem envio automático:

   ```sh
   eas build -p android --profile production
   ```

   No log do build, confira `check-firebase-config: ok`, as etapas `link-addons` e `pack-worklet` e a linha `build-info: commit ...`. Baixe o `.aab` da página do build no expo.dev.
5. No Play Console, em Teste > Teste interno, criar uma versão e enviar esse `.aab` à mão. Na primeira versão o Console pede a escolha da assinatura: siga o passo 4.

O primeiro envio é manual por escolha do responsável: ele qualifica o bundle (passo 8, primeiros itens) antes de qualquer automação ter acesso à Play. O EAS Submit também consegue fazer o primeiro envio (docs.expo.dev/submit/android).

**Resultado esperado:** uma versão no teste interno com o `versionCode` que a EAS atribuiu.

**Evidência:** id do build no expo.dev, `versionCode`, SHA-256 do `.aab` (`shasum -a 256 <arquivo>.aab`) e captura da versão no Console, fora do repositório.

## 4. Assinatura de apps do Google Play e o assetlinks.json

**Quem:** o responsável (Console) e quem opera o servidor (`.env` e deploy).

**Pré-requisito:** o passo 3 chegou à criação da primeira versão.

1. Na primeira versão, aceitar a Assinatura de apps do Google Play com a **chave gerada pelo Google** (não enviar chave própria).
2. Em Teste e lançamento > Configuração > Integridade do app > Assinatura de apps (o nome pode variar), copiar a impressão digital SHA-256 de dois certificados: o da **chave de assinatura do app** (do Google) e o da **chave de upload** (a da EAS). `eas credentials -p android` também mostra a SHA-256 da chave de upload; as duas fontes devem bater.
3. No `.env` da instalação (`deploy/seeder/.env`; na instalação com `update.sh`, o arquivo de ambiente que ela lê), pôr as duas em `VARANDA_ANDROID_CERT_SHA256`: de 1 a 4 impressões digitais, separadas por vírgula sem espaço, cada uma em hexadecimal maiúsculo com dois-pontos, sem repetição. A chave pública de depuração do React Native é sempre recusada (por `well-known.sh` e pelo serviço de conta).
4. Fazer o deploy da instalação (ou `update.sh reconfigure`). `ler_associacoes`, em `deploy/seeder/well-known.sh`, publica o `assetlinks.json`.
5. Conferir `https://<domínio da instalação>/.well-known/assetlinks.json` (hoje `bora.varanda.app`): o pacote `app.varanda` com as duas impressões digitais.

A chave do Google assina o app instalado pela Play; a chave de upload assina o que a EAS gera, inclusive o APK de preview. Com as duas na lista, a passkey e os App Links funcionam nos dois casos.

**Remover um certificado:** tirar uma impressão digital da lista muda o `assetlinks.json` no deploy, mas só chega ao serviço de conta depois que o contêiner `account` é recriado (deploy de um commit novo ou `docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml up -d --force-recreate account`; reiniciar não basta, porque ele lê o `.env` só quando é criado). Até lá o serviço ainda aceita o certificado removido.

**Resultado esperado:** o arquivo publicado lista `app.varanda` com as duas impressões digitais, e o registro do deploy não traz `VARANDA_ANDROID_CERT_SHA256 inválido`.

**Evidência:** captura da tela de assinatura e o `assetlinks.json` publicado, fora do repositório (não cole as impressões digitais em issue ou PR).

## 5. Envio automático pelo EAS Submit

**Quem:** o responsável, com acesso de administrador ao Google Cloud, ao Play Console, à Expo e ao repositório no GitHub.

**Pré-requisito:** passos 3 e 4 feitos e o bundle do passo 3 qualificado nos itens do passo 8 que valem para o teste interno. O caminho manual precisa estar provado antes de ligar o automático.

1. No Google Cloud, num projeto do Varanda, ativar a Google Play Android Developer API e criar uma conta de serviço só para publicação, sem papéis de IAM no projeto. Criar uma chave JSON para ela, fora do repositório.
2. No Play Console, em Usuários e permissões, convidar o e-mail dessa conta de serviço com acesso **só ao app `app.varanda`** e só às permissões de lançar em faixas de teste. Confirme os nomes das permissões no Console; não dê acesso de administrador, financeiro nem a outros apps.
3. Da pasta `apps/app`, guardar a chave na EAS: `eas credentials -p android`, perfil `production`, opção da conta de serviço do Google para envios. Apagar a cópia local da chave JSON.
4. Criar um token de acesso da Expo para a conta `varanda-org`, de um usuário robô da organização com o papel mais baixo que ainda faz build e envio, não um token pessoal. O papel do usuário robô é o que limita o token, e ele vale para as duas plataformas. Use um token por ambiente (`play-store` e `app-store`): dá para revogar um sem parar o outro e se vê qual vazou.
5. No GitHub, em Settings > Environments, criar o ambiente `play-store`: deployment branches só `main`, revisor obrigatório, segredo `EXPO_TOKEN` com o token do item 4.
6. Só depois de tudo acima, em Settings > Secrets and variables > Actions > Variables, criar `VARANDA_ANDROID_RELEASE` com o valor `true`. O fluxo `android-release` só roda com `true` (o GitHub não diferencia maiúsculas nessa comparação).

A partir daí, cada push na `main` que mexe no app (ou um Run workflow em `main`) espera a aprovação no ambiente `play-store` e então roda `eas build --platform android --profile production --auto-submit --non-interactive --no-wait` com o `eas-cli` 27.2.0. Só a execução mais nova espera aprovação (job `supersede`). Depois da aprovação, o job `play` repete a consulta do `supersede`: se já existe uma execução mais nova do fluxo em `main`, termina verde sem build. Por isso um Re-run de uma execução antiga não envia nada; para repetir um envio, use Run workflow. O `eas-cli` vem de `.github/eas-cli`, instalado com `npm ci --ignore-scripts` a partir do `package-lock.json` de lá, e o job que recebe o `EXPO_TOKEN` não usa o cache do npm. O envio vai para a faixa `internal` como rascunho; lançar o rascunho ou promovê-lo a outra faixa continua manual no Console.

**Resultado esperado:** depois de uma aprovação, um build novo no expo.dev e, quando ele termina, um rascunho novo no teste interno com `versionCode` maior.

**Limite:** o fluxo termina verde assim que põe o build na fila (`--no-wait`). Um fluxo verde não prova que o build da EAS passou nem que o rascunho chegou à Play: confira os dois no expo.dev e no Console.

**Evidência:** link da execução do fluxo, id do build no expo.dev e captura do rascunho no Console, fora do repositório.

## 6. Formulários do Play Console

**Quem:** o responsável. As respostas são declarações dele ao Google; este roteiro propõe as respostas padrão do plano, e o responsável pode mudar qualquer uma.

**Pré-requisito:** o app criado (passo 3) e o site publicado com as três páginas abaixo (o deploy do site é do responsável).

### Ficha da loja

- Textos de `apps/site/artwork/play/listing.pt-BR.json`: `title` (nome), `shortDescription` (descrição curta) e `fullDescription` (descrição completa).
- Ícone `apps/site/artwork/play/icon-512.png`, recurso gráfico `apps/site/artwork/play/feature-graphic-1024x500.png` e as capturas de `apps/site/artwork/play/screens/` (`a-rua.png`, `conversas.png`, `conversa.png`, `diario.png`). A receita para refazer as capturas está em `apps/site/artwork/screens.md`.
- As capturas precisam mostrar o app candidato (passo 8). Se a interface mudou, refaça antes de enviar a ficha.

### As três URLs

Estão no `listing.pt-BR.json` e só respondem depois do deploy do site:

| Campo do Console | Chave no arquivo | URL |
|---|---|---|
| Política de privacidade | `privacyPolicyUrl` | https://varanda.app/privacidade/ |
| Exclusão de conta | `accountDeletionUrl` | https://varanda.app/excluir-conta/ |
| Padrões de segurança infantil | `childSafetyUrl` | https://varanda.app/seguranca-infantil/ |

Abra as três no navegador antes de colar: cada uma deve responder 200 com a página certa.

### Distribuição, classificação e público

- Países: **só Brasil**.
- Classificação de conteúdo: responder o questionário do IARC descrevendo uma rede social com conteúdo gerado por pessoas, interação entre usuários e compartilhamento de localização declarada (cidade e bairro da Feira). Guardar o certificado que o Console emite.
- Público-alvo: **16 anos ou mais**, o limite dos Termos (`apps/app/src/legal.js`, "16 anos ou mais"). Não marcar faixas de crianças; o app não é para crianças nem para a família.
- Conteúdo gerado por usuários: **sim**, com denúncia e bloqueio dentro do app. Os Termos descrevem os dois em `apps/app/src/legal.js` (bloqueio pelo menu da publicação ou pelo perfil; denúncia de publicação e de conta, com decisão humana nos casos que a triagem manda para uma pessoa).
- Contém anúncios: **Sim**, enquanto o app incorporar players do YouTube (`apps/app/src/musicEmbed.js`, `apps/app/src/ui/EmbedFrame.native.js`), que podem mostrar anúncios não personalizados. O Varanda não vende nem mostra anúncios próprios. É a resposta padrão do plano; o responsável pode mudar.
- ID de publicidade: **Não**. O manifesto final remove `AD_ID` (`tools:node="remove"`), e `check-apk-permissions.js` falha se ela voltar.
- App de notícias, app de governo, app financeiro, app de saúde, VPN: **não**.

### Acesso ao app (conta de revisão)

O app pede passkey, idade e celular, então a revisão precisa de uma conta pronta. O responsável cria a conta com os passos de "Conta de revisão" do [README](../README.md), os mesmos da revisão da App Store:

1. Criar a conta num aparelho até a etapa do celular e anotar a hora da checagem de idade.
2. No servidor, rodar `account phone --waiting` e achar a chave da hora anotada.
3. Pôr a chave em `VARANDA_PHONE_REVIEW` no `.env` da instalação e rodar `update.sh reconfigure` (num deploy sem o `update.sh`, recriar o contêiner, porque reiniciar mantém o valor antigo: `docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml up -d --force-recreate account`).
4. Reabrir o app, escolher o @nome e criar o código de recuperação em Ajustes > Passkeys e recuperação.

A mesma conta serve à Play e à App Store. Limites:

- `VARANDA_PHONE_REVIEW` pula só a etapa do celular; idade, passkey e Termos continuam. Cabem até 4 contas.
- Uma conta de revisão não tem número, então não exercita a exclusão por SMS; a operação a exclui com `account delete`.
- Quem revisa precisa estar online ao abrir o app pela primeira vez: sem rede, a conta espera na etapa do celular.
- O @nome, o código de recuperação e as instruções vão só no formulário "Acesso ao app" do Console. Nunca no repositório, em issue, em PR ou em captura pública.

### Segurança infantil

- Padrões publicados: a URL `childSafetyUrl` acima.
- Ponto de contato: um e-mail ou responsável que o próprio responsável escolhe e mantém.
- **Decisão em aberto:** o formulário pede a certificação de que o app tem processo para denunciar material de abuso sexual infantil às autoridades. Esse processo ainda não existe: `docs/design.md` diz que o fluxo com SaferNet e Polícia Federal está "ainda em acerto" (issue #79). Os órgãos certos e o procedimento precisam ser confirmados pelo responsável, não por este roteiro. Opções:
  - (a) montar o processo, registrá-lo num PR de documentação e só então marcar a certificação;
  - (b) deixar sem marcar, sabendo que o app não pode ir para revisão assim.

### Segurança dos dados

O formulário pede, por tipo de dado: se é coletado, se é compartilhado, para quê, se é opcional, se é criptografado em trânsito e se a pessoa pode pedir exclusão. A matriz abaixo é o ponto de partida. Ela parte do comportamento do Android por fluxo; a lista da Apple ("Ficha da App Store (EAS Metadata)" em [development.md](development.md)) serve só de conferência, porque as definições do Google são outras. Os nomes das categorias, o que conta como "compartilhamento" (o Google não conta, em geral, um prestador que trata dados em nome do app) e a regra para dados com criptografia de ponta a ponta precisam ser confirmados na ajuda do formulário. As retenções vêm da seção "LGPD" de `docs/design.md`, que são hipóteses de desenho ainda sem parecer jurídico.

Permissões: a matriz usa a lista que `check-apk-permissions.js` imprime no log do job `android-build` do `native.yml`. O manifesto principal declara `INTERNET`, `RECORD_AUDIO` e `VIBRATE`, o módulo de avisos `POST_NOTIFICATIONS`, e o manifesto remove `CAMERA`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE` e `AD_ID`. O APK daquele job é de debug e mostra também `SYSTEM_ALERT_WINDOW`, que vem só do manifesto de debug; confirme a lista do bundle de loja no Explorador de pacotes de apps do Console (passo 8).

| Fluxo | Dados no Android | Coletado | Compartilhado | Finalidade | Opcional | Retenção e exclusão |
|---|---|---|---|---|---|---|
| Conta | Chave pública do diário (ID de usuário), @nome, nome do perfil, foto do perfil; e-mail só se a instalação ainda guarda (a lista da Apple o mantém) | Sim | Público por desenho: perfil e @nome são públicos na rede | Funcionalidade do app, gerenciamento da conta | Não | Até Excluir conta; cópias públicas em aparelhos de terceiros não são recolhidas |
| Celular | Número de telefone | Sim | Enviado ao provedor de SMS (Didit) para o código; confirmar se conta como compartilhamento | Funcionalidade, prevenção de fraude e segurança | Não (só contas de revisão pulam) | Selado no serviço; prazos em `docs/design.md` e no README ("Verificação de celular") |
| Checagem de idade | Faixa de idade e registro do aceite; selfie ou documento tratados pela Didit | Sim | Didit (prestador); confirmar a classificação | Conformidade legal, segurança | Não | Faixa até Excluir conta; o que a Didit guarda segue a política dela, a confirmar |
| Conteúdo | Publicações, respostas, fotos, vídeos curtos, áudio (mensagens de voz, `RECORD_AUDIO`), momentos, denúncias | Sim | Público por desenho para o que é público | Funcionalidade, segurança (denúncias) | Sim (a pessoa escolhe publicar) | Até a pessoa apagar ou Excluir conta; cópias em semeadores e aparelhos de quem segue |
| Mensagens diretas e grupos privados | Mensagens cifradas de ponta a ponta | Confirmar a regra do Google; a Apple ficou de fora porque o serviço não lê | Não | Funcionalidade | Sim | Envelopes cifrados no semeador, com os prazos da linha "Envelopes de mensagens diretas" de `docs/design.md` |
| Mídia | Fotos e vídeos escolhidos pela pessoa (sem câmera do app; seletor do sistema) | Sim, quando publicados | Público por desenho para o que é público | Funcionalidade | Sim | Como o conteúdo |
| Localização declarada | Cidade e bairro digitados na Feira, sem GPS | Sim (localização aproximada) | Público por desenho no anúncio | Funcionalidade | Sim | Até apagar o anúncio ou Excluir conta |
| Estatísticas | Contadores por membro e, quando o operador liga, estatísticas de uso | Sim | Não | Funcionalidade e análise | Ligadas pelo operador; confirmar se a pessoa pode recusar | Ver `docs/design.md` |
| Busca | Termos de busca enviados ao semeador, sem ligação com a pessoa | Confirmar (a Apple declarou sem ligação) | Não | Funcionalidade | Sim | Ver `docs/design.md` |
| Players incorporados (YouTube, SoundCloud, Spotify, Apple Music) | O player carrega no aparelho sozinho, um pouco antes de o cartão aparecer, quando o item está perto da parte visível da lista, sem toque, em publicações, citações, conversas privadas, grupos e na prévia ao escrever; o serviço recebe o IP do aparelho e pode usar cookies e mostrar anúncios (YouTube) | Decisão do responsável: o dado vai do aparelho direto ao terceiro | Decisão do responsável | Funcionalidade | Sim (a chave Prévia de links desliga os players) | Política de cada serviço |
| Música do Audius | Busca, reprodução e capas passam pelo serviço de conta da associação; o Audius recebe só o endereço da associação, nunca o IP do aparelho, a chave ou a conta; o app nunca carrega um quadro do Audius | Não: o aparelho só fala com o serviço de conta (confirmar a regra do Google) | Não | Funcionalidade | Sim (a associação liga a música; há limites diários) | Política do Audius; o serviço de conta não guarda cópia do áudio |
| SDKs | Só o `firebase-messaging` (FCM), com auto-init e analytics desligados; sem SDK de anúncios, de análise ou de falhas | Ver a linha seguinte | Ver a linha seguinte | Funcionalidade | Sim | Ver a linha seguinte |
| Token FCM e metadados de aviso | Token do aparelho (ID do aparelho), frase visível do aviso, horário, tipo, tag; sinal `seen-sync` sem texto | Sim | Google (FCM) como transporte; confirmar se conta como compartilhamento | Funcionalidade | Sim (a pessoa liga os avisos) | Até desligar os avisos, token inválido ou Excluir conta (`push-devices.json`) |
| Falhas | Nenhum SDK de falhas; a fonte é o Android vitals do próprio Console | Confirmar se precisa declarar | Não | Não se aplica | Não se aplica | Não se aplica |

Para todas as linhas:

- Criptografia em trânsito: **sim** (HTTPS e WSS com o serviço e o semeador, Noise entre aparelhos). Confirmar que não sobrou nenhuma chamada sem TLS antes de declarar.
- Exclusão: **sim**, pelo app (Excluir conta) e pela URL `accountDeletionUrl`. Diários públicos já copiados por outros aparelhos não são recolhidos; diga isso nas respostas onde o formulário permitir.
- Mudou um fluxo de dados no app, mude esta matriz, o formulário da Play e a lista da Apple no mesmo PR.

**Resultado esperado:** todas as seções de "Conteúdo do app" sem pendência, menos a certificação de segurança infantil enquanto a decisão acima estiver aberta.

**Evidência:** captura de cada formulário enviado e o certificado do IARC, fora do repositório.

## 7. Teste fechado, acesso à produção e revisão

**Quem:** o responsável.

**Pré-requisito:** passos 1 a 6; os itens do passo 8 que valem para testadores.

1. Se o Console disser que a conta pessoal está sujeita ao teste fechado: criar uma faixa de teste fechado, convidar pelo menos 12 testadores (ou o número que o Console mostrar), lançar nela uma versão qualificada e mantê-la com os testadores inscritos pelo período pedido (hoje 14 dias contínuos, a confirmar). Testadores instalam pela Play, não por APK.
2. Pedir o acesso à produção no Console, com as respostas sobre o teste que ele pede.
3. Com o acesso liberado, criar a versão de produção a partir de uma versão já qualificada (passo 8) e enviá-la para revisão.

Um rascunho no teste interno, mesmo enviado pelo fluxo `android-release`, não é prontidão para a revisão de produção: falta o teste fechado (quando exigido), a qualificação do passo 8 e os formulários do passo 6.

**Resultado esperado:** o Console mostra o teste fechado concluído (quando exigido), o acesso à produção liberado e a versão "Em revisão".

**Evidência:** capturas das três telas, com datas, fora do repositório.

## 8. Qualificação antes de pedir revisão

**Quem:** o responsável, com aparelhos Android reais.

**Pré-requisito:** uma versão candidata na Play (teste interno ou fechado). Guarde a evidência privada fora do repositório; o que puder ser público vai num arquivo de verificação de um PR.

O bundle candidato:

- [ ] Identificado: SHA-256 do `.aab`, `versionCode`, pacote `app.varanda`, `targetSdkVersion` e `minSdkVersion` (31), certificado de assinatura da Play no Explorador de pacotes de apps.
- [ ] Permissões do bundle de loja no Explorador de pacotes de apps iguais às do passo 6 (sem `SYSTEM_ALERT_WINDOW`, `CAMERA`, armazenamento externo nem `AD_ID`).
- [ ] Configuração do FCM presente: o log do build traz `check-firebase-config: ok` e a linha dos avisos aparece em Ajustes.
- [ ] 16 KB: o Explorador de pacotes de apps não aponta bibliotecas fora do alinhamento de 16 KB, e o app abre e funciona num aparelho ou emulador com páginas de 16 KB.

Instalação:

- [ ] Instalação limpa pela Play (link de teste interno ou fechado) e atualização pela Play de uma versão anterior. Um APK assinado com a chave de upload não serve de prova: o app da Play é assinado pela chave do Google.

Fluxos no app instalado pela Play:

- [ ] Cadastro até o @nome, passkey (criar, entrar, segundo aparelho), código de recuperação e recuperação.
- [ ] App Links: um link `https://` da instalação abre o app.
- [ ] Publicar texto, foto, vídeo curto e áudio; momentos; ver mídia de outras pessoas.
- [ ] Mensagens diretas, grupos e Páginas.
- [ ] Denunciar uma publicação e uma conta; bloquear e desbloquear.
- [ ] Excluir conta pelo app (com uma conta de teste, nunca a de revisão).
- [ ] Uso sem rede e a volta da rede.

Avisos (devidos desde `docs/verification/feat-app-native-push.md` e `docs/verification/feat-native-seen-sync.md`):

- [ ] Entrega real pelo FCM no Android 12 e no Android 13 ou mais novo (permissão de notificação), com o app em segundo plano, encerrado e em primeiro plano; rotação e remoção do token.
- [ ] `seen-sync` ligado (`VARANDA_SEEN_SIGNAL=1`) e desligado; aceite mínimo dos Termos 102; um aviso mais antigo que a leitura fecha e um mais novo fica (o sinal vai com prioridade normal e pode atrasar em Doze; `apps/cli/lib/account/fcm.js` e `PushDeviceService.kt`).
- [ ] Depois do Android, o Web Push continua funcionando no navegador e no PWA.

Loja e qualidade:

- [ ] Relatório de pré-lançamento do Console lido, sem falha ou erro de segurança em aberto.
- [ ] As capturas da ficha mostram a versão candidata.
- [ ] Android vitals do Console acompanhado como fonte de falhas e ANRs (o app não tem SDK de falhas).

**Resultado esperado:** todos os itens marcados, com evidência.

## 9. Depois que a versão está disponível para todos

**Quem:** quem opera o servidor.

**Pré-requisito:** uma versão de produção que o Console mostra como disponível para 100% das pessoas.

**Pule este passo até o PR do aviso de versão nova (`feat/app-store-update-notice`), que publica o arquivo, estar na `main`.** Hoje nenhum código publica `/.well-known/app-release.json`; só o leitor do app (`apps/app/src/storeRelease.js`) existe.

Depois desse PR, o aviso lê o arquivo da instalação. A variável `VARANDA_ANDROID_STORE_BUILD` (nome planejado), que diz o `versionCode` a anunciar, traz o detalhe deste passo. Em resumo: definir a variável com o `versionCode` dessa versão e fazer o deploy.

Nunca para uma versão do teste interno, um rascunho ou um lançamento parcial: o aviso mandaria para a Play pessoas que ainda não podem atualizar.

**Evidência:** o `app-release.json` publicado e a captura da versão no Console.

## 10. Pausar e corrigir

- **Pausar os envios:** mudar `VARANDA_ANDROID_RELEASE` para qualquer valor diferente de `true` (Settings > Secrets and variables > Actions > Variables). O fluxo para de rodar, inclusive pelo Run workflow. Um build que já está na fila da EAS continua; cancele no expo.dev se precisar.
- **Pausar um lançamento de produção:** pelo Console, na versão em lançamento.
- **Corrigir:** a correção sai num build novo com `versionCode` maior. A Play não aceita de novo um `versionCode` já enviado, e a EAS sobe o número a cada build (`autoIncrement`). Não reduza a numeração remota.

## Perguntas em aberto

- A certificação de segurança infantil (passo 6): montar o processo de denúncia às autoridades ou deixar sem marcar.
- "Contém anúncios" e as linhas de serviços incorporados da matriz de segurança dos dados: a resposta padrão é Sim por causa do YouTube; o responsável decide.
- Se a variável de arquivo `VARANDA_GOOGLE_SERVICES_JSON` chega ao gancho `eas-build-post-install`: o primeiro build de loja responde (passo 2).
- Requisitos da conta pessoal (nível de API, 16 KB, teste fechado): confirmados só no Console, no dia (passo 1).
- Retenções e bases legais da matriz: hipóteses de `docs/design.md` sem parecer jurídico.
