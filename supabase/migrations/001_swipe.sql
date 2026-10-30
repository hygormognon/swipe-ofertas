-- Swipe de ofertas: anúncios da Biblioteca da Meta coletados pelo Apify, agrupados por
-- oferta e ranqueados pelos mesmos sinais de escala da skill minerar-ofertas.
-- Tudo fica atrás da edge function `swipe` (service role). Nenhuma tabela tem policy,
-- então a chave pública não lê nada.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table public.swipe_config (
  chave text primary key,
  valor jsonb not null
);

create table public.swipe_buscas (
  id bigint generated always as identity primary key,
  termo text not null,
  tipo text not null default 'termo' check (tipo in ('termo', 'pagina', 'url')),
  pais text not null default 'US',
  nicho text,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  unique (tipo, termo, pais)
);

create table public.swipe_coletas (
  id bigint generated always as identity primary key,
  busca_id bigint references public.swipe_buscas (id) on delete set null,
  termo text,
  tipo text,
  pais text,
  max_ads int,
  status text not null default 'fila' check (status in ('fila', 'rodando', 'processada', 'erro')),
  run_id text,
  dataset_id text,
  anuncios int,
  custo_usd numeric,
  erro text,
  criado_em timestamptz not null default now(),
  iniciado_em timestamptz,
  processado_em timestamptz
);
create index swipe_coletas_status_idx on public.swipe_coletas (status);
create index swipe_coletas_busca_idx on public.swipe_coletas (busca_id, criado_em desc);

create table public.swipe_anuncios (
  id text primary key,
  pagina_id text,
  pagina text,
  curtidas_pagina bigint,
  ativo boolean,
  inicio date,
  fim date,
  variacoes int not null default 1,
  colacao text,
  formato text,
  link text,
  dominio_legenda text,
  titulo text,
  cta text,
  texto text,
  ia boolean not null default false,
  url_biblioteca text,
  imagem text,
  pagina_foto text,
  dominio text,
  chave text not null,
  tipo text,
  buscas text[] not null default '{}',
  paises text[] not null default '{}',
  primeiro_visto timestamptz not null default now(),
  ultimo_visto timestamptz not null default now()
);
create index swipe_anuncios_chave_idx on public.swipe_anuncios (chave);
create index swipe_anuncios_visto_idx on public.swipe_anuncios (ultimo_visto);

create table public.swipe_ofertas (
  chave text primary key,
  dominio text,
  tipo text,
  fase text,
  score numeric,
  dias_no_ar int,
  anuncios_ativos int,
  anuncios_total int,
  variacoes int,
  paginas int,
  novos_7d int,
  ultimo_anuncio date,
  formatos jsonb,
  ia boolean,
  funil_pela_url text,
  paginas_nomes text[],
  link_exemplo text,
  titulo_exemplo text,
  texto_exemplo text,
  imagem_exemplo text,
  biblioteca text[],
  buscas text[],
  paises text[],
  tendencia text not null default 'nova',
  delta_ativos int,
  delta_variacoes int,
  primeira_vez date not null default current_date,
  atualizado_em timestamptz not null default now()
);
create index swipe_ofertas_score_idx on public.swipe_ofertas (score desc);

create table public.swipe_ofertas_hist (
  dia date not null,
  chave text not null,
  score numeric,
  fase text,
  anuncios_ativos int,
  variacoes int,
  paginas int,
  novos_7d int,
  primary key (dia, chave)
);
create index swipe_ofertas_hist_chave_idx on public.swipe_ofertas_hist (chave, dia);

create table public.swipe_marcas (
  chave text primary key,
  status text check (status in ('favorita', 'analisar', 'descartada')),
  nota text,
  atualizado_em timestamptz not null default now()
);

alter table public.swipe_config enable row level security;
alter table public.swipe_buscas enable row level security;
alter table public.swipe_coletas enable row level security;
alter table public.swipe_anuncios enable row level security;
alter table public.swipe_ofertas enable row level security;
alter table public.swipe_ofertas_hist enable row level security;
alter table public.swipe_marcas enable row level security;

create view public.swipe_ofertas_v with (security_invoker = true) as
  select o.*, coalesce(m.status, '') as marca, m.nota
  from public.swipe_ofertas o
  left join public.swipe_marcas m using (chave);

-- Mesma leitura de funil pela URL do minerar.mjs.
create or replace function public.swipe_funil(j text) returns text
language sql immutable set search_path = '' as $$
  select nullif(concat_ws(', ',
    case when j ~ '(vsl|/video|/assista|/mira|/watch)' then 'vsl?' end,
    case when j ~ '(quiz|/q/|/teste|/test\M|inlead|xquiz)' then 'quiz?' end,
    case when j ~ '(/pv|/lp|/oferta|/offer|/pagina)' then 'pv?' end,
    'checkout ' || (regexp_match(j, '(hotmart|kiwify|eduzz|monetizze|perfectpay|mundpay|cakto|kirvano|ticto|braip|greenn|payt|lastlink|digistore|clickbank|buygoods|cartpanda|stripe)'))[1]
  ), '')
$$;

-- Mesmas fases do minerar.mjs.
create or replace function public.swipe_fase(dias int, variacoes int, paginas int, novos7 int) returns text
language sql immutable set search_path = '' as $$
  select case
    when dias < 7 then 'teste'
    when dias >= 30 and (variacoes >= 10 or paginas >= 2 or novos7 >= 3) then 'escalada'
    when dias >= 90 then 'veterana'
    else 'validando'
  end
$$;

-- Grava um lote de anúncios normalizados pela edge function. Mantém primeiro_visto,
-- soma as buscas e os países que já tinham achado o anúncio.
create or replace function public.swipe_ingerir(itens jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into swipe_anuncios as a (
    id, pagina_id, pagina, curtidas_pagina, ativo, inicio, fim, variacoes, colacao, formato,
    link, dominio_legenda, titulo, cta, texto, ia, url_biblioteca, imagem, pagina_foto,
    dominio, chave, tipo, buscas, paises
  )
  select x.id, x.pagina_id, x.pagina, x.curtidas_pagina, x.ativo, x.inicio, x.fim,
    coalesce(x.variacoes, 1), x.colacao, x.formato, x.link, x.dominio_legenda, x.titulo, x.cta,
    x.texto, coalesce(x.ia, false), x.url_biblioteca, x.imagem, x.pagina_foto, x.dominio,
    x.chave, x.tipo, coalesce(x.buscas, '{}'), coalesce(x.paises, '{}')
  from jsonb_to_recordset(itens) as x(
    id text, pagina_id text, pagina text, curtidas_pagina bigint, ativo boolean, inicio date,
    fim date, variacoes int, colacao text, formato text, link text, dominio_legenda text,
    titulo text, cta text, texto text, ia boolean, url_biblioteca text, imagem text,
    pagina_foto text, dominio text, chave text, tipo text, buscas text[], paises text[]
  )
  on conflict (id) do update set
    pagina_id = excluded.pagina_id,
    pagina = excluded.pagina,
    curtidas_pagina = excluded.curtidas_pagina,
    ativo = excluded.ativo,
    inicio = coalesce(excluded.inicio, a.inicio),
    fim = excluded.fim,
    variacoes = excluded.variacoes,
    colacao = excluded.colacao,
    formato = excluded.formato,
    link = excluded.link,
    dominio_legenda = excluded.dominio_legenda,
    titulo = excluded.titulo,
    cta = excluded.cta,
    texto = excluded.texto,
    ia = excluded.ia,
    url_biblioteca = excluded.url_biblioteca,
    imagem = coalesce(excluded.imagem, a.imagem),
    pagina_foto = coalesce(excluded.pagina_foto, a.pagina_foto),
    dominio = excluded.dominio,
    chave = excluded.chave,
    tipo = excluded.tipo,
    buscas = array(select distinct unnest(a.buscas || excluded.buscas)),
    paises = array(select distinct unnest(a.paises || excluded.paises)),
    ultimo_visto = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Recalcula as ofertas a partir dos anúncios vistos na janela (padrão 3 dias), com o
-- score e as fases do minerar.mjs, marca a tendência contra a foto de ~7 dias atrás
-- e grava a foto de hoje.
create or replace function public.swipe_recalcular() returns int
language plpgsql security definer set search_path = public as $$
declare
  janela int;
  n int;
begin
  select (valor->>'janela_dias')::int into janela from swipe_config where chave = 'coleta';
  janela := coalesce(janela, 3);

  with b as (
    select a.*,
      coalesce(nullif(a.colacao, ''), a.pagina_id || '|' || coalesce(a.titulo, '') || '|' || coalesce(a.formato, '')) as ck
    from swipe_anuncios a
    where a.ultimo_visto >= now() - make_interval(days => janela)
  ),
  g as (select chave, bool_or(coalesce(ativo, true)) as tem_ativo from b group by chave),
  -- Ofertas com anúncio ativo usam só os ativos; as outras usam tudo.
  bb as (select b.* from b join g using (chave) where not g.tem_ativo or coalesce(b.ativo, true)),
  -- Anúncios da mesma colação repetem o collationCount: conta o grupo uma vez só.
  col as (
    select chave, sum(v)::int as variacoes
    from (select chave, ck, max(variacoes) as v from bb group by chave, ck) x
    group by chave
  ),
  fmt as (
    select chave, jsonb_object_agg(f, c) as formatos
    from (select chave, coalesce(nullif(formato, ''), '?') as f, count(*) as c from b group by 1, 2) x
    group by chave
  ),
  ex as (
    select distinct on (chave) chave, link, titulo, texto, imagem
    from bb order by chave, variacoes desc, (imagem is null), inicio nulls last
  ),
  bib as (
    select chave, (array_agg(url_biblioteca order by variacoes desc))[1:3] as biblioteca
    from bb group by chave
  ),
  dts as (
    select chave, min(inicio) as antigo, max(inicio) as novo,
      count(*) filter (where inicio >= current_date - 7) as novos7
    from bb group by chave
  ),
  bus as (select chave, array_agg(distinct t) as buscas from b, unnest(b.buscas) t group by chave),
  pai as (select chave, array_agg(distinct t) as paises from b, unnest(b.paises) t group by chave),
  agg as (
    select chave,
      mode() within group (order by tipo) as tipo,
      count(*) filter (where coalesce(ativo, true)) as ativos,
      count(*) as total,
      count(distinct pagina_id) as paginas,
      bool_or(ia) as ia,
      (array_agg(distinct pagina))[1:5] as paginas_nomes,
      swipe_funil(lower(string_agg(coalesce(link, ''), ' '))) as funil
    from b group by chave
  ),
  calc as (
    select agg.*,
      coalesce(col.variacoes, 0) as variacoes,
      fmt.formatos,
      ex.link as link_exemplo,
      left(ex.titulo, 160) as titulo_exemplo,
      left(ex.texto, 400) as texto_exemplo,
      ex.imagem as imagem_exemplo,
      bib.biblioteca,
      coalesce(bus.buscas, '{}') as buscas,
      coalesce(pai.paises, '{}') as paises,
      greatest(0, coalesce(current_date - dts.antigo, 0)) as dias,
      coalesce(dts.novos7, 0)::int as novos7,
      dts.novo
    from agg
    left join col using (chave)
    left join fmt using (chave)
    left join ex using (chave)
    left join bib using (chave)
    left join dts using (chave)
    left join bus using (chave)
    left join pai using (chave)
  )
  insert into swipe_ofertas as o (
    chave, dominio, tipo, fase, score, dias_no_ar, anuncios_ativos, anuncios_total, variacoes,
    paginas, novos_7d, ultimo_anuncio, formatos, ia, funil_pela_url, paginas_nomes,
    link_exemplo, titulo_exemplo, texto_exemplo, imagem_exemplo, biblioteca, buscas, paises,
    atualizado_em
  )
  select chave,
    case when chave like 'pagina:%' then '' else chave end,
    tipo,
    swipe_fase(dias, variacoes, paginas::int, novos7),
    round((
      2 * ln(1 + dias)
      + 1.5 * ln(1 + variacoes)
      + 2 * ln(greatest(paginas, 1))
      + ln(1 + ativos)
      + case when novos7 > 0 then 1 + ln(1 + novos7) else 0 end
      - case when ativos = 0 then 3 else 0 end
    )::numeric, 1),
    dias, ativos, total, variacoes, paginas, novos7, novo, formatos, ia, funil, paginas_nomes,
    link_exemplo, titulo_exemplo, texto_exemplo, imagem_exemplo, biblioteca, buscas, paises,
    now()
  from calc
  on conflict (chave) do update set
    dominio = excluded.dominio,
    tipo = excluded.tipo,
    fase = excluded.fase,
    score = excluded.score,
    dias_no_ar = excluded.dias_no_ar,
    anuncios_ativos = excluded.anuncios_ativos,
    anuncios_total = excluded.anuncios_total,
    variacoes = excluded.variacoes,
    paginas = excluded.paginas,
    novos_7d = excluded.novos_7d,
    ultimo_anuncio = excluded.ultimo_anuncio,
    formatos = excluded.formatos,
    ia = excluded.ia,
    funil_pela_url = excluded.funil_pela_url,
    paginas_nomes = excluded.paginas_nomes,
    link_exemplo = excluded.link_exemplo,
    titulo_exemplo = excluded.titulo_exemplo,
    texto_exemplo = excluded.texto_exemplo,
    imagem_exemplo = coalesce(excluded.imagem_exemplo, o.imagem_exemplo),
    biblioteca = excluded.biblioteca,
    buscas = excluded.buscas,
    paises = excluded.paises,
    atualizado_em = now();
  get diagnostics n = row_count;

  -- Ofertas que saíram da janela: nenhum anúncio delas apareceu nas últimas coletas.
  update swipe_ofertas
  set tendencia = 'sumiu', anuncios_ativos = 0, novos_7d = 0
  where atualizado_em < now() and tendencia <> 'sumiu';

  -- Tendência contra a foto mais recente de pelo menos 7 dias atrás (ou a anterior a hoje).
  update swipe_ofertas o set
    delta_ativos = case when x.h_chave is null then null else o.anuncios_ativos - x.h_ativos end,
    delta_variacoes = case when x.h_chave is null then null else o.variacoes - x.h_variacoes end,
    tendencia = case
      when x.h_chave is null then 'nova'
      when o.anuncios_ativos > x.h_ativos or o.variacoes > x.h_variacoes then 'crescendo'
      when o.anuncios_ativos < x.h_ativos then 'caindo'
      else 'estável'
    end
  from (
    select o2.chave, h.chave as h_chave, h.anuncios_ativos as h_ativos, h.variacoes as h_variacoes
    from swipe_ofertas o2
    left join lateral (
      select * from swipe_ofertas_hist h
      where h.chave = o2.chave and h.dia < current_date
      order by (h.dia <= current_date - 7) desc, h.dia desc
      limit 1
    ) h on true
    where o2.atualizado_em = now()
  ) x
  where x.chave = o.chave;

  insert into swipe_ofertas_hist (dia, chave, score, fase, anuncios_ativos, variacoes, paginas, novos_7d)
  select current_date, chave, score, fase, anuncios_ativos, variacoes, paginas, novos_7d
  from swipe_ofertas where atualizado_em = now()
  on conflict (dia, chave) do update set
    score = excluded.score,
    fase = excluded.fase,
    anuncios_ativos = excluded.anuncios_ativos,
    variacoes = excluded.variacoes,
    paginas = excluded.paginas,
    novos_7d = excluded.novos_7d;

  return n;
end $$;

create or replace function public.swipe_resumo() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'fases', (
      select coalesce(jsonb_object_agg(fase, n), '{}') from (
        select fase, count(*) as n from swipe_ofertas
        where tipo = 'info' and tendencia <> 'sumiu' group by fase
      ) x
    ),
    'ofertas', (select count(*) from swipe_ofertas where tendencia <> 'sumiu'),
    'anuncios', (select count(*) from swipe_anuncios),
    'novas_hoje', (select count(*) from swipe_ofertas where primeira_vez = current_date and tipo = 'info'),
    'ultima_coleta', (select max(processado_em) from swipe_coletas where status = 'processada'),
    'na_fila', (select count(*) from swipe_coletas where status in ('fila', 'rodando')),
    'custo_30d', (select coalesce(sum(custo_usd), 0) from swipe_coletas where criado_em >= now() - interval '30 days')
  )
$$;

revoke execute on function public.swipe_ingerir(jsonb) from public, anon, authenticated;
revoke execute on function public.swipe_recalcular() from public, anon, authenticated;
revoke execute on function public.swipe_resumo() from public, anon, authenticated;

insert into public.swipe_config (chave, valor) values
  ('coleta', '{"ativo": true, "max_ads": 100, "max_paralelo": 3, "janela_dias": 3}'),
  ('cron_key', jsonb_build_object('k', encode(extensions.gen_random_bytes(24), 'hex')));
