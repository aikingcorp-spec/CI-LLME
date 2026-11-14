-- New accounts wear the VNBot mascot set. Existing rows keep the set they already stored.
ALTER TABLE "user" ALTER COLUMN "botAvatarSet" SET DEFAULT 'vnbot';
