-- Reserve every Meta delivery attempt against the global rolling-hour circuit
-- before making the external call. The timestamp remains stable across later
-- SENT/FAILED reconciliation so uncertain and failed attempts stay counted.
ALTER TABLE "SavTransportItem"
  ADD COLUMN "deliveryAttemptedAt" TIMESTAMP(3);

CREATE INDEX "SavTransportItem_deliveryAttemptedAt_idx"
  ON "SavTransportItem"("deliveryAttemptedAt");

CREATE FUNCTION enforce_sav_delivery_attempted_at_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."deliveryAttemptedAt" IS NOT NULL
     AND NEW."deliveryAttemptedAt" IS DISTINCT FROM OLD."deliveryAttemptedAt" THEN
    RAISE EXCEPTION 'SavTransportItem.deliveryAttemptedAt is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "SavTransportItem_deliveryAttemptedAt_immutable"
BEFORE UPDATE OF "deliveryAttemptedAt" ON "SavTransportItem"
FOR EACH ROW
EXECUTE FUNCTION enforce_sav_delivery_attempted_at_immutable();
