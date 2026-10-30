# Swipe de Ofertas

Painel das ofertas mais escaladas da Biblioteca de Anúncios da Meta, com a mesma lógica da skill `minerar-ofertas` (tempo no ar, variações, páginas, anúncios ativos e novos em 7 dias).

- **Tela:** `index.html`, servida pelo GitHub Pages. Pede a senha e conversa só com a edge function.
- **API:** `supabase/functions/swipe` (projeto Supabase `swipe-ofertas`). Protegida pela senha (`SWIPE_SENHA`) e, para o agendamento, por uma chave interna guardada no banco.
- **Coleta:** o `pg_cron` chama a função às 11h UTC (8h de Brasília). Cada busca vira uma execução do actor `automation-lab/facebook-ads-library` no Apify (`APIFY_TOKEN`). A cada 5 minutos, enquanto houver fila, a função baixa o que terminou e recalcula o ranking.
- **Banco:** `supabase/migrations`. As tabelas têm RLS ligado e nenhuma policy; só a função (service role) lê e grava.

Nenhum dado fica neste repositório: ele só tem o código.
