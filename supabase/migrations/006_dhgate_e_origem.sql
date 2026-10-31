-- dhgate e wish passam a marketplace; as coletas antigas do robô ganham a origem pela
-- quantidade (o GitHub só traz ~30 anúncios, o PC traz 100).
update swipe_anuncios set tipo = 'marketplace', chave = 'pagina:' || pagina_id
where dominio ~ '(^|\.)(dhgate\.com|wish\.com)$';
update swipe_coletas set run_id = 'robo-pc' where run_id = 'robo' and anuncios > 35;
update swipe_coletas set run_id = 'robo-github' where run_id = 'robo' and anuncios <= 35;
select swipe_recalcular();
