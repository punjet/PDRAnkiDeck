-- Anonymous learning telemetry for the PDR web app.
-- Run in Supabase: Dashboard -> SQL Editor -> paste -> Run. Safe to re-run after
-- updates: it only adds what is missing and keeps the data.
--
-- The browser holds the public (anon / publishable) key, so anyone can call the
-- API with it. That key can only call ingest() below, which appends rows: nobody
-- can read, change or delete anything through the API. Read the data in the dashboard (SQL
-- editor / table editor) or with the service key, which never leaves your machine.
-- CHECK constraints keep junk out: ranges, lengths, known enum values.
-- Every row carries a browser-made event id (eid); ingest() skips ids it has
-- already stored, so a batch re-sent after a lost reply is not counted twice.
--
-- No IP address, user agent or location is stored. `uid` is a random UUID made
-- by the browser and not linked to anything else.

create table if not exists public.answers (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  eid           uuid not null unique,              -- event id from the browser: retries are deduplicated
  uid           uuid not null,                 -- random per browser
  sid           uuid not null,                 -- random per app launch
  qid           text not null check (length(qid) between 1 and 16),
  mode          text not null check (mode in ('study', 'exam', 'drill', 'topic')),   -- topic: practice of a topic or search results
  chosen        smallint not null check (chosen between 0 and 9),
  correct       boolean not null,
  n_options     smallint not null check (n_options between 2 and 10),
  rt_ms         integer check (rt_ms between 0 and 3600000),   -- time to answer
  rating        smallint check (rating between 1 and 4),       -- FSRS grade, study only
  state         smallint check (state between 0 and 3),        -- FSRS state before the answer
  stability     real check (stability >= 0 and stability <= 100000),
  difficulty    real check (difficulty >= 0 and difficulty <= 11),
  reps          integer check (reps between 0 and 100000),
  lapses        integer check (lapses between 0 and 100000),
  elapsed_days  real check (elapsed_days >= 0 and elapsed_days <= 100000),  -- since last review
  day_n         integer not null check (day_n between 0 and 10000),        -- day of preparation
  local_hour    smallint not null check (local_hour between 0 and 23),
  preset        text check (length(preset) <= 16),
  new_per_day   integer check (new_per_day between 0 and 5000),
  retention     real check (retention > 0 and retention < 1),
  device        text check (device in ('phone', 'tablet', 'desktop')),
  standalone    boolean,                       -- installed to home screen
  app_ver       text check (length(app_ver) <= 32)
);

create table if not exists public.exams (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  eid           uuid not null unique,              -- event id from the browser: retries are deduplicated
  uid           uuid not null,
  sid           uuid not null,
  errors        smallint not null check (errors between 0 and 20),
  total         smallint not null check (total between 1 and 20),
  passed        boolean not null,
  timeout       boolean not null,
  duration_s    integer check (duration_s between 0 and 7200),
  wrong_qids    text[] check (cardinality(wrong_qids) <= 20),
  day_n         integer not null check (day_n between 0 and 10000),
  local_hour    smallint not null check (local_hour between 0 and 23),
  known         integer check (known between 0 and 5000),     -- cards in review state
  started       integer check (started between 0 and 5000),   -- cards ever studied
  device        text check (device in ('phone', 'tablet', 'desktop')),
  app_ver       text check (length(app_ver) <= 32)
);

-- Self-reported result of the real exam: the target variable for the analysis.
create table if not exists public.outcomes (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  eid           uuid not null unique,              -- event id from the browser: retries are deduplicated
  uid           uuid not null,
  result        text not null check (result in ('passed_first', 'passed_retry', 'failed', 'not_yet')),
  day_n         integer not null check (day_n between 0 and 10000),
  known         integer check (known between 0 and 5000),
  started       integer check (started between 0 and 5000),
  reviews       integer check (reviews between 0 and 1000000),
  mock_exams    integer check (mock_exams between 0 and 10000),
  app_ver       text check (length(app_ver) <= 32)
);

-- v1.2: mock exams left midway (the "Вийти" button).
alter table public.exams add column if not exists abandoned boolean not null default false;
alter table public.exams add column if not exists answered  smallint check (answered between 0 and 20);
alter table public.exams add column if not exists quit_at   smallint check (quit_at between 1 and 20);   -- question number on screen
alter table public.exams add column if not exists quit_qid  text check (length(quit_qid) <= 16);

-- v1.2: sessions. A row when the app opens (seq 0), then one per minute of
-- visible time and one when the page is hidden. Session length = max(active_s)
-- per sid; the last row of a sid shows the screen and question the person left on.
create table if not exists public.pings (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  eid           uuid not null unique,
  uid           uuid not null,
  sid           uuid not null,
  seq           integer not null check (seq between 0 and 100000),
  kind          text not null check (kind in ('start', 'beat', 'hide')),
  active_s      integer not null check (active_s between 0 and 86400),   -- visible time in this session
  answers       integer not null check (answers between 0 and 100000),   -- answers in this session
  screen        text check (screen in ('home', 'study', 'exam', 'result', 'drill', 'settings', 'search', 'topic', 'practice')),
  qid           text check (length(qid) <= 16),                          -- question on screen, if any
  first_visit   boolean,                                                 -- first session of this uid
  src           text check (src ~ '^[a-z0-9_.-]{1,40}$'),                -- ?src= / utm tag of this visit
  first_src     text check (first_src ~ '^[a-z0-9_.-]{1,40}$'),          -- tag of the very first visit
  ref           text check (length(ref) <= 64),                          -- referrer domain only
  day_n         integer not null check (day_n between 0 and 10000),
  local_hour    smallint not null check (local_hour between 0 and 23),
  device        text check (device in ('phone', 'tablet', 'desktop')),
  standalone    boolean,
  app_ver       text check (length(app_ver) <= 32)
);

-- v1.4: options shown in a shuffled order (as in the HSC exam), and right answers graded
-- "Добре" by the auto-advance timer instead of a tap. `chosen` stays the option's index in the base.
alter table public.answers add column if not exists shuffled   boolean;
alter table public.answers add column if not exists auto_rated boolean;
-- grade.js: the grade the algorithm would give (2 Важко, 3 Добре, 4 Легко) and its score,
-- logged also when the person grades by hand, to see how often they agree.
alter table public.answers add column if not exists auto_guess smallint check (auto_guess between 2 and 4);
alter table public.answers add column if not exists auto_z     real     check (auto_z between -20 and 20);

-- v1.3: motivation features. Streak, pass chance and days to the exam on the session start ping.
alter table public.pings add column if not exists streak    integer  check (streak between 0 and 10000);
alter table public.pings add column if not exists ready_pct smallint check (ready_pct between 0 and 100);
alter table public.pings add column if not exists exam_in   integer  check (exam_in between -1000 and 1000);  -- days to the exam date set by the person

-- v1.3: taps on motivation features, to see which ones bring people back.
create table if not exists public.events (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  eid           uuid not null unique,
  uid           uuid not null,
  sid           uuid not null,
  kind          text not null check (kind in ('share', 'install_shown', 'install_click', 'install_done',
                  'install_later', 'ics', 'bonus', 'goal_done', 'exam_date', 'twin_open', 'search')),
  detail        text check (detail ~ '^[a-z0-9_.-]{1,40}$'),   -- share: where; ics: HHMM; install_shown: prompt/ios; twin_open: id of the look-alike question; search: found/none (never the text typed)
  n             integer check (n between -1000 and 100000),   -- share: 1 sheet / 0 copied; ics: days; bonus: extra cards today; goal_done: answers; exam_date: days left
  streak        integer check (streak between 0 and 10000),
  day_n         integer not null check (day_n between 0 and 10000),
  local_hour    smallint not null check (local_hour between 0 and 23),
  device        text check (device in ('phone', 'tablet', 'desktop')),
  standalone    boolean,
  app_ver       text check (length(app_ver) <= 32)
);

-- No direct table access for the public key at all: RLS on, no policies, no grants.
alter table public.answers  enable row level security;
alter table public.exams    enable row level security;
alter table public.outcomes enable row level security;
alter table public.pings    enable row level security;
alter table public.events   enable row level security;
revoke all on public.answers, public.exams, public.outcomes, public.pings, public.events from anon, authenticated;

-- The only entry point: POST /rest/v1/rpc/ingest {"t": "answers", "rows": [...]}.
-- Runs as the owner, accepts only these five tables and at most 200 rows per
-- call; CHECK constraints still apply, and a re-sent row (same eid) is skipped.
create or replace function public.ingest(t text, rows jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows) > 200 then
    raise exception 'rows must be an array of at most 200 items';
  end if;
  if t = 'answers' then
    insert into public.answers (eid, uid, sid, qid, mode, chosen, correct, n_options, rt_ms, rating, state, stability, difficulty, reps, lapses, elapsed_days, day_n, local_hour, preset, new_per_day, retention, device, standalone, app_ver, shuffled, auto_rated, auto_guess, auto_z)
    select eid, uid, sid, qid, mode, chosen, correct, n_options, rt_ms, rating, state, stability, difficulty, reps, lapses, elapsed_days, day_n, local_hour, preset, new_per_day, retention, device, standalone, app_ver, shuffled, auto_rated, auto_guess, auto_z
    from jsonb_populate_recordset(null::public.answers, rows)
    on conflict (eid) do nothing;
  elsif t = 'exams' then
    insert into public.exams (eid, uid, sid, errors, total, passed, timeout, duration_s, wrong_qids, day_n, local_hour, known, started, device, app_ver, abandoned, answered, quit_at, quit_qid)
    select eid, uid, sid, errors, total, passed, timeout, duration_s, wrong_qids, day_n, local_hour, known, started, device, app_ver, abandoned, answered, quit_at, quit_qid
    from jsonb_populate_recordset(null::public.exams, rows)
    on conflict (eid) do nothing;
  elsif t = 'outcomes' then
    insert into public.outcomes (eid, uid, result, day_n, known, started, reviews, mock_exams, app_ver)
    select eid, uid, result, day_n, known, started, reviews, mock_exams, app_ver
    from jsonb_populate_recordset(null::public.outcomes, rows)
    on conflict (eid) do nothing;
  elsif t = 'pings' then
    insert into public.pings (eid, uid, sid, seq, kind, active_s, answers, screen, qid, first_visit, src, first_src, ref, day_n, local_hour, device, standalone, app_ver, streak, ready_pct, exam_in)
    select eid, uid, sid, seq, kind, active_s, answers, screen, qid, first_visit, src, first_src, ref, day_n, local_hour, device, standalone, app_ver, streak, ready_pct, exam_in
    from jsonb_populate_recordset(null::public.pings, rows)
    on conflict (eid) do nothing;
  elsif t = 'events' then
    insert into public.events (eid, uid, sid, kind, detail, n, streak, day_n, local_hour, device, standalone, app_ver)
    select eid, uid, sid, kind, detail, n, streak, day_n, local_hour, device, standalone, app_ver
    from jsonb_populate_recordset(null::public.events, rows)
    on conflict (eid) do nothing;
  else
    raise exception 'unknown table %', t;
  end if;
end;
$$;

revoke all on function public.ingest(text, jsonb) from public;
grant execute on function public.ingest(text, jsonb) to anon;

create index if not exists answers_qid_idx on public.answers (qid);
create index if not exists answers_uid_idx on public.answers (uid, created_at);
create index if not exists exams_uid_idx   on public.exams (uid, created_at);
create index if not exists pings_sid_idx   on public.pings (sid, seq);
create index if not exists pings_uid_idx   on public.pings (uid, created_at);
create index if not exists events_uid_idx  on public.events (uid, created_at);
