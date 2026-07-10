-- WordDeck initial schema.
-- Run in the Supabase SQL editor (or `supabase db push`).
--
-- NOTE: every object is prefixed `wd_` because this project SHARES a Supabase
-- project with cowala. The prefix guarantees no collision with cowala's tables
-- or triggers. Auth users (auth.users) are shared — same login, separate data.
-- RLS is on for every table with USING + WITH CHECK so a forged user_id is rejected.

-- ---------- wd_profiles ----------
create table if not exists wd_profiles (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  timezone            text not null default 'UTC',
  daily_extract_count int  not null default 0,
  daily_extract_date  date,
  created_at          timestamptz not null default now()
);

-- auto-create a profile row when a user signs up (WordDeck-specific trigger name)
create or replace function wd_handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.wd_profiles (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created_worddeck on auth.users;
create trigger on_auth_user_created_worddeck
  after insert on auth.users
  for each row execute function wd_handle_new_user();

-- ---------- wd_decks ----------
create table if not exists wd_decks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  source_type text not null default 'text',   -- text | image | pdf | csv | camera
  created_at  timestamptz not null default now()
);
create index if not exists wd_decks_user_idx on wd_decks(user_id);

-- ---------- wd_cards ----------
create table if not exists wd_cards (
  id                uuid primary key default gen_random_uuid(),
  deck_id           uuid not null references wd_decks(id) on delete cascade,
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  english           text not null,
  chinese           text not null,
  pos               text,
  example           text,
  chinese_ai_filled boolean not null default false,  -- true when AI invented a missing translation
  created_at        timestamptz not null default now()
);
create index if not exists wd_cards_deck_idx on wd_cards(deck_id);
create index if not exists wd_cards_user_idx on wd_cards(user_id);
-- stop duplicate rows within a deck. Plain columns so PostgREST upsert can target
-- this index via on_conflict=deck_id,english,chinese. Client trims text first.
create unique index if not exists wd_cards_unique_pair
  on wd_cards(deck_id, english, chinese);

-- ---------- wd_review_state (one row per card, per its owner) ----------
create table if not exists wd_review_state (
  card_id       uuid primary key references wd_cards(id) on delete cascade,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ease          real not null default 2.5,
  interval_days int  not null default 0,
  reps          int  not null default 0,
  lapses        int  not null default 0,
  due_at        timestamptz not null default now(),
  last_reviewed timestamptz
);
create index if not exists wd_review_due_idx on wd_review_state(user_id, due_at);

-- ---------- wd_study_plans ----------
create table if not exists wd_study_plans (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  direction     text not null default 'en2zh',   -- en2zh | zh2en | mixed
  goal_type     text not null default 'per_day', -- per_day | by_date | none
  target_date   date,
  words_per_day int,
  created_at    timestamptz not null default now()
);

-- join table replaces deck_ids uuid[]
create table if not exists wd_plan_decks (
  plan_id uuid not null references wd_study_plans(id) on delete cascade,
  deck_id uuid not null references wd_decks(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  primary key (plan_id, deck_id)
);

-- ---------- quiz history ----------
create table if not exists wd_quiz_results (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  direction text not null,
  score     int not null,
  total     int not null,
  taken_at  timestamptz not null default now()
);
create table if not exists wd_quiz_attempts (
  id          uuid primary key default gen_random_uuid(),
  result_id   uuid not null references wd_quiz_results(id) on delete cascade,
  card_id     uuid references wd_cards(id) on delete set null,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  was_correct boolean not null,
  chosen      text
);

-- ================= RLS =================
alter table wd_profiles      enable row level security;
alter table wd_decks         enable row level security;
alter table wd_cards         enable row level security;
alter table wd_review_state  enable row level security;
alter table wd_study_plans   enable row level security;
alter table wd_plan_decks    enable row level security;
alter table wd_quiz_results  enable row level security;
alter table wd_quiz_attempts enable row level security;

create policy wd_own_profiles on wd_profiles
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy wd_own_decks on wd_decks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
-- cards: additionally require the parent deck to belong to the caller
create policy wd_own_cards on wd_cards
  for all using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from wd_decks d where d.id = deck_id and d.user_id = auth.uid())
  );
-- review_state: also require the referenced card to belong to the caller, so a
-- user can't insert a state row against someone else's card_id and poison it.
create policy wd_own_review on wd_review_state
  for all using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from wd_cards c where c.id = card_id and c.user_id = auth.uid())
  );
create policy wd_own_plans on wd_study_plans
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy wd_own_plan_decks on wd_plan_decks
  for all using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from wd_study_plans p where p.id = plan_id and p.user_id = auth.uid())
    and exists (select 1 from wd_decks d where d.id = deck_id and d.user_id = auth.uid())
  );
create policy wd_own_results on wd_quiz_results
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy wd_own_attempts on wd_quiz_attempts
  for all using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from wd_quiz_results r where r.id = result_id and r.user_id = auth.uid())
  );

-- ================= RPCs =================
-- Atomic spaced-repetition update. SECURITY INVOKER so RLS still applies.
-- Simplified SM-2: correct advances the interval, wrong resets it.
create or replace function wd_record_review(p_card_id uuid, p_was_correct boolean)
returns wd_review_state language plpgsql as $$
declare
  v_uid uuid := auth.uid();
  rs wd_review_state;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from wd_cards where id = p_card_id and user_id = v_uid) then
    raise exception 'card not found';
  end if;

  insert into wd_review_state (card_id, user_id)
  values (p_card_id, v_uid)
  on conflict (card_id) do nothing;

  select * into rs from wd_review_state where card_id = p_card_id for update;

  if p_was_correct then
    rs.reps := rs.reps + 1;
    if    rs.reps = 1 then rs.interval_days := 1;
    elsif rs.reps = 2 then rs.interval_days := 3;
    else  rs.interval_days := greatest(1, round(rs.interval_days * rs.ease)::int);
    end if;
    rs.ease := least(3.0, rs.ease + 0.1);
  else
    rs.reps := 0;
    rs.interval_days := 0;
    rs.lapses := rs.lapses + 1;
    rs.ease := greatest(1.3, rs.ease - 0.2);
  end if;
  rs.due_at := now() + make_interval(days => rs.interval_days);
  rs.last_reviewed := now();

  update wd_review_state set
    reps = rs.reps, interval_days = rs.interval_days, ease = rs.ease,
    lapses = rs.lapses, due_at = rs.due_at, last_reviewed = rs.last_reviewed
  where card_id = p_card_id
  returning * into rs;

  return rs;
end; $$;

-- Per-user daily quota for AI extract calls. Counts against the user's local day.
-- Raises 'quota exceeded' when over p_limit; returns remaining otherwise.
create or replace function wd_consume_extract_quota(p_limit int)
returns int language plpgsql as $$
declare
  v_uid uuid := auth.uid();
  v_tz  text;
  v_day date;
  v_count int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  insert into wd_profiles (user_id) values (v_uid) on conflict (user_id) do nothing;
  select timezone into v_tz from wd_profiles where user_id = v_uid;
  v_day := (now() at time zone coalesce(v_tz, 'UTC'))::date;

  update wd_profiles set
    daily_extract_count = case when daily_extract_date = v_day then daily_extract_count + 1 else 1 end,
    daily_extract_date  = v_day
  where user_id = v_uid
  returning daily_extract_count into v_count;

  if v_count > p_limit then
    raise exception 'quota exceeded' using errcode = 'P0001';
  end if;
  return greatest(0, p_limit - v_count);
end; $$;
