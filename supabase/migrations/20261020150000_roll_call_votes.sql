-- Roll-call votes. Paste this whole file into the Supabase SQL editor.
-- It is idempotent (safe to run more than once). REST cannot run this DDL.
-- The chat does not query these tables. There is no query_votes tool yet.
-- Authenticated staff can read rows for their municipality. Inserts and updates
-- are service-role only, which is how `npm run extract-votes -- --write` connects.

do $$ begin
  create type public.vote_choice as enum ('aye', 'nay', 'abstain', 'absent', 'recused');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.motion_result as enum ('passed', 'failed', 'tabled', 'withdrawn', 'no_vote', 'unknown');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.vote_members (
  id uuid primary key default gen_random_uuid(),
  municipality_id uuid not null references public.municipalities(id) on delete cascade,
  body text not null,
  canonical_name text not null,
  role text,
  aliases text[] not null default '{}',
  active_from date,
  active_to date,
  created_at timestamptz not null default now()
);

create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  municipality_id uuid not null references public.municipalities(id) on delete cascade,
  body text not null,
  meeting_date date not null,
  meeting_type text,
  minutes_status text not null default 'unknown'
    check (minutes_status in ('approved', 'draft', 'revised', 'unknown')),
  source_file_id text not null,
  source_filename text,
  record_date integer,
  external_url text,
  review_status text not null default 'ok'
    check (review_status in ('ok', 'needs_review')),
  review_note text,
  superseded_by uuid references public.meetings(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.motions (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  municipality_id uuid not null references public.municipalities(id) on delete cascade,
  item_key text not null,
  item_number text,
  title text not null,
  motion_text text,
  mover_raw text,
  seconder_raw text,
  mover_member_id uuid references public.vote_members(id) on delete set null,
  seconder_member_id uuid references public.vote_members(id) on delete set null,
  result public.motion_result not null default 'unknown',
  tally_aye integer,
  tally_nay integer,
  tally_abstain integer,
  tally_absent integer,
  tally_recused integer,
  tally_text text,
  source_file_id text not null,
  source_page integer,
  validation_status text not null default 'needs_review'
    check (validation_status in ('ok', 'tally_mismatch', 'needs_review', 'count_only')),
  validation_note text,
  created_at timestamptz not null default now()
);

create table if not exists public.member_votes (
  id uuid primary key default gen_random_uuid(),
  motion_id uuid not null references public.motions(id) on delete cascade,
  member_id uuid references public.vote_members(id) on delete set null,
  raw_name text not null,
  choice public.vote_choice not null,
  created_at timestamptz not null default now()
);

alter table public.meetings add column if not exists review_status text not null default 'ok';
alter table public.meetings add column if not exists review_note text;
alter table public.meetings add column if not exists source_filename text;
alter table public.meetings add column if not exists record_date integer;
alter table public.meetings add column if not exists external_url text;
alter table public.motions add column if not exists item_key text;
alter table public.motions add column if not exists validation_note text;
alter table public.motions add column if not exists source_page integer;

update public.motions set item_key = id::text where item_key is null;
alter table public.motions alter column item_key set not null;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.vote_members'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%municipality_id%'
      and pg_get_constraintdef(oid) ilike '%canonical_name%'
  ) then
    alter table public.vote_members
      add constraint vote_members_city_body_name_key unique (municipality_id, body, canonical_name);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.meetings'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%source_file_id%'
  ) then
    alter table public.meetings
      add constraint meetings_city_source_file_key unique (municipality_id, source_file_id);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.motions'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%item_key%'
  ) then
    alter table public.motions
      add constraint motions_meeting_item_key unique (meeting_id, item_key);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.member_votes'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%raw_name%'
  ) then
    alter table public.member_votes
      add constraint member_votes_motion_raw_name_key unique (motion_id, raw_name);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'meetings_review_status_check'
  ) then
    alter table public.meetings
      add constraint meetings_review_status_check
      check (review_status in ('ok', 'needs_review'));
  end if;
end $$;

-- Replace the validation check so a database that already ran an earlier paste accepts count_only.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'motions'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%validation_status%'
  loop
    execute format('alter table public.motions drop constraint %I', constraint_name);
  end loop;
  alter table public.motions
    add constraint motions_validation_status_check
    check (validation_status in ('ok', 'tally_mismatch', 'needs_review', 'count_only'));
end $$;

create index if not exists motions_city_validation_idx
  on public.motions (municipality_id, validation_status);
create index if not exists meetings_city_body_date_idx
  on public.meetings (municipality_id, body, meeting_date);
create index if not exists member_votes_motion_choice_idx
  on public.member_votes (motion_id, choice);

alter table public.vote_members enable row level security;
alter table public.meetings enable row level security;
alter table public.motions enable row level security;
alter table public.member_votes enable row level security;

drop policy if exists "members read vote members" on public.vote_members;
create policy "members read vote members" on public.vote_members
  for select to authenticated
  using (public.is_municipality_member(municipality_id));

drop policy if exists "members read meetings" on public.meetings;
create policy "members read meetings" on public.meetings
  for select to authenticated
  using (public.is_municipality_member(municipality_id));

drop policy if exists "members read motions" on public.motions;
create policy "members read motions" on public.motions
  for select to authenticated
  using (public.is_municipality_member(municipality_id));

drop policy if exists "members read member votes" on public.member_votes;
create policy "members read member votes" on public.member_votes
  for select to authenticated
  using (exists (
    select 1 from public.motions m
    where m.id = motion_id and public.is_municipality_member(m.municipality_id)
  ));

revoke all on table public.vote_members from anon, authenticated;
revoke all on table public.meetings from anon, authenticated;
revoke all on table public.motions from anon, authenticated;
revoke all on table public.member_votes from anon, authenticated;
grant select on table public.vote_members, public.meetings, public.motions, public.member_votes to authenticated;
grant all privileges on table public.vote_members, public.meetings, public.motions, public.member_votes to service_role;

comment on table public.vote_members is 'Canonical voting members and aliases. The extractor matches raw minute names here. Chat does not query this table yet.';
comment on table public.meetings is 'One row per minutes file. superseded_by points at the approved minutes when a draft loses. Chat does not query this table yet.';
comment on table public.motions is 'Motions extracted from minutes. validation_status other than ok stays out of the future chat tool. Chat does not query this table yet.';
comment on table public.member_votes is 'One choice per member per motion. Unknown names keep raw_name and a null member_id.';
