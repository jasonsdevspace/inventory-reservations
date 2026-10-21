-- A separate database for the test suite.
--
-- The suite truncates and reseeds constantly, so sharing a database with the
-- running service means `npm run verify` silently rewrites whatever the demo
-- was showing. Developers then see quantities nobody set, and tests that pass
-- against a database somebody has been poking at prove less than they appear
-- to.
--
-- Runs once, when the Postgres volume is first initialised.
create database reservations_test;
