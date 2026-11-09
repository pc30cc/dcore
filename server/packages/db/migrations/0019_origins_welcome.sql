-- 0019 — app_config keys of the signed origins document and of the welcome.
--
-- origins.hosts: the hosts the apps are sent to (GET /v1/origins and the
-- copies the worker publishes), per role (api, realtime, rtc, cdn, web, in
-- order of preference), the URLs of the published copies (bootstrap) and
-- whether IP literals are allowed, with the document's version. null until
-- the panel saves hosts: the document then carries the deployment's own
-- (environment and brand.json) at version 1. Every save raises the version;
-- it never goes back, since apps refuse a document older than the one they
-- hold.
--
-- brand.welcome: the panel's overrides of brand.json's welcome block (texts
-- per locale, the three gradient colours, picture URLs). Empty: brand.json's
-- own.
INSERT INTO app_config (key, value) VALUES
  ('origins.hosts', 'null'),
  ('brand.welcome', '{}')
ON CONFLICT (key) DO NOTHING;
