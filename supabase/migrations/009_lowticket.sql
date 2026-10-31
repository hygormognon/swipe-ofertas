-- Separa o que é oferta low ticket do resto.
-- Cada oferta ganha um veredito (lt) com o motivo:
--   sim       preço do front até o teto (US$ 50), lido na página (raio-X) ou escrito no anúncio;
--   provavel  produto digital (ebook, kit, curso, receitas...) sem preço lido ainda;
--   conferir  infoproduto sem sinal nenhum (o raio-X resolve);
--   nao       físico, app, X1, marca, serviço, high ticket, preço alto, lançamento, isca grátis.
-- A marcação manual (swipe_marcas.lt) passa por cima de tudo.

alter table public.swipe_ofertas
  add column if not exists lt text,
  add column if not exists lt_motivo text,
  add column if not exists lt_preco_usd numeric,
  add column if not exists lt_fonte text;
alter table public.swipe_marcas add column if not exists lt text;

-- Preços (em dólar) escritos no texto do anúncio. Parcela vira o total ("12x de R$ 9,70");
-- ganho, salário, desconto, valor por mês/dia e cifras em mil/milhão são ignorados.
create or replace function public.swipe_precos_anuncio(t text) returns numeric[]
language plpgsql immutable set search_path = public as $$
declare
  m text[]; n text; v numeric; parc int; r numeric[] := '{}';
begin
  if t is null or t = '' then return r; end if;
  for m in select regexp_matches(t,
    '(\S+\s+)?(\d{1,2}\s*x\s*(?:de\s*)?)?(R\$|US\$|\$|€|£)\s?(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(\s*(?:mil\M|mill|milh|bilh|bill|trilh|trill|thousand|k\M|m\M|mm\M|mi\M|b\M|bi\M|bn\M|/\s*m[eê]s|por m[eê]s|ao m[eê]s|/\s*dia|por dia|a day|per day|/\s*day|/\s*month|per month|a month|/\s*mo\M|/\s*week|por semana|de desconto|off\M|em compras|\+))?',
    'gi') loop
    if m[5] is not null then continue; end if;
    if m[1] ~* '^(ganh|fatur|lucr|renda|sal[aá]r|earn|mak|made|sav|economi|desconto|pr[eê]mio|prize|win|receb|tir|gera|cachê|pag[ao]u?s?$)' then continue; end if;
    n := m[4];
    if n ~ '[.,]\d{1,2}$' then
      v := (regexp_replace(substring(n from '^(.*)[.,]\d{1,2}$'), '[.,]', '', 'g') || '.' || substring(n from '[.,](\d{1,2})$'))::numeric;
    else
      v := regexp_replace(n, '[.,]', '', 'g')::numeric;
    end if;
    parc := nullif(substring(coalesce(m[2], '') from '^(\d+)'), '')::int;
    if parc is not null and parc > 1 then v := v * parc; end if;
    v := round(v * case upper(m[3]) when 'R$' then 0.18 when '€' then 1.08 when '£' then 1.27 else 1 end, 2);
    if v >= 0.5 then r := r || v; end if;
  end loop;
  return r;
end $$;
revoke execute on function public.swipe_precos_anuncio(text) from public, anon, authenticated;

-- Veredito low ticket de todas as ofertas. A ordem das regras importa:
-- manual > tipo > serviço > página com checkout e preço baixo > high ticket > preço da página
-- > cara de físico > preço no anúncio > lançamento/isca > produto digital > sem sinal.
create or replace function public.swipe_lowticket(teto numeric default 50) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with tx as (
    select chave, string_agg(coalesce(titulo, '') || ' ' || coalesce(texto, ''), ' ') t
    from swipe_anuncios group by chave
  ), base as (
    select o.chave, o.tipo, m.lt manual, p.preco_usd, p.checkout, p.lido_em,
      coalesce(tx.t, '') || ' ' || coalesce(o.titulo_exemplo, '') || ' ' || coalesce(o.texto_exemplo, '') || ' ' || coalesce(p.titulo, '') t,
      (select min(x) from unnest(swipe_precos_anuncio(tx.t)) x) preco_anuncio
    from swipe_ofertas o
    left join swipe_paginas p using (chave)
    left join swipe_marcas m using (chave)
    left join tx using (chave)
  ), s as (
    select *,
      t ~* '(resort|hotel|pousada|all inclusive|imobili[aá]ri|apartamento|cons[oó]rcio|seguro (de vida|auto|viagem)|plano de sa[uú]de|\mclinic\M|med ?spa|agende (sua|uma) (consulta|avalia)|empr[eé]stimo|financiamento|\mloans?\M|cash advance|fast cash|insurance|mortgage)' serv,
      t ~* '(p[oó]s[- ]?gradua|\mmba\M|faculdade|vestibular|mentoria (individual|exclusiva|vip|premium|1 ?a ?1)|sess[aã]o estrat[eé]gica|book a (free )?call|schedule a (free )?call|apply now|aplica[cç][aã]o para|free consultation|consulta gratuita)' high,
      t ~* '(ao vivo|\m(na|da|nossa) live\M|live (training|class|workshop)|webin[aá]r|masterclass|aula (gratuita|secreta|ao vivo)|evento (gratuito|online)|congresso|imers[aã]o|grupo (vip|exclusivo)|lista de espera|waitlist|free (class|training|webinar|workshop|masterclass)|inscreva-se)' lanc,
      t ~* '((e-?book|livro|guia|material|pdf|apostila|aula|minicurso|palestra|treinamento|v[ií]deos?)\s+(100%\s+)?(gr[aá]tis|gratuit)|free (e-?book|guide|download|pdf|videos?)|download free|baixe gr[aá]tis)' isca,
      t ~* '(suplemento|supplement|c[aá]psulas?|capsules?|gummies|\mgomas\M|\mdrops\M|s[eé]rum|frasco|bottles?|pomada|\mcreme\M|\mcream\M|frete|shipping|\mships\M|entrega (gr[aá]tis|r[aá]pida)|em estoque|in stock|joelheira|\mbrace\M|massageador|massager|travesseiro|pillow|t[eê]nis|sapatos?|\mshoes?\M|meias|\msocks\M|vestido|leggings|perfume|maquiagem|colch[aã]o|mattress|wormwood|milk thistle|probi[oó]tic|col[aá]geno|collagen|creatina|creatine)' fis,
      t ~* '(e-?book|apostila|\mpdf\M|planner|planilha|templates?|modelos prontos|\mpack\M|\mkit\M|\+\s?\d[\d.]*\s+(receitas|atividades|modelos|figurinhas|quest[oõ]es|exerc[ií]cios|templates|designs|svgs?|aulas|din[aâ]micas|ora[cç][oõ]es)|receitas|atividades|\mcursos?\M|\maulas\M|treinamento|certificado|videoaulas|acesso (imediato|vital[ií]cio)|lifetime access|instant (access|download)|printable|workbook|study guide|guia (completo|pr[aá]tico|definitivo)|desafio|challenge|protocolo|m[eé]todo|\mcourse\M|\msvg|patterns?|moldes|digital)' dig
    from base
  ), v as (
    select chave,
      case
        when manual in ('sim', 'nao') then array[manual, 'marcada por você', 'manual']
        when tipo = 'fisico' then array['nao', 'produto físico', 'tipo']
        when tipo = 'app' then array['nao', 'app', 'tipo']
        when tipo = 'x1' then array['nao', 'X1 (WhatsApp)', 'tipo']
        when tipo = 'marketplace' then array['nao', 'loja/marketplace', 'tipo']
        when tipo = 'marca' then array['nao', 'empresa/marca', 'tipo']
        when tipo <> 'info' then array['nao', 'sem página de vendas', 'tipo']
        when serv then array['nao', 'serviço, crédito ou negócio local', 'filtro']
        when preco_usd <= teto and checkout is not null then array['sim', 'preço e checkout na página · ' || checkout, 'pagina']
        when high then array['nao', 'high ticket (pós, mentoria, call)', 'filtro']
        when preco_usd <= teto then array['sim', 'preço na página', 'pagina']
        when preco_usd > teto then array['nao', 'preço alto na página', 'pagina']
        when fis and not dig then array['nao', 'parece produto físico', 'texto']
        when preco_anuncio <= teto then array['sim', 'preço no anúncio', 'anuncio']
        when lanc then array['nao', 'lançamento, live ou evento', 'texto']
        when isca then array['nao', 'isca gratuita (captação)', 'texto']
        when dig then array['provavel', 'produto digital, preço ainda não lido', 'texto']
        when lido_em is not null then array['conferir', 'página lida, sem preço visível', 'pagina']
        else array['conferir', 'sem sinal no anúncio', 'texto'] end r,
      case when preco_usd is not null then preco_usd when preco_anuncio <= teto then preco_anuncio end preco
    from s
  )
  update swipe_ofertas o set lt = v.r[1], lt_motivo = v.r[2], lt_fonte = v.r[3], lt_preco_usd = v.preco
  from v where v.chave = o.chave
    and (o.lt, o.lt_motivo, o.lt_fonte, o.lt_preco_usd) is distinct from (v.r[1], v.r[2], v.r[3], v.preco);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.swipe_lowticket(numeric) from public, anon, authenticated;

-- O raio-X e o recalcular já chamam esta função; ela agora também refaz o veredito.
create or replace function public.swipe_aplicar_raiox() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update swipe_ofertas o set tipo = 'fisico'
  from swipe_paginas p
  where p.chave = o.chave and p.fisico and o.tipo = 'info';
  get diagnostics n = row_count;
  perform swipe_lowticket();
  return n;
end $$;
revoke execute on function public.swipe_aplicar_raiox() from public, anon, authenticated;

-- Raio-X lê primeiro as prováveis e as sem sinal; pula as que já caíram fora por tipo,
-- marcação ou filtro definitivo (serviço, high ticket).
create or replace function public.swipe_raiox_pendentes(n int default 40)
returns table (chave text, link text)
language sql security definer set search_path = public as $$
  select o.chave, o.link_exemplo
  from swipe_ofertas o
  left join swipe_paginas p using (chave)
  left join swipe_marcas m using (chave)
  where o.tipo = 'info' and o.tendencia <> 'sumiu' and o.link_exemplo ~* '^https?://'
    and coalesce(m.status, '') <> 'descartada'
    and not (o.lt = 'nao' and o.lt_fonte in ('manual', 'tipo', 'filtro'))
    and (p.chave is null
      or p.lido_em < now() - interval '7 days'
      or (p.erro is not null and p.lido_em < now() - interval '2 days'))
  order by (p.chave is null) desc,
    case o.lt when 'provavel' then 0 when 'sim' then 1 when 'conferir' then 2 else 3 end,
    o.em_alta desc nulls last, o.score desc
  limit greatest(1, least(n, 200))
$$;
revoke execute on function public.swipe_raiox_pendentes(int) from public, anon, authenticated;

create or replace view public.swipe_ofertas_v with (security_invoker = true) as
select o.chave, o.dominio, o.tipo, o.fase, o.score, o.dias_no_ar, o.anuncios_ativos, o.anuncios_total,
  o.variacoes, o.paginas, o.novos_7d, o.ultimo_anuncio, o.formatos, o.ia, o.funil_pela_url, o.paginas_nomes,
  o.link_exemplo, o.titulo_exemplo, o.texto_exemplo, o.imagem_exemplo, o.biblioteca, o.buscas, o.paises,
  o.tendencia, o.delta_ativos, o.delta_variacoes, o.primeira_vez, o.atualizado_em, o.novos_3d, o.topo, o.em_alta,
  coalesce(m.status, '') as marca, m.nota,
  p.preco, p.moeda, p.preco_usd, p.precos, p.checkout, p.player, p.formato as formato_pagina, p.order_bump,
  p.garantia_dias, p.titulo as titulo_pagina, p.url_final, p.status_http, p.erro as raiox_erro, p.lido_em as raiox_em,
  o.lt, o.lt_motivo, o.lt_preco_usd, o.lt_fonte, m.lt as lt_manual
from swipe_ofertas o
left join swipe_marcas m using (chave)
left join swipe_paginas p using (chave);

create index if not exists swipe_ofertas_lt on public.swipe_ofertas (lt, em_alta desc);

select swipe_lowticket();
