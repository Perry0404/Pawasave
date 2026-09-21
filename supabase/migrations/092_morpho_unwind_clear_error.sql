-- 092_morpho_unwind_clear_error.sql
-- Cosmetic: a successful record_morpho_unwind now clears any stale `error` text left on
-- the draw by an earlier failed attempt, so a 'closed' draw doesn't display an old error.
-- Same behaviour as 089 otherwise (close the draw + book financing cost against revenue).

CREATE OR REPLACE FUNCTION public.record_morpho_unwind(
  p_loan_id uuid, p_cngn_repaid_micro bigint, p_financing_cost_micro bigint, p_repay_tx text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.morpho_loan_draws
     SET status = 'closed',
         cngn_repaid_micro = GREATEST(0, COALESCE(p_cngn_repaid_micro, 0)),
         financing_cost_micro = COALESCE(p_financing_cost_micro, 0),
         repay_tx = p_repay_tx,
         error = NULL,
         updated_at = now()
   WHERE loan_id = p_loan_id;

  IF COALESCE(p_financing_cost_micro, 0) > 0 THEN
    UPDATE public.platform_settings
       SET value = GREATEST(0, COALESCE(value::bigint, 0) - FLOOR(p_financing_cost_micro / 10000))::text
     WHERE key = 'platform_revenue_kobo';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.record_morpho_unwind(uuid, bigint, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_morpho_unwind(uuid, bigint, bigint, text) TO service_role;
