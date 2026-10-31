# Swipe de Ofertas

Painel das ofertas mais escaladas da Biblioteca de Anúncios da Meta, com a mesma lógica da skill `minerar-ofertas` (tempo no ar, variações, páginas, anúncios ativos e novos em 7 dias).

- **Tela:** `index.html`, servida pelo GitHub Pages. Pede a senha e conversa só com a edge function.
- **API:** `supabase/functions/swipe` (projeto Supabase `swipe-ofertas`). A tela entra com a senha (`SWIPE_SENHA`); o robô e o agendamento do banco entram com chaves internas guardadas no banco.
- **Coleta (padrão, grátis):** `coletor/coletar.mjs` roda no GitHub Actions de hora em hora (`.github/workflows/coleta.yml`). Pergunta à API quais buscas estão devidas (sem coleta nas últimas 20 horas, ou pedidas pela tela), abre a Biblioteca num Chromium headless, sem login, e manda os anúncios para a API, que recalcula o ranking. A extração segue o [athm793/meta-ads-scraper](https://github.com/athm793/meta-ads-scraper) (Apache 2.0).
- **Coleta pelo Apify (opcional):** trocando a fonte na aba Configuração e cadastrando `APIFY_TOKEN` no Supabase, o `pg_cron` dispara o actor `automation-lab/facebook-ads-library` às 11h UTC.
- **Banco:** `supabase/migrations`. As tabelas têm RLS ligado e nenhuma policy; só a função (service role) lê e grava.

Nenhum dado nem senha fica neste repositório: ele só tem o código. O secret `COLETOR_KEY` do Actions guarda a chave do robô.

Teste local do robô: `cd coletor && npm ci && node coletar.mjs --teste "instant access" --max 30`.
