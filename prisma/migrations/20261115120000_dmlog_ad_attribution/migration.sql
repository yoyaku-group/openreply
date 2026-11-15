-- Paid-ad attribution for comments: Meta reports which ad a comment was left on
-- (media.ad_id / media.ad_title, or the flat ad_id / ad_title fields of the
-- change value). Persisting them on the DM log lets a WooCommerce order be
-- reconciled to the DM that produced it and therefore to the ad that paid for
-- it. Additive only: two nullable columns and an index. Organic comments keep
-- both columns NULL, and existing rows stay valid without a backfill.

ALTER TABLE "DmLog" ADD COLUMN "adId" TEXT;
ALTER TABLE "DmLog" ADD COLUMN "adTitle" TEXT;

CREATE INDEX "DmLog_adId_idx" ON "DmLog"("adId");
