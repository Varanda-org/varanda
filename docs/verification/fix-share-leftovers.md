# Sobras de compartilhar com a Varanda, parte 1 (branch fix/share-leftovers, parte da #535)

A #535 junta os limites que as seções 178, 179 e 180 de `docs/verification.md` deixaram. Esta parte corrige os do Android e da PWA. A parte 2 leva vídeo à folha de compartilhar nas três plataformas, com a linha nova da Privacidade, e fecha a issue.

## Decidido pelo dono do produto na #535

- Android: os três limites são corrigidos (foto que falhou pode ser tentada de novo, o compartilhamento não some quando o sistema esvazia o cache, a limpeza roda sem o app aberto).
- PWA: aviso quando o compartilhamento não cabe no espaço do navegador, e o texto do Publicar guardado na aba durante o recarregamento.
- Aceitos como estão, sem código: no iOS a pessoa abre o app depois de compartilhar, um compartilhamento novo substitui um que ainda não foi aberto, só o primeiro link entra e a extensão tem 90 s; o Safari do iOS não tem Web Share Target.

## O que muda

- **Foto que não abriu (seção 178).** Um erro passageiro ao abrir uma foto compartilhada (qualquer erro que não seja "formato não aceito" nem "... grande demais", que se repetiriam) mostra "não foi possível abrir a foto · tentar de novo" na miniatura, e um toque abre o mesmo arquivo de novo. Vale também para uma foto escolhida na galeria. A nova tentativa espera enquanto outra foto está sendo preparada (uma decodificação por vez) e fica indisponível durante o envio. Para o arquivo continuar lá, o Publicar avisa o shell com `loaded`: o shell esquece o compartilhamento sem apagar os arquivos e já lê o próximo. O Publicar apaga os arquivos com `free` quando cada foto guardada para nova tentativa abriu, foi removida, publicada ou descartada, quando a tela desmonta (um bloqueio) ou quando um compartilhamento mais novo chega (que já substituiu o guardado, um só fica em cada plataforma). Lógica pura em `holdShare`, `settleHold` e `retryableEncode` (`apps/app/src/sharedIntent.js`).
- **Compartilhamento que sumia no Android (seção 178).** Os arquivos saem do cache (`cacheDir`), que o Android pode esvaziar com pouco espaço antes de a pessoa chegar ao Publicar, e vão para `noBackupFilesDir`, que o sistema nunca esvazia sozinho e que fica fora do backup. Um compartilhamento completo que ainda esperava na pasta antiga do cache quando o app foi atualizado passa para a nova (mesma partição, uma renomeação), e o resto da pasta antiga é apagado. Em vez de um aviso de que o compartilhamento sumiu, ele simplesmente não some mais.
- **Limpeza com o app fechado (seção 178).** Cada compartilhamento guardado agenda no WorkManager uma varredura única (`varanda-share-sweep`, `REPLACE`) para 1 hora e 1 minuto depois; ela apaga o que tem mais de 1 hora, a mesma regra da varredura do app. A dependência `androidx.work:work-runtime-ktx:2.9.1` é a mesma versão exata que o app já leva pelo `expo-background-task`, então nenhuma biblioteca nova entra no APK (o teste confere as duas versões).
- **Compartilhamento que não coube na PWA (seção 180).** Quando o service worker não consegue guardar o compartilhamento (cota do navegador), a resposta continua sendo o redirecionamento 303, agora para `/?compartilhamento=nao-coube`. O app tira esse campo do endereço com `history.replaceState`, sem mexer nos outros, e mostra "o compartilhamento não coube no espaço do navegador" quando está pronto e desbloqueado; se a conta sai antes disso (Sair ou Recomeçar), o aviso não aparece para a próxima. Um campo `compartilhamento` com outro valor só sai do endereço. O sinal vai no endereço, não no cache, porque é justamente o armazenamento que falhou.
- **Texto do Publicar durante o recarregamento da PWA (seção 180).** O alvo de compartilhar carrega o app de novo e o rascunho se perdia. Agora, enquanto a página está escondida (a pessoa foi a outro app para compartilhar), o texto de uma publicação comum (sem resposta, citação ou Página) fica em `sessionStorage` (`varanda.publicarRascunho`, `{v:1, owner, at, text}`), e sai quando a página volta a ficar visível. A próxima montagem do Publicar na mesma aba lê o registro uma vez e o apaga: só volta para a mesma conta (chave pública em minúsculas), com até 1 hora e até 50.000 unidades de texto. Bloquear ou trocar de conta desmonta o Publicar e apaga o registro. As fotos do rascunho não voltam. Se um compartilhamento entra na mesma montagem, o texto guardado vem primeiro e o compartilhado depois; quando os dois não cabem, fica só o que a pessoa escreveu, como em `mergeDraft`. No app nativo não há recarregamento, e `draftKeep.native.js` não guarda nada.

## Medido

- `POST /compartilhar` sem service worker no controle: o Caddy de produção (bora.varanda.app) responde 405, como o `varanda-serve`. Fica registrado no item da seção 180 da #224.

## Testes

Cada arquivo rodou sozinho (`node apps/app/test/<arquivo>`) nesta branch e, com os mesmos testes, sobre as fontes da `main` (cópia com `git archive`, ou o arquivo da `main` posto no lugar e depois restaurado).

| Arquivo | Branch | Fontes da `main` |
|---|---|---|
| `sharedIntent.test.js` | 33/33, 204/204 | falha em `loaded` e `free` e quebra (`retryableEncode is not a function`) |
| `shareIntakeWeb.test.js` | 26/26, 182/182 | falha na lista de exportações e quebra (`takeLost is not a function`) |
| `sw.test.js` | 91/91, 985/985 | 89/91: os dois testes de cota esperam o aviso |
| `shareShell.test.js` | 7/7, 41/41 | falha nos pinos de `loaded`, `free`, rascunho e aviso |
| `shareTargetAndroid.test.js` | 11/11, 121/121 | falha (dependência, `noBackupFilesDir`, `ShareSweepWorker.kt` ausente) |
| `draftKeep.test.js` | 7/7, 51/51 | não carrega (`draftKeep.web.js` não existe) |
| `platformGate.test.js` | 6/6, 752/752 | (sem mudança) |

## Nos aparelhos

A preencher na conferência.

## Fica de fora

- Uma foto compartilhada guardada para nova tentativa vale o mesmo que o compartilhamento, 1 hora: depois disso a varredura apaga o arquivo, e o toque em "tentar de novo" mostra "o compartilhamento expirou" e encerra as tentativas.
- Entre a leitura de um compartilhamento mais novo pelo shell e a chegada dele ao Publicar (o compositor ainda fechado, ocupado ou bloqueado), o mais antigo já foi substituído no armazenamento: uma nova tentativa nesse intervalo falha de novo com o mesmo aviso. Quando o novo chega ao Publicar, as fotos antigas perdem o "tentar de novo".
- Na PWA, o texto do rascunho fica em `sessionStorage` desta aba enquanto a página está escondida e, se o compartilhamento recarregar o app bloqueado, até a pessoa desbloquear com a mesma conta (no máximo 1 hora). Outra conta nunca o vê: a leitura confere a chave e apaga o registro.
- Se a PWA abrir o compartilhamento numa janela nova em vez da mesma (o Chrome decide, o manifesto não tem `launch_handler`), o rascunho não volta na janela nova, mas continua na antiga, onde nada se perdeu.
