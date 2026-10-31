-- Link do vídeo do criativo (fbcdn, assinado e com validade; a coleta diária renova).
alter table public.swipe_anuncios add column if not exists video text;

create or replace function public.swipe_ingerir(itens jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into swipe_anuncios as a (
    id, pagina_id, pagina, curtidas_pagina, ativo, inicio, fim, variacoes, colacao, formato,
    link, dominio_legenda, titulo, cta, texto, ia, url_biblioteca, imagem, video, pagina_foto,
    dominio, chave, tipo, buscas, paises
  )
  select x.id, x.pagina_id, x.pagina, x.curtidas_pagina, x.ativo, x.inicio, x.fim,
    coalesce(x.variacoes, 1), x.colacao, x.formato, x.link, x.dominio_legenda, x.titulo, x.cta,
    x.texto, coalesce(x.ia, false), x.url_biblioteca, x.imagem, x.video, x.pagina_foto, x.dominio,
    x.chave, x.tipo, coalesce(x.buscas, '{}'), coalesce(x.paises, '{}')
  from jsonb_to_recordset(itens) as x(
    id text, pagina_id text, pagina text, curtidas_pagina bigint, ativo boolean, inicio date,
    fim date, variacoes int, colacao text, formato text, link text, dominio_legenda text,
    titulo text, cta text, texto text, ia boolean, url_biblioteca text, imagem text, video text,
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
    video = coalesce(excluded.video, a.video),
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

revoke execute on function public.swipe_ingerir(jsonb) from public, anon, authenticated;
