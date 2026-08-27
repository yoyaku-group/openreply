-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "InstagramAccount" ADD COLUMN     "lastScopeProbeAt" TIMESTAMP(3);
ALTER TABLE "InstagramAccount" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "InstagramAccount_archivedAt_idx" ON "InstagramAccount"("archivedAt");
