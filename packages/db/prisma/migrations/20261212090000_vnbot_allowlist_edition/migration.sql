-- Additive: the previous release never reads this column, and every existing address keeps the full product.
ALTER TABLE "auth_email_allowlist" ADD COLUMN "edition" TEXT NOT NULL DEFAULT 'team';
ALTER TABLE "auth_email_allowlist" ADD CONSTRAINT "auth_email_allowlist_edition" CHECK ("edition" IN ('team', 'free'));
