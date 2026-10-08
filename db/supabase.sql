-- SiteForge on Supabase: run once in the SQL editor, AFTER db/schema.sql.
-- Safe to run again. Before running, replace the two values in step 3.

-- 1. Keep the tables private.
-- Supabase publishes every table in "public" through its Data API, readable with the public
-- anon key. SiteForge reaches the database only through DATABASE_URL as the table owner, which
-- row level security does not restrict, so: RLS on, no policies, no rights for the API roles.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- 2. Private storage for the photos admins upload (the app reads and writes with the secret key).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 3. The job worker: every minute Supabase calls the app, which audits, collects info,
-- generates and deploys whatever is queued; once a day it runs renewals and the Google purge.
-- The address and the secret are kept in Supabase Vault, not in the job text.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
declare
  site_url text := 'https://REPLACE-WITH-YOUR-VERCEL-ADDRESS.vercel.app';  -- no slash at the end
  secret text := 'REPLACE-WITH-THE-SAME-CRON_SECRET-AS-ON-VERCEL';
  existing uuid;
begin
  if site_url like '%REPLACE-WITH%' or secret like '%REPLACE-WITH%' then
    raise exception 'Put your Vercel address and CRON_SECRET into step 3 first.';
  end if;
  select id into existing from vault.secrets where name = 'siteforge_url';
  if existing is null then perform vault.create_secret(site_url, 'siteforge_url');
  else perform vault.update_secret(existing, site_url); end if;
  select id into existing from vault.secrets where name = 'siteforge_cron_secret';
  if existing is null then perform vault.create_secret(secret, 'siteforge_cron_secret');
  else perform vault.update_secret(existing, secret); end if;
end $$;

create or replace function public.siteforge_call(path text) returns bigint
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'siteforge_url') || path,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'siteforge_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 65000
  );
$$;
revoke all on function public.siteforge_call(text) from public, anon, authenticated;

select cron.schedule('siteforge-work', '* * * * *', $$ select public.siteforge_call('/api/cron/work') $$);
select cron.schedule('siteforge-daily', '15 3 * * *', $$ select public.siteforge_call('/api/cron/daily') $$); -- 05:15 Kigali time

-- To check it runs:   select * from cron.job_run_details order by start_time desc limit 5;
--                     select status_code, content from net._http_response order by created desc limit 5;
-- To stop it:         select cron.unschedule('siteforge-work'); select cron.unschedule('siteforge-daily');
