-- New personal spaces are created as "Cá nhân" (bootstrap-user.ts). Rename existing ones that
-- still carry the old English default; spaces the user renamed are left alone.
UPDATE "spaces" SET "name" = 'Cá nhân' WHERE "name" = 'Personal' AND "isDefault" = true;
UPDATE "organization" SET "name" = 'Cá nhân' WHERE "name" = 'Personal';
