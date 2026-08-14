-- Bundle segments: the physical harness layer.
--
-- An edge is a wire. A segment is the path a group of wires physically travels
-- along — the trunk and every branch off it. Sleeving, conduit and tape belong
-- to a segment, never to a wire, because that is how they are fitted.

create table public.loom_segments (
  id            uuid primary key default gen_random_uuid(),
  loom_id       uuid not null references public.looms (id) on delete cascade,
  segment_key   text not null,
  from_node_key text not null,
  to_node_key   text not null,
  length_mm     numeric not null check (length_mm > 0),
  -- Board polyline in mm between the two ends. Straight run if null.
  routing       jsonb,
  sleeving_id   text,
  -- Tape wrap / tie positions as fractions 0..1 along the segment.
  ties          jsonb,
  label         text,
  notes         text,
  created_at    timestamptz not null default now(),
  unique (loom_id, segment_key),
  -- Same composite-key guard as edges: a segment cannot span two looms.
  foreign key (loom_id, from_node_key) references public.loom_nodes (loom_id, node_key) on delete cascade,
  foreign key (loom_id, to_node_key)   references public.loom_nodes (loom_id, node_key) on delete cascade
);

create index loom_segments_loom_idx on public.loom_segments (loom_id);

alter table public.loom_segments enable row level security;

create policy loom_segments_all on public.loom_segments
  for all using (public.owns_loom(loom_id)) with check (public.owns_loom(loom_id));

-- How each wire travels through the bundle.
alter table public.loom_edges
  -- Ordered segment keys. Null means "work it out from the segment graph",
  -- which is the normal case; setting it forces a wire down a specific path.
  add column segment_keys jsonb,
  -- Take the cut length from the routed path plus tails instead of the
  -- authored length. This is what makes a trunk useful: move the trunk and
  -- every wire inside it re-lengths.
  add column length_from_routing boolean,
  add column tail_from_mm numeric check (tail_from_mm >= 0),
  add column tail_to_mm numeric check (tail_to_mm >= 0);
