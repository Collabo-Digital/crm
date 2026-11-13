-- The setup wizard opens for workspaces whose onboarding_status is IN_PROGRESS.
-- Until now nothing wrote that column, so every workspace is PENDING. They were
-- all set up the old way: mark them done so the wizard never opens for them.
-- New workspaces are created as IN_PROGRESS by the application.
UPDATE "organizations"
   SET "onboarding_status" = 'COMPLETED'
 WHERE "onboarding_status" = 'PENDING';
