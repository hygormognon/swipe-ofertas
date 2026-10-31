-- Reclassificação dos anúncios já gravados com as regras novas: fb.com e links de
-- rastreio de app deixam de virar oferta; marketplaces de produto físico viram
-- "marketplace"; plataformas de produto digital (Etsy, Gumroad...) seguem como info,
-- mas agrupadas por página. Depois: select swipe_recalcular();
update swipe_anuncios set
  tipo = case
    when dominio ~ '(^|\.)(adjust\.com|onelink\.me|app\.link|appsflyer\.com|go\.link)$' then 'app'
    when dominio ~ '(^|\.)(fb\.com|fb\.watch|messenger\.com|threads\.net)$' then 'outros'
    when dominio ~ '(^|\.)(amazon\.[a-z.]+|amzn\.to|ebay\.[a-z.]+|walmart\.com|temu\.com|aliexpress\.com|shein\.com)$' then 'marketplace'
    else tipo end,
  chave = 'pagina:' || pagina_id
where dominio ~ '(^|\.)(adjust\.com|onelink\.me|app\.link|appsflyer\.com|go\.link|fb\.com|fb\.watch|messenger\.com|threads\.net|amazon\.[a-z.]+|amzn\.to|ebay\.[a-z.]+|walmart\.com|temu\.com|aliexpress\.com|shein\.com|etsy\.com|teacherspayteachers\.com|gumroad\.com|udemy\.com|skillshare\.com|stan\.store|payhip\.com|ko-fi\.com|patreon\.com)$';
