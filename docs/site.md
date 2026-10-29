# O site do Varanda

## O que é

Uma página estática em `apps/site/public`, publicada na GitHub Pages em https://varanda.app/ (e, antes do domínio, em https://varanda-org.github.io/varanda/). Não há JavaScript, formulários, cookies nem rastreadores na página. A própria GitHub Pages registra o endereço IP de cada visitante por segurança (documentação da GitHub, "What is GitHub Pages?", seção "Data collection").

`apps/site/public` é a raiz publicável. `apps/site/artwork` (fontes do logotipo, `og.html`, `screens.md`) e `apps/site/scripts` (`serve.js`, `render-assets.js`) são fontes e nunca são enviados.

## Como ver localmente

```sh
npm run dev -w apps/site
```

Abre em http://127.0.0.1:4173/. Para ver como ficará em https://varanda-org.github.io/varanda/:

```sh
node apps/site/scripts/serve.js --prefix /varanda
```

O que conferir:

- Largura de 390 px (celular): sem rolagem horizontal, texto legível.
- Reduzir movimento: em macOS Ajustes > Acessibilidade > Tela, ligue "Reduzir movimento" e recarregue; a animação deve parar.
- Foco com Tab: todo link e botão mostra o foco, na ordem da página.
- O botão "pausar o movimento" pausa e retoma a animação.

## Como atualizar

Edite os arquivos em `apps/site/public` e abra um pull request. A publicação roda sozinha quando o pull request entra em `main`: o fluxo `.github/workflows/site.yml` roda no push para `main` e no disparo manual (os dois restritos a `main`), envia só `apps/site/public` com `actions/upload-pages-artifact` v5.0.0 e publica com `actions/deploy-pages` v5.0.1 (ambos fixados por SHA). Não há arquivo `CNAME`: o domínio próprio fica nas configurações de Pages do repositório.

## Capturas e logotipo

- Telas do app: a página mostra uma prévia do desenho novo do app, em HTML e CSS dentro do telefone, com conteúdo fictício (não são capturas). O desenho está em [apps/site/artwork/app-design.md](../apps/site/artwork/app-design.md). A receita para capturar o app de verdade, quando ele tiver esse desenho, está em [apps/site/artwork/screens.md](../apps/site/artwork/screens.md).
- Logotipo, ícones, abertura e favicons: gerados das SVGs em `apps/site/artwork/logo`.

```sh
node apps/site/scripts/render-assets.js          # regenera tudo
node apps/site/scripts/render-assets.js --check  # verifica sem gravar
```

Precisa de `rsvg-convert` (`brew install librsvg`). O `cwebp` (`brew install webp`) só serve para a receita de capturas em `apps/site/artwork/screens.md`. Os mipmaps do Android são bytes PNG com nome `.webp`, como o Expo grava.

Nunca use `npx expo prebuild` para regenerar ícones: `apps/app/ios/Varanda/AppDelegate.swift` (exclusão de backup) e `apps/app/android/app/build.gradle` (assinatura de release) têm correções de segurança feitas à mão que o prebuild sobrescreveria (veja [development.md](development.md) e [verification.md](verification.md)). Depois de qualquer `npm ci`, rode `npm run prepare:native -w apps/app` de novo antes de um build iOS.

## Publicação: passos do usuário

Todos os passos abaixo são seus (do usuário). O agente não faz merge, não muda configurações, não mexe em DNS e não roda fluxos. Siga a ordem.

1. **Seu passo.** Descubra onde está a zona DNS de varanda.app:

   ```sh
   dig NS varanda.app +short
   ```

   Servidores da GoDaddy parecem `ns*.domaincontrol.com`. Edite os registros só onde a zona está hospedada.

2. **Seu passo.** Verifique o domínio para a organização (evita sequestro de domínio). No GitHub: organização Varanda-org > Settings > Pages > Add a domain > `varanda.app`. O GitHub mostra um registro TXT: um nome de host começando com `_github-pages-challenge-` e um valor. Copie os DOIS exatamente como o GitHub mostra. Na GoDaddy: Domain Portfolio > varanda.app > DNS > Add New Record > Type TXT, Name = esse nome de host sem o `.varanda.app` do final, Value = o código, TTL 1 hour. Espere alguns minutos, clique em Verify e mantenha o registro depois.

3. **Seu passo.** No repositório Varanda-org/varanda > Settings > Pages > Build and deployment > Source: "GitHub Actions". Depois, Custom domain: `varanda.app` > Save. A checagem de DNS falha até o passo 5; isso é esperado. Se o GitHub recusar salvar o domínio antes da primeira publicação, faça o passo 4 primeiro e volte aqui.

4. **Seu passo.** Faça o merge do pull request. O fluxo "site" roda nesse push para `main` e publica a página. Se não rodou: Actions > site > Run workflow (branch `main`).

5. **Seu passo.** DNS da varanda.app na GoDaddy. Apague o registro A de estacionamento em `@`, qualquer encaminhamento de domínio e qualquer registro `*` (curinga); mantenha MX e os outros TXT. Adicione, com TTL 1 hour:

   | Tipo | Nome | Valor |
   |---|---|---|
   | A | `@` | 185.199.108.153 |
   | A | `@` | 185.199.109.153 |
   | A | `@` | 185.199.110.153 |
   | A | `@` | 185.199.111.153 |
   | AAAA | `@` | 2606:50c0:8000::153 |
   | AAAA | `@` | 2606:50c0:8001::153 |
   | AAAA | `@` | 2606:50c0:8002::153 |
   | AAAA | `@` | 2606:50c0:8003::153 |
   | CNAME | `www` | `varanda-org.github.io` (sem https:// e sem o nome do repositório) |

   Nunca adicione um registro curinga: a GitHub avisa que ele permite sequestro de domínio, mesmo com o domínio verificado.

6. **Seu passo.** De volta a Settings > Pages: espere "DNS check successful" e marque "Enforce HTTPS" quando a opção aparecer (a GitHub diz que pode levar até 24 horas). `.app` é um domínio só HTTPS (HSTS pré-carregado): os navegadores não abrem o site por http; ele funciona assim que o certificado sai.

## Verificação depois de publicar

Todas as checagens abaixo estão pendentes até a publicação.

```sh
dig +short varanda.app A                             # os quatro endereços do passo 5
dig +short varanda.app AAAA                          # os quatro endereços do passo 5
dig +short www.varanda.app CNAME                     # varanda-org.github.io.
curl -sI https://varanda.app/                        # 200, server: GitHub.com
curl -sI https://www.varanda.app/                    # 301 para https://varanda.app/
curl -sI https://varanda.app/assets/og-varanda.jpg   # 200, image/jpeg
```

- Pendente até a publicação: abra o site no celular.
- Pendente até a publicação: mande o link para você mesmo no WhatsApp e confira o cartão de pré-visualização (título, texto, imagem). O WhatsApp guarda as pré-visualizações em cache: se uma antiga ficar presa, renomear a imagem og quebra o cache.

## O que o agente nunca faz

- Fazer merge de pull request ou dar push em `main`.
- Mudar configurações do repositório ou da organização (Pages, domínio, Enforce HTTPS).
- Mexer em DNS ou na conta da GoDaddy.
- Rodar ou disparar fluxos do GitHub Actions, criar releases ou implantações.
- Regenerar ícones com `expo prebuild`.
