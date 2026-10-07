alter table public.municipalities
  add column monthly_query_limit integer not null default 15000
    check (monthly_query_limit between 0 and 10000000),
  add column public_rate_limit_per_minute integer not null default 10
    check (public_rate_limit_per_minute between 1 and 10000);

alter table public.usage_events
  add column cached_input_tokens integer,
  add column total_tokens integer,
  add column file_search_calls integer not null default 0,
  add column estimated_cost_microusd bigint;

create unique index usage_events_request_id_unique
  on public.usage_events(request_id)
  where request_id is not null;

create table public.monthly_query_usage (
  municipality_id uuid not null references public.municipalities(id) on delete cascade,
  month_start date not null,
  query_count integer not null default 0 check (query_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (municipality_id, month_start)
);

create table public.public_rate_limit_windows (
  municipality_id uuid not null references public.municipalities(id) on delete cascade,
  key_hash text not null,
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (municipality_id, key_hash, window_start)
);

create index public_rate_limit_windows_cleanup_idx
  on public.public_rate_limit_windows(window_start);

alter table public.monthly_query_usage enable row level security;
alter table public.public_rate_limit_windows enable row level security;

create policy "members read monthly query usage" on public.monthly_query_usage
for select to authenticated
using (public.is_municipality_member(municipality_id));

grant select on public.monthly_query_usage to authenticated;
grant all privileges on public.monthly_query_usage to service_role;
grant all privileges on public.public_rate_limit_windows to service_role;

create or replace function public.reserve_chat_query(
  p_municipality_id uuid,
  p_key_hash text
)
returns table (
  allowed boolean,
  reason text,
  retry_after_seconds integer,
  monthly_count integer,
  monthly_limit integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month_start date := date_trunc('month', now() at time zone 'UTC')::date;
  v_window_start timestamptz := date_trunc('minute', now());
  v_monthly_limit integer;
  v_rate_limit integer;
  v_rate_count integer;
  v_month_count integer;
begin
  select m.monthly_query_limit, m.public_rate_limit_per_minute
    into v_monthly_limit, v_rate_limit
  from public.municipalities m
  where m.id = p_municipality_id and m.active = true;

  if not found then
    return query select false, 'unavailable'::text, 60, null::integer, null::integer;
    return;
  end if;

  if v_monthly_limit = 0 then
    return query select false, 'monthly_quota'::text, null::integer, 0, 0;
    return;
  end if;

  insert into public.public_rate_limit_windows (
    municipality_id, key_hash, window_start, request_count
  ) values (
    p_municipality_id, p_key_hash, v_window_start, 1
  )
  on conflict (municipality_id, key_hash, window_start)
  do update set
    request_count = public.public_rate_limit_windows.request_count + 1,
    updated_at = now()
  where public.public_rate_limit_windows.request_count < v_rate_limit
  returning request_count into v_rate_count;

  if v_rate_count is null then
    select u.query_count into v_month_count
    from public.monthly_query_usage u
    where u.municipality_id = p_municipality_id and u.month_start = v_month_start;

    return query select
      false,
      'rate_limit'::text,
      greatest(1, 60 - extract(second from now())::integer),
      coalesce(v_month_count, 0),
      v_monthly_limit;
    return;
  end if;

  insert into public.monthly_query_usage (
    municipality_id, month_start, query_count
  ) values (
    p_municipality_id, v_month_start, 1
  )
  on conflict (municipality_id, month_start)
  do update set
    query_count = public.monthly_query_usage.query_count + 1,
    updated_at = now()
  where public.monthly_query_usage.query_count < v_monthly_limit
  returning query_count into v_month_count;

  if v_month_count is null then
    select u.query_count into v_month_count
    from public.monthly_query_usage u
    where u.municipality_id = p_municipality_id and u.month_start = v_month_start;

    return query select false, 'monthly_quota'::text, null::integer,
      coalesce(v_month_count, v_monthly_limit), v_monthly_limit;
    return;
  end if;

  return query select true, 'allowed'::text, null::integer, v_month_count, v_monthly_limit;
end;
$$;

revoke all on function public.reserve_chat_query(uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_chat_query(uuid, text) to service_role;

create or replace function public.get_municipality_usage_summary(p_municipality_id uuid)
returns table (
  query_count integer,
  monthly_limit integer,
  input_tokens bigint,
  output_tokens bigint,
  file_search_calls bigint,
  estimated_cost_microusd bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month_start date := date_trunc('month', now() at time zone 'UTC')::date;
begin
  if not public.is_municipality_member(p_municipality_id) then
    return;
  end if;

  return query
  select
    coalesce(q.query_count, 0),
    m.monthly_query_limit,
    coalesce(sum(u.input_tokens), 0)::bigint,
    coalesce(sum(u.output_tokens), 0)::bigint,
    coalesce(sum(u.file_search_calls), 0)::bigint,
    coalesce(sum(u.estimated_cost_microusd), 0)::bigint
  from public.municipalities m
  left join public.monthly_query_usage q
    on q.municipality_id = m.id and q.month_start = v_month_start
  left join public.usage_events u
    on u.municipality_id = m.id and u.created_at >= v_month_start::timestamptz
  where m.id = p_municipality_id
  group by q.query_count, m.monthly_query_limit;
end;
$$;

revoke all on function public.get_municipality_usage_summary(uuid) from public, anon;
grant execute on function public.get_municipality_usage_summary(uuid) to authenticated, service_role;

comment on column public.municipalities.monthly_query_limit is
  'Hard monthly ceiling for public chat questions. A value of zero disables public chat.';
comment on column public.usage_events.estimated_cost_microusd is
  'Estimated OpenAI cost in millionths of a US dollar using application-configured rates.';
comment on table public.public_rate_limit_windows is
  'Hashed public-client counters. Raw IP addresses are never stored.';
