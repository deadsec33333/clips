-- Clips database (Supabase project "stillwire", all tables prefixed clips_).
-- Already applied. Kept here as a record, and to set up a fresh Supabase project if you ever move:
-- open the SQL editor in the new project and run this whole file once.

create table if not exists public.clips_campaigns (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
  name text not null check (char_length(name) between 1 and 40),
  ticker text check (ticker is null or ticker ~ '^[A-Z0-9]{1,10}$'),
  tagline text check (tagline is null or char_length(tagline) <= 160),
  image_url text, sky text, featured boolean not null default false,
  partner jsonb, details jsonb, badges jsonb,
  creator_instagram text, creator_wallet text, video_url text,
  x_url text, telegram_url text, website_url text,
  token_mint text unique, pool_address text unique,
  status text not null default 'pending' check (status in ('pending','live','paused','rejected')),
  fee_pool_usd_override numeric,
  fees_claimed numeric not null default 0, fees_allocated numeric not null default 0, fees_unclaimed numeric not null default 0,
  token_decimals int, price_usd numeric, snapshot_at timestamptz,
  axiom_url text, gmgn_url text,
  created_at timestamptz not null default now(), launched_at timestamptz
);

create table if not exists public.clips_clippers (
  id uuid primary key default gen_random_uuid(),
  instagram text not null unique check (instagram ~ '^[a-z0-9._]{1,30}$'),
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  code text not null unique check (code ~ '^[a-z0-9]{6,12}$'),
  verified boolean not null default false, verified_at timestamptz,
  last_bio_check timestamptz, bio_ok boolean,
  created_at timestamptz not null default now()
);

create table if not exists public.clips_memberships (
  campaign_id text not null references public.clips_campaigns(id) on delete cascade,
  clipper_id uuid not null references public.clips_clippers(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (campaign_id, clipper_id)
);

create table if not exists public.clips_clips (
  id uuid primary key default gen_random_uuid(),
  campaign_id text not null references public.clips_campaigns(id) on delete cascade,
  clipper_id uuid not null references public.clips_clippers(id) on delete cascade,
  shortcode text not null unique, url text not null,
  views bigint not null default 0 check (views >= 0),
  status text not null default 'pending' check (status in ('pending','ok','rejected')),
  reject_reason text, last_checked timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists clips_clips_campaign_idx on public.clips_clips(campaign_id, status);
create index if not exists clips_clips_clipper_idx on public.clips_clips(clipper_id);

create table if not exists public.clips_fee_claims (
  id uuid primary key default gen_random_uuid(),
  campaign_id text not null references public.clips_campaigns(id) on delete cascade,
  amount numeric not null check (amount >= 0), signature text unique,
  created_at timestamptz not null default now()
);

create table if not exists public.clips_payouts (
  id uuid primary key default gen_random_uuid(),
  campaign_id text not null references public.clips_campaigns(id) on delete cascade,
  clipper_id uuid not null references public.clips_clippers(id) on delete cascade,
  amount numeric not null check (amount >= 0),
  views_at_allocation bigint not null default 0, share numeric not null default 0,
  status text not null default 'owed' check (status in ('owed','sending','sent','failed')),
  signature text, last_valid_block_height bigint, error text,
  created_at timestamptz not null default now(), sent_at timestamptz
);
create index if not exists clips_payouts_status_idx on public.clips_payouts(status, clipper_id);

create table if not exists public.clips_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null, dry_run boolean not null default true, ok boolean, summary jsonb,
  started_at timestamptz not null default now(), finished_at timestamptz
);
create unique index if not exists clips_runs_one_open on public.clips_runs(kind) where finished_at is null;

create or replace view public.clips_leaderboard with (security_invoker = true) as
select m.campaign_id, c.id as clipper_id, c.instagram, c.verified,
  coalesce((select sum(k.views) from public.clips_clips k where k.campaign_id = m.campaign_id and k.clipper_id = c.id and k.status = 'ok'), 0)::bigint as views,
  coalesce((select sum(p.amount) from public.clips_payouts p where p.campaign_id = m.campaign_id and p.clipper_id = c.id), 0) as earned_tokens,
  coalesce((select sum(p.amount) from public.clips_payouts p where p.campaign_id = m.campaign_id and p.clipper_id = c.id and p.status = 'sent'), 0) as paid_tokens
from public.clips_memberships m join public.clips_clippers c on c.id = m.clipper_id;

create or replace function public.clips_allocate(p_campaign text, p_expected numeric, p_new numeric, p_rows jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update clips_campaigns set fees_allocated = p_new where id = p_campaign and fees_allocated = p_expected;
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  insert into clips_payouts (campaign_id, clipper_id, amount, views_at_allocation, share, status)
  select p_campaign, (r->>'clipper_id')::uuid, (r->>'amount')::numeric, (r->>'views')::bigint, (r->>'share')::numeric, 'owed'
  from jsonb_array_elements(p_rows) r;
  return true;
end $$;
revoke all on function public.clips_allocate(text, numeric, numeric, jsonb) from public, anon, authenticated;
grant execute on function public.clips_allocate(text, numeric, numeric, jsonb) to service_role;

-- Row level security on, no policies: only the server (service role) can read or write.
alter table public.clips_campaigns enable row level security;
alter table public.clips_clippers enable row level security;
alter table public.clips_memberships enable row level security;
alter table public.clips_clips enable row level security;
alter table public.clips_fee_claims enable row level security;
alter table public.clips_payouts enable row level security;
alter table public.clips_runs enable row level security;
revoke all on public.clips_leaderboard from anon, authenticated;
