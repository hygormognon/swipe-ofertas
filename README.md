# Swipe de Ofertas

Painel das ofertas mais escaladas da Biblioteca de Anúncios da Meta, com a mesma lógica da skill `minerar-ofertas` (tempo no ar, variações, páginas, anúncios ativos e novos em 7 dias).

- **Tela:** `index.html`, servida pelo GitHub Pages. Pede a senha e conversa só com a edge function.
- **API:** `supabase/functions/swipe` (projeto Supabase `swipe-ofertas`). A tela entra com a senha (`SWIPE_SENHA`); o robô e o agendamento do banco entram com chaves internas guardadas no banco.
- **Coleta (padrão, grátis):** `coletor/coletar.mjs` roda no GitHub Actions de hora em hora (`.github/workflows/coleta.yml`). Pergunta à API quais buscas estão devidas (sem coleta nas últimas 20 horas, ou pedidas pela tela), abre a Biblioteca num Chromium headless, sem login, e manda os anúncios para a API, que recalcula o ranking. A extração segue o [athm793/meta-ads-scraper](https://github.com/athm793/meta-ads-scraper) (Apache 2.0).
- **Coleta pelo Apify (opcional):** trocando a fonte na aba Configuração e cadastrando `APIFY_TOKEN` no Supabase, o `pg_cron` dispara o actor `automation-lab/facebook-ads-library` às 11h UTC.
- **Banco:** `supabase/migrations`. As tabelas têm RLS ligado e nenhuma policy; só a função (service role) lê e grava.

Nenhum dado nem senha fica neste repositório: ele só tem o código. O secret `COLETOR_KEY` do Actions guarda a chave do robô.

- **Em alta:** além do score (que premia tempo no ar), cada oferta tem a nota `em_alta`: anúncios novos em 7 e 3 dias, anúncios entre os 20 primeiros da busca (a Biblioteca ordena por impressões), crescimento de ativos e páginas. O robô guarda a posição de cada anúncio na busca e, no PC, faz uma 2ª passada pelos anúncios mais recentes (radar).
- **Raio-X da página:** `coletor/raiox.mjs`. No PC, depois da coleta, o robô abre a página de vendas das 40 ofertas mais em alta sem leitura e grava preço, checkout, formato (VSL, quiz, TSL), player, order bump e garantia em `swipe_paginas`. Teste: `node coletar.mjs --raiox-teste URL`.
- **Vigiar anunciante:** botão no painel da oferta; vira uma busca do tipo página.

Teste local do robô: `cd coletor && npm ci && node coletar.mjs --teste "instant access" --max 30`.
