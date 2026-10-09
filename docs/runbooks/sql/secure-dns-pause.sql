-- APPROVAL REQUIRED. Target: frosty-river-45238500 / br-square-bread-b7vin3u3 / mosshatch.
-- Execute the whole file in ONE transaction (Neon run_sql_transaction or psql --single-transaction).
-- No BEGIN/COMMIT here: the caller owns the transaction. These flags remain paused after deployment.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';
DO $release_pause$
BEGIN
  PERFORM 1 FROM public.flags
    WHERE name IN ('registrar_writes_paused','orders_paused','agent_purchases_paused')
    ORDER BY name FOR UPDATE;
  IF (SELECT count(*) FROM public.flags
      WHERE name IN ('registrar_writes_paused','orders_paused','agent_purchases_paused')) <> 3
     OR EXISTS (SELECT 1 FROM public.flags
      WHERE name IN ('registrar_writes_paused','orders_paused','agent_purchases_paused')
      AND (value IS NULL OR value NOT IN ('true'::jsonb,'false'::jsonb))) THEN
    RAISE EXCEPTION 'release_pause_flag_drift';
  END IF;
  UPDATE public.flags
    SET value='true'::jsonb, updated_by='secure-dns-restricted-release', updated_at=now()
    WHERE name IN ('registrar_writes_paused','orders_paused','agent_purchases_paused')
      AND value='false'::jsonb;
END
$release_pause$;
SELECT name, value FROM public.flags
  WHERE name IN ('registrar_writes_paused','orders_paused','agent_purchases_paused') ORDER BY name;
