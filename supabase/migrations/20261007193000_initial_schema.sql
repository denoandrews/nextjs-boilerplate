create extension if not exists pgcrypto;

create type public.municipality_role as enum ('admin', 'editor', 'viewer');
create type public.source_type as enum ('municipal', 'county', 'state', 'official_guidance', 'news');
create type public.document_status as enum ('draft', 'processing', 'published', 'error', 'archived', 'superseded');
create type public.message_role as enum ('user', 'assistant');

create table public.municipalities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  state text not null,
  county text,
  active boolean not null default true,
  retention_days integer not null default 730 check (retention_days between 30 and 3650),
  vector_store_ids text[] not null default '{}',
  allowed_domains text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.municipality_memberships (
  municipality_id uuid not null references public.municipalities(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.municipality_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (municipality_id, user_id)
);

create table public.document_sources (
  id uuid primary key default gen_random_uuid(),
  municipality_id uuid not null references public.municipalities(id) on delete cascade,
  name text not null,
  source_type public.source_type not null,
  authority_rank smallint not null default 100 check (authority_rank between 1 and 1000),
  trusted boolean not null default true,
  base_url text,
  created_at timestamptz not null default now(),
  unique (municipality_id, name)
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  municipality_id uuid not null references public.municipalities(id) on delete cascade,
  source_id uuid references public.document_sources(id) on delete set null,
  supersedes_document_id uuid references public.documents(id) on delete set null,
  title text not null,
  document_type text not null,
  status public.document_status not null default 'draft',
  adopted_at date,
  effective_at date,
  meeting_at timestamptz,
  external_url text,
  storage_path text,
  openai_file_id text,
  vector_store_id text,
  metadata jsonb not null default '{}'::jsonb,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (municipality_id, storage_path)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  municipality_id uuid not null references public.municipalities(id) on delete cascade,
  anonymous_session_id text,
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role public.message_role not null,
  content text not null,
  request_id text,
  model text,
  created_at timestamptz not null default now()
);

create unique index messages_request_id_unique
  on public.messages(request_id)
  where request_id is not null;

create table public.citations (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  file_id text not null,
  filename text not null,
  ordinal smallint not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  rating smallint not null check (rating in (-1, 1)),
  comment text,
  created_at timestamptz not null default now()
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  municipality_id uuid not null references public.municipalities(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.usage_events (
  id bigint generated always as identity primary key,
  municipality_id uuid not null references public.municipalities(id) on delete cascade,
  request_id text,
  model text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now()
);

create index documents_municipality_status_idx on public.documents(municipality_id, status);
create index conversations_municipality_activity_idx on public.conversations(municipality_id, last_activity_at desc);
create index messages_conversation_created_idx on public.messages(conversation_id, created_at);
create index audit_events_municipality_created_idx on public.audit_events(municipality_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger municipalities_set_updated_at before update on public.municipalities
for each row execute function public.set_updated_at();
create trigger documents_set_updated_at before update on public.documents
for each row execute function public.set_updated_at();

create or replace function public.is_municipality_member(target_municipality_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.municipality_memberships
    where municipality_id = target_municipality_id and user_id = auth.uid()
  );
$$;

create or replace function public.has_municipality_role(target_municipality_id uuid, allowed_roles public.municipality_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.municipality_memberships
    where municipality_id = target_municipality_id
      and user_id = auth.uid()
      and role = any(allowed_roles)
  );
$$;

grant execute on function public.is_municipality_member(uuid) to authenticated;
grant execute on function public.has_municipality_role(uuid, public.municipality_role[]) to authenticated;

alter table public.municipalities enable row level security;
alter table public.municipality_memberships enable row level security;
alter table public.document_sources enable row level security;
alter table public.documents enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.citations enable row level security;
alter table public.feedback enable row level security;
alter table public.audit_events enable row level security;
alter table public.usage_events enable row level security;

create policy "members read municipality" on public.municipalities for select to authenticated
using (public.is_municipality_member(id));
create policy "admins update municipality" on public.municipalities for update to authenticated
using (public.has_municipality_role(id, array['admin']::public.municipality_role[]))
with check (public.has_municipality_role(id, array['admin']::public.municipality_role[]));

create policy "members read memberships" on public.municipality_memberships for select to authenticated
using (public.is_municipality_member(municipality_id));
create policy "admins manage memberships" on public.municipality_memberships for all to authenticated
using (public.has_municipality_role(municipality_id, array['admin']::public.municipality_role[]))
with check (public.has_municipality_role(municipality_id, array['admin']::public.municipality_role[]));

create policy "members read sources" on public.document_sources for select to authenticated
using (public.is_municipality_member(municipality_id));
create policy "editors manage sources" on public.document_sources for all to authenticated
using (public.has_municipality_role(municipality_id, array['admin','editor']::public.municipality_role[]))
with check (public.has_municipality_role(municipality_id, array['admin','editor']::public.municipality_role[]));

create policy "members read documents" on public.documents for select to authenticated
using (public.is_municipality_member(municipality_id));
create policy "editors create documents" on public.documents for insert to authenticated
with check (public.has_municipality_role(municipality_id, array['admin','editor']::public.municipality_role[]));
create policy "editors update documents" on public.documents for update to authenticated
using (public.has_municipality_role(municipality_id, array['admin','editor']::public.municipality_role[]))
with check (public.has_municipality_role(municipality_id, array['admin','editor']::public.municipality_role[]));
create policy "admins delete documents" on public.documents for delete to authenticated
using (public.has_municipality_role(municipality_id, array['admin']::public.municipality_role[]));

create policy "members read conversations" on public.conversations for select to authenticated
using (public.is_municipality_member(municipality_id));
create policy "members read messages" on public.messages for select to authenticated
using (exists (select 1 from public.conversations c where c.id = conversation_id and public.is_municipality_member(c.municipality_id)));
create policy "members read citations" on public.citations for select to authenticated
using (exists (
  select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
  where m.id = message_id and public.is_municipality_member(c.municipality_id)
));
create policy "members read feedback" on public.feedback for select to authenticated
using (exists (
  select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
  where m.id = message_id and public.is_municipality_member(c.municipality_id)
));
create policy "members read audit" on public.audit_events for select to authenticated
using (public.is_municipality_member(municipality_id));
create policy "members read usage" on public.usage_events for select to authenticated
using (public.is_municipality_member(municipality_id));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'municipal-documents',
  'municipal-documents',
  false,
  20971520,
  array['application/pdf','text/plain','text/markdown','text/html','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
on conflict (id) do nothing;

create policy "members read municipal files" on storage.objects for select to authenticated
using (
  bucket_id = 'municipal-documents'
  and public.is_municipality_member(((storage.foldername(name))[1])::uuid)
);
create policy "editors upload municipal files" on storage.objects for insert to authenticated
with check (
  bucket_id = 'municipal-documents'
  and public.has_municipality_role(((storage.foldername(name))[1])::uuid, array['admin','editor']::public.municipality_role[])
);
create policy "editors update municipal files" on storage.objects for update to authenticated
using (
  bucket_id = 'municipal-documents'
  and public.has_municipality_role(((storage.foldername(name))[1])::uuid, array['admin','editor']::public.municipality_role[])
);
create policy "admins delete municipal files" on storage.objects for delete to authenticated
using (
  bucket_id = 'municipal-documents'
  and public.has_municipality_role(((storage.foldername(name))[1])::uuid, array['admin']::public.municipality_role[])
);

comment on table public.conversations is 'Anonymous public chat sessions. Accessed by the service role for writes and municipality members for review.';
comment on table public.audit_events is 'Append-only application audit trail; application writes use the service role.';
