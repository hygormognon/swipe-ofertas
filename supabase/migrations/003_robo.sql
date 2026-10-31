-- Coleta pelo robô próprio (GitHub Actions + Playwright) em vez do Apify.
insert into public.swipe_config (chave, valor)
values ('coletor_key', jsonb_build_object('k', encode(extensions.gen_random_bytes(24), 'hex')))
on conflict (chave) do nothing;

update public.swipe_config set valor = valor || '{"fonte": "robo"}'::jsonb where chave = 'coleta';
