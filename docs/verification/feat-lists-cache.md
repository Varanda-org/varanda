# Reabertura das seis listas com a cópia guardada

A cópia `listas` guarda num arquivo só a primeira página de Seguindo, Posts salvos, a vista padrão da Feira, Assuntos do momento, Curtidas da última publicação aberta e os Depoimentos à mostra da própria pessoa. Cada lista vale 14 dias a partir da própria gravação. O arquivo cabe em 256 KiB e cada lista em 40 KiB.

## Testes locais

`npm run lint` passou, `npm run demo` terminou com "DEMO OK" e os 66 arquivos de teste direcionados (os alterados e os que importam um módulo alterado) passaram. A suíte inteira roda na CI do GitHub. O app não rodou no Android, no iOS, na web nem no PWA instalado: o roteiro abaixo está pendente.

## Roteiro

Use a conta pessoal, com sessão aberta, numa instalação hospedada. Repita cada passo no Android, no iOS, na web e no PWA instalado.

1. Seguindo. Abra a lista própria, espere as linhas, feche o app e reabra. As chaves de outras pessoas ficam ocultas até `block.list` responder. Depois disso a cópia aparece (até 100 chaves) enquanto `follow.list` responde, e a página ao vivo substitui as linhas. A lista Seguindo de outra pessoa, aberta no perfil dela, espera o nó e não pinta essa cópia.
2. Posts salvos. Salve publicações, inclusive uma publicação pública de quem você não segue. Feche o app e reabra a tela. As linhas de outras pessoas ficam ocultas até `block.list` responder. A cópia mostra até 30 publicações já conferidas. Até o nó confirmar a linha, tocá-la não abre a publicação. A leitura ao vivo substitui as linhas.
3. Feira. Na vista padrão (Na cidade), espere a grade de uma cidade, anote a hora da última visita (a marca que alimenta "N novos desde a última visita") e feche o app. Reabra a mesma cidade. Os anúncios de outras pessoas ficam ocultos até `block.list` responder. A cópia pinta até 30 anúncios daquele escopo. Enquanto só a cópia está na tela, a hora da última visita continua a mesma, e um toque num anúncio da cópia não abre o anúncio. Quando a página ao vivo substitui a grade, a visita pode ser gravada. Outra cidade não pinta a cópia da cidade anterior. Meus, Salvos, Buscas e a grade de uma pessoa esperam o nó.
4. Assuntos do momento. Abra Busca, em Publicações, com o campo vazio, espere a lista, feche o app e reabra do mesmo jeito. Os assuntos guardados (até 30) aparecem enquanto o nó pede a lista de novo, e a resposta ao vivo substitui a lista. Uma lista incompleta (índice em reconstrução) não é guardada. Digite uma busca, veja resultados, feche o app e reabra: a consulta e os resultados não voltam da cópia. O campo começa vazio.
5. Curtidas. Abra quem curtiu uma publicação, espere a primeira página, volte e abra de novo a mesma publicação. As pessoas ficam ocultas até `block.list` responder. A cópia pinta quem curtiu (até 30) e, em seguida, a página ao vivo substitui essas linhas. A aba Republicações da mesma publicação espera o nó e não usa essa cópia. Abrir quem curtiu outra publicação também não usa a cópia da anterior.
6. Depoimentos. No perfil próprio, com depoimentos à mostra e pelo menos um em "Para aprovar", abra a tela Depoimentos, espere carregar, feche o app e reabra. Os depoimentos à mostra de outras pessoas ficam ocultos até `block.list` responder. A cópia pinta os primeiros 30 à mostra. "Para aprovar" só aparece com a leitura ao vivo. Nas linhas pintadas da cópia não há "Remover". Quando a leitura ao vivo substitui as linhas à mostra, "Remover" volta. Guardados, Enviados e os depoimentos do perfil de outra pessoa esperam o nó.
7. Com as seis listas preenchidas, saia da conta. No cache do app nativo, `varanda-screen-listas.json` e as variantes `.bak` e `.tmp` somem. Na web e no PWA instalado, a chave `varanda-screen-listas` sai do `localStorage`. Entre de novo, preencha a cópia e repita depois de trancar a sessão.
8. Com uma pessoa nas linhas guardadas de Salvos, da Feira, de Curtidas ou de Depoimentos, bloqueie essa pessoa em outro aparelho e reabra. As linhas dela ficam de fora.

Verificação manual pendente.
