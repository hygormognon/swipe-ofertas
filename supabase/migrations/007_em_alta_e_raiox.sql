-- "Em alta" e raio-X da página de vendas.
-- - swipe_anuncios.posicao: posição do anúncio na busca padrão da Biblioteca, que vem na
--   ordem de impressões. Fora da UE é o único sinal de verba que a Meta mostra.
-- - swipe_ofertas.em_alta: nota de momento (anúncios novos, topo da busca, crescimento),
--   ao lado do score, que premia tempo no ar.
-- - swipe_paginas: o que o robô do PC leu na página de vendas (preço, checkout, formato).

alter table public.swipe_anuncios add column if not exists posicao int;

alter table public.swipe_ofertas
  add column if not exists novos_3d int,
  add column if not exists topo int,
  add column if not exists em_alta numeric;
create index if not exists swipe_ofertas_em_alta_idx on public.swipe_ofertas (em_alta desc);

alter table public.swipe_ofertas_hist add column if not exists em_alta numeric;

create table if not exists public.swipe_paginas (
  chave text primary key,
  url text,
  url_final text,
  status_http int,
  titulo text,
  preco numeric,
  moeda text,
  preco_usd numeric,
  precos numeric[],
  checkout text,
  checkout_lido text,
  player text,
  formato text,
  order_bump boolean,
  garantia_dias int,
  idioma text,
  erro text,
  lido_em timestamptz not null default now()
);
alter table public.swipe_paginas enable row level security;

drop view if exists public.swipe_ofertas_v;
create view public.swipe_ofertas_v with (security_invoker = true) as
  select o.*, coalesce(m.status, '') as marca, m.nota,
    p.preco, p.moeda, p.preco_usd, p.precos, p.checkout, p.player, p.formato as formato_pagina,
    p.order_bump, p.garantia_dias, p.titulo as titulo_pagina, p.url_final, p.status_http,
    p.erro as raiox_erro, p.lido_em as raiox_em
  from public.swipe_ofertas o
  left join public.swipe_marcas m using (chave)
  left join public.swipe_paginas p using (chave);

-- Mesma gravação da 005, agora com a posição. Na mesma rodada (várias buscas no dia)
-- fica a melhor posição; numa coleta nova, a posição de agora.
create or replace function public.swipe_ingerir(itens jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into swipe_anuncios as a (
    id, pagina_id, pagina, curtidas_pagina, ativo, inicio, fim, variacoes, colacao, formato,
    link, dominio_legenda, titulo, cta, texto, ia, url_biblioteca, imagem, video, pagina_foto,
    dominio, chave, tipo, buscas, paises, posicao
  )
  select x.id, x.pagina_id, x.pagina, x.curtidas_pagina, x.ativo, x.inicio, x.fim,
    coalesce(x.variacoes, 1), x.colacao, x.formato, x.link, x.dominio_legenda, x.titulo, x.cta,
    x.texto, coalesce(x.ia, false), x.url_biblioteca, x.imagem, x.video, x.pagina_foto, x.dominio,
    x.chave, x.tipo, coalesce(x.buscas, '{}'), coalesce(x.paises, '{}'), x.posicao
  from jsonb_to_recordset(itens) as x(
    id text, pagina_id text, pagina text, curtidas_pagina bigint, ativo boolean, inicio date,
    fim date, variacoes int, colacao text, formato text, link text, dominio_legenda text,
    titulo text, cta text, texto text, ia boolean, url_biblioteca text, imagem text, video text,
    pagina_foto text, dominio text, chave text, tipo text, buscas text[], paises text[], posicao int
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
    video = coalesce(excluded.video, a.video),
    pagina_foto = coalesce(excluded.pagina_foto, a.pagina_foto),
    dominio = excluded.dominio,
    chave = excluded.chave,
    tipo = excluded.tipo,
    buscas = array(select distinct unnest(a.buscas || excluded.buscas)),
    paises = array(select distinct unnest(a.paises || excluded.paises)),
    posicao = case when a.ultimo_visto >= now() - interval '20 hours' then least(a.posicao, excluded.posicao) else excluded.posicao end,
    ultimo_visto = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Mesmo recálculo da 001, mais novos_3d, topo (anúncios entre os 20 primeiros de alguma
-- busca) e a nota em_alta, que mede o momento:
--   2,5·ln(1+novos 7d) + 1,5·ln(1+novos 3d) + 2·ln(1+topo) + 1,5·ln(1+crescimento de ativos)
--   + ln(1+ativos) + ln(páginas) + 1 se tem até 60 dias − 4 se não tem anúncio ativo
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
  bb as (select b.* from b join g using (chave) where not g.tem_ativo or coalesce(b.ativo, true)),
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
      count(*) filter (where inicio >= current_date - 7) as novos7,
      count(*) filter (where inicio >= current_date - 3) as novos3,
      count(*) filter (where posicao <= 20) as topo
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
      coalesce(dts.novos3, 0)::int as novos3,
      coalesce(dts.topo, 0)::int as topo,
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
    paginas, novos_7d, novos_3d, topo, ultimo_anuncio, formatos, ia, funil_pela_url, paginas_nomes,
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
    dias, ativos, total, variacoes, paginas, novos7, novos3, topo, novo, formatos, ia, funil, paginas_nomes,
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
    novos_3d = excluded.novos_3d,
    topo = excluded.topo,
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

  update swipe_ofertas
  set tendencia = 'sumiu', anuncios_ativos = 0, novos_7d = 0, novos_3d = 0, topo = 0, em_alta = 0
  where atualizado_em < now() and tendencia <> 'sumiu';

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

  update swipe_ofertas set em_alta = round((
      2.5 * ln(1 + novos_7d)
      + 1.5 * ln(1 + coalesce(novos_3d, 0))
      + 2 * ln(1 + coalesce(topo, 0))
      + 1.5 * ln(1 + greatest(coalesce(delta_ativos, 0), 0))
      + ln(1 + anuncios_ativos)
      + ln(greatest(paginas, 1))
      + case when dias_no_ar <= 60 then 1 else 0 end
      - case when anuncios_ativos = 0 then 4 else 0 end
    )::numeric, 1)
  where atualizado_em = now();

  insert into swipe_ofertas_hist (dia, chave, score, fase, anuncios_ativos, variacoes, paginas, novos_7d, em_alta)
  select current_date, chave, score, fase, anuncios_ativos, variacoes, paginas, novos_7d, em_alta
  from swipe_ofertas where atualizado_em = now()
  on conflict (dia, chave) do update set
    score = excluded.score,
    fase = excluded.fase,
    anuncios_ativos = excluded.anuncios_ativos,
    variacoes = excluded.variacoes,
    paginas = excluded.paginas,
    novos_7d = excluded.novos_7d,
    em_alta = excluded.em_alta;

  return n;
end $$;

-- Páginas de vendas que o robô do PC deve ler: infoprodutos ativos e não descartados, sem
-- raio-X ou com raio-X de mais de 7 dias (2, se deu erro), as mais em alta primeiro.
create or replace function public.swipe_raiox_pendentes(n int) returns table (chave text, link text)
language sql stable security definer set search_path = public as $$
  select o.chave, o.link_exemplo
  from swipe_ofertas o
  left join swipe_paginas p using (chave)
  left join swipe_marcas m using (chave)
  where o.tipo = 'info' and o.tendencia <> 'sumiu' and o.link_exemplo ~* '^https?://'
    and coalesce(m.status, '') <> 'descartada'
    and (p.chave is null
      or p.lido_em < now() - interval '7 days'
      or (p.erro is not null and p.lido_em < now() - interval '2 days'))
  order by (p.chave is null) desc, o.em_alta desc nulls last, o.score desc
  limit greatest(1, least(n, 200))
$$;

revoke execute on function public.swipe_ingerir(jsonb) from public, anon, authenticated;
revoke execute on function public.swipe_recalcular() from public, anon, authenticated;
revoke execute on function public.swipe_raiox_pendentes(int) from public, anon, authenticated;

select swipe_recalcular();
