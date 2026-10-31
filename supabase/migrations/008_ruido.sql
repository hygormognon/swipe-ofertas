-- Menos ruído no ranking de infoproduto:
-- - rastreio de mídia (doubleclick) vira "outros" e encurtadores (bit.ly, geni.us) agrupam
--   por página, como as redes;
-- - Mercado Livre, Shopee, Wayfair, lojas de jogo etc. viram marketplace;
-- - empresa grande, banco, ONG, político, governo e universidade viram o tipo novo "marca";
-- - anúncio de catálogo ({{product.name}}) vira físico;
-- - página que o raio-X leu como loja física (carrinho, frete, estoque, sem entrega
--   digital) faz a oferta virar físico.

alter table public.swipe_paginas add column if not exists fisico boolean;

create or replace function public.swipe_aplicar_raiox() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update swipe_ofertas o set tipo = 'fisico'
  from swipe_paginas p
  where p.chave = o.chave and p.fisico and o.tipo = 'info';
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.swipe_aplicar_raiox() from public, anon, authenticated;

update swipe_anuncios set
  tipo = case
    when dominio ~ '(^|\.)(doubleclick\.net|googleadservices\.com|dartsearch\.net|atdmt\.com|flashtalking\.com|adform\.net|sizmek\.com)$' then 'outros'
    when dominio ~ '(^|\.)(mercadoli[bv]re\.com(\.[a-z]+)?|shopee\.[a-z.]+|magazineluiza\.com\.br|magalu\.com|americanas\.com\.br|casasbahia\.com\.br|wayfair\.com|target\.com|bestbuy\.com|store\.playstation\.com|store\.steampowered\.com)$' then 'marketplace'
    when dominio ~ '(^|\.)(aarp\.org|capitalone\.com|chase\.com|chatgpt\.com|openai\.com|datadoghq\.com|charitywater\.org|rainforest-alliance\.org|actblue\.com|winred\.com|reclameaqui\.com\.br|britania\.com\.br|infinitepay\.io|jim\.com|facebookblueprint\.com|meta\.com|google\.com|microsoft\.com|grupoboticario\.com\.br|natura\.com\.br|nubank\.com\.br|itau\.com\.br|bradesco\.com\.br|santander\.com\.br|paypal\.com|netflix\.com|spotify\.com)$|\.(gov|gov\.br|mil|edu|edu\.br)$' then 'marca'
    else tipo end,
  chave = case
    when dominio ~ '(^|\.)(doubleclick\.net|googleadservices\.com|dartsearch\.net|atdmt\.com|flashtalking\.com|adform\.net|sizmek\.com|bit\.ly|geni\.us|tinyurl\.com|rebrand\.ly|cutt\.ly|ow\.ly|t\.co|lnk\.bio|beacons\.ai|tr\.ee|l\.ead\.me|shorturl\.at|is\.gd|bl\.ink|mercadoli[bv]re\.com(\.[a-z]+)?|shopee\.[a-z.]+|magazineluiza\.com\.br|magalu\.com|americanas\.com\.br|casasbahia\.com\.br|wayfair\.com|target\.com|bestbuy\.com|store\.playstation\.com|store\.steampowered\.com)$' then 'pagina:' || pagina_id
    else chave end
where dominio ~ '(^|\.)(doubleclick\.net|googleadservices\.com|dartsearch\.net|atdmt\.com|flashtalking\.com|adform\.net|sizmek\.com|bit\.ly|geni\.us|tinyurl\.com|rebrand\.ly|cutt\.ly|ow\.ly|t\.co|lnk\.bio|beacons\.ai|tr\.ee|l\.ead\.me|shorturl\.at|is\.gd|bl\.ink|mercadoli[bv]re\.com(\.[a-z]+)?|shopee\.[a-z.]+|magazineluiza\.com\.br|magalu\.com|americanas\.com\.br|casasbahia\.com\.br|wayfair\.com|target\.com|bestbuy\.com|store\.playstation\.com|store\.steampowered\.com|aarp\.org|capitalone\.com|chase\.com|chatgpt\.com|openai\.com|datadoghq\.com|charitywater\.org|rainforest-alliance\.org|actblue\.com|winred\.com|reclameaqui\.com\.br|britania\.com\.br|infinitepay\.io|jim\.com|facebookblueprint\.com|meta\.com|google\.com|microsoft\.com|grupoboticario\.com\.br|natura\.com\.br|nubank\.com\.br|itau\.com\.br|bradesco\.com\.br|santander\.com\.br|paypal\.com|netflix\.com|spotify\.com)$|\.(gov|gov\.br|mil|edu|edu\.br)$';

-- play.google.com casa com google.com acima; na função, app é testado antes de marca.
update swipe_anuncios set tipo = 'app' where tipo = 'marca' and dominio ~ '(^|\.)(apps\.apple\.com|itunes\.apple\.com|play\.google\.com)$';

update swipe_anuncios set tipo = 'fisico'
where tipo = 'info' and (titulo ~* '\{\{\s*product\.' or texto ~* '\{\{\s*product\.');

select swipe_recalcular();

-- Ofertas cujo domínio virou agrupamento por página (bit.ly, doubleclick...) ficaram sem
-- anúncio: saem do ranking de infoproduto.
update swipe_ofertas o set tipo = 'outros'
where not exists (select 1 from swipe_anuncios a where a.chave = o.chave) and o.tipo = 'info';

select swipe_aplicar_raiox();
