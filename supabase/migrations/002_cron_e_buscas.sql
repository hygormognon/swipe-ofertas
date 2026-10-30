-- Coleta diária às 11h UTC (8h de Brasília) e processamento a cada 5 minutos enquanto
-- houver coleta na fila ou rodando.
select cron.schedule('swipe-coleta-diaria', '0 11 * * *', $$
  select net.http_post(
    url := 'https://zdpiertlotdpxdufsjhr.supabase.co/functions/v1/swipe',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron', (select valor->>'k' from public.swipe_config where chave = 'cron_key')),
    body := '{"acao":"coletar"}'::jsonb,
    timeout_milliseconds := 60000
  )
$$);
select cron.schedule('swipe-processar', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://zdpiertlotdpxdufsjhr.supabase.co/functions/v1/swipe',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron', (select valor->>'k' from public.swipe_config where chave = 'cron_key')),
    body := '{"acao":"processar"}'::jsonb,
    timeout_milliseconds := 120000
  )
  where exists (select 1 from public.swipe_coletas where status in ('fila', 'rodando'))
$$);

-- Buscas iniciais: low ticket para os EUA (CTA e forma de entrega + algumas sementes de nicho).
insert into public.swipe_buscas (termo, pais, nicho) values
 ('watch the video until the end', 'US', 'CTA'),
 ('instant access', 'US', 'CTA'),
 ('instant download', 'US', 'entrega'),
 ('step-by-step guide', 'US', 'CTA'),
 ('lifetime access', 'US', 'entrega'),
 ('printable', 'US', 'entrega'),
 ('digital download', 'US', 'entrega'),
 ('templates bundle', 'US', 'entrega'),
 ('protocol', 'US', 'CTA'),
 ('blueprint', 'US', 'CTA'),
 ('worksheets', 'US', 'educação'),
 ('crochet patterns', 'US', 'artesanato'),
 ('bible study', 'US', 'fé'),
 ('brain exercises for seniors', 'US', 'memória');
