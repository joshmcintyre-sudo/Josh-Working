-- Loom designer schema.
--
-- Four tables, matching the shape of the design: a loom owns nodes and edges,
-- and a released revision freezes the calculated wire schedule.
--
-- Every table is owner-scoped with RLS on and no policy that lets one account
-- see another's work.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- looms ----

create table public.looms (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  name          text not null check (length(trim(name)) > 0),
  description   text,
  revision      text not null default 'A',
  -- LoomSettings: system voltage, ampacity basis, default family, ambient,
  -- minimum hand-crimp size, service loop allowance.
  settings      jsonb not null,
  -- { width_mm, height_mm } of the physical formboard, or null.
  formboard     jsonb,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index looms_owner_idx on public.looms (owner_id, updated_at desc);

-- ---------------------------------------------------------------- nodes ----

create table public.loom_nodes (
  id                  uuid primary key default gen_random_uuid(),
  loom_id             uuid not null references public.looms (id) on delete cascade,
  -- Stable identifier used by the graph and by every edge reference. Kept
  -- separate from the surrogate key so a loom can be duplicated or exported
  -- without rewriting every edge.
  node_key            text not null,
  kind                text not null check (kind in ('source', 'load', 'splice', 'ground', 'connector', 'termination')),
  name                text not null,
  location            text not null default '',
  position            jsonb not null,
  formboard_position  jsonb,
  load                jsonb,
  source              jsonb,
  ground              jsonb,
  connector           jsonb,
  splice              jsonb,
  protection          jsonb,
  notes               text,
  created_at          timestamptz not null default now(),
  unique (loom_id, node_key)
);

create index loom_nodes_loom_idx on public.loom_nodes (loom_id);

-- ---------------------------------------------------------------- edges ----

create table public.loom_edges (
  id                  uuid primary key default gen_random_uuid(),
  loom_id             uuid not null references public.looms (id) on delete cascade,
  edge_key            text not null,
  from_node_key       text not null,
  to_node_key         text not null,
  circuit_id          text not null,
  label               text,
  length_mm           numeric not null check (length_mm > 0),
  class               text not null check (class in ('power', 'signal', 'charging', 'ground', 'starter')),
  return_path         text not null check (return_path in ('chassis', 'modeled', 'implied_return')),
  insulation_id       text,
  gauge_override_id   text,
  family              text check (family in ('awg', 'metric')),
  current_override_a  numeric check (current_override_a >= 0),
  color_override      text,
  bundle_count        integer check (bundle_count > 0),
  ambient_c           numeric,
  routing             jsonb,
  protection          jsonb,
  notes               text,
  created_at          timestamptz not null default now(),
  unique (loom_id, edge_key),
  -- An edge must join two nodes of the same loom. The composite FK enforces it
  -- in the database rather than trusting the client.
  foreign key (loom_id, from_node_key) references public.loom_nodes (loom_id, node_key) on delete cascade,
  foreign key (loom_id, to_node_key)   references public.loom_nodes (loom_id, node_key) on delete cascade
);

create index loom_edges_loom_idx on public.loom_edges (loom_id);

-- ---------------------------------------------------------------- wires ----

-- The calculated wire schedule, frozen at release.
--
-- This is derived data and would normally not be stored. It is stored on
-- purpose: once a loom has been handed to the floor or to an overseas
-- manufacturer, its cut list must not silently change because a reference data
-- file was revised. A row here is the schedule as it was when that revision
-- was released, including which constraint drove each size.
create table public.loom_wires (
  id                    uuid primary key default gen_random_uuid(),
  loom_id               uuid not null references public.looms (id) on delete cascade,
  revision              text not null,
  edge_key              text not null,
  circuit_id            text not null,
  current_a             numeric not null,
  length_mm             numeric not null,
  wire_size_id          text not null,
  wire_label            text not null,
  area_mm2              numeric not null,
  insulation_id         text,
  color                 text,
  voltage_drop_v        numeric not null,
  voltage_drop_pct      numeric not null,
  drop_limit_pct        numeric not null,
  derated_ampacity_a    numeric not null,
  limiting_constraint   text not null,
  ampacity_basis        text not null,
  fuse_family_id        text,
  fuse_rating_a         numeric,
  rationale             text not null,
  -- Provenance for the drawing: the reference data revisions this was computed
  -- against, so a released schedule can always be traced back.
  data_revisions        jsonb not null,
  released_at           timestamptz not null default now(),
  unique (loom_id, revision, edge_key)
);

create index loom_wires_loom_rev_idx on public.loom_wires (loom_id, revision);

-- ---------------------------------------------------------- accessories ----

-- The accessory catalogue, per account, so ratings can be edited to match what
-- the shop actually fits. Seeded from data/accessories.json on first use.
create table public.accessories (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users (id) on delete cascade,
  catalog_key       text not null,
  name              text not null check (length(trim(name)) > 0),
  brand             text not null default '',
  example_model     text not null default '',
  category          text not null default 'Other',
  load_class        text not null check (load_class in ('signal', 'lighting', 'power', 'traction')),
  run_current_a     numeric not null check (run_current_a >= 0),
  inrush_a          numeric check (inrush_a >= 0),
  inrush_ms         numeric check (inrush_ms >= 0),
  fuse_a            numeric check (fuse_a > 0),
  fuse_type         text,
  connector         text,
  ways              integer not null default 2 check (ways > 0),
  ground            text not null default 'return-in-loom',
  cable_start_mm2   numeric check (cable_start_mm2 > 0),
  drive_via         text,
  ref               text not null default '',
  notes             text,
  -- False once the row has been edited away from the shipped catalogue value,
  -- so the UI can show what has been customised and offer a reset.
  is_stock          boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (owner_id, catalog_key)
);

create index accessories_owner_idx on public.accessories (owner_id, category, name);

-- ------------------------------------------------------------ updated_at ----

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger looms_touch before update on public.looms
  for each row execute function public.touch_updated_at();

create trigger accessories_touch before update on public.accessories
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------ RLS ----

alter table public.looms       enable row level security;
alter table public.loom_nodes  enable row level security;
alter table public.loom_edges  enable row level security;
alter table public.loom_wires  enable row level security;
alter table public.accessories enable row level security;

-- Looms and accessories are owned directly.

create policy looms_select on public.looms
  for select using (owner_id = (select auth.uid()));
create policy looms_insert on public.looms
  for insert with check (owner_id = (select auth.uid()));
create policy looms_update on public.looms
  for update using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy looms_delete on public.looms
  for delete using (owner_id = (select auth.uid()));

create policy accessories_select on public.accessories
  for select using (owner_id = (select auth.uid()));
create policy accessories_insert on public.accessories
  for insert with check (owner_id = (select auth.uid()));
create policy accessories_update on public.accessories
  for update using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy accessories_delete on public.accessories
  for delete using (owner_id = (select auth.uid()));

-- Children inherit ownership through their loom. Written as one helper so the
-- three child tables cannot drift apart.

create or replace function public.owns_loom(target uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.looms l
    where l.id = target and l.owner_id = (select auth.uid())
  );
$$;

revoke all on function public.owns_loom(uuid) from public;
grant execute on function public.owns_loom(uuid) to authenticated;

create policy loom_nodes_all on public.loom_nodes
  for all using (public.owns_loom(loom_id)) with check (public.owns_loom(loom_id));

create policy loom_edges_all on public.loom_edges
  for all using (public.owns_loom(loom_id)) with check (public.owns_loom(loom_id));

create policy loom_wires_all on public.loom_wires
  for all using (public.owns_loom(loom_id)) with check (public.owns_loom(loom_id));
