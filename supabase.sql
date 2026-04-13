create schema if not exists molip_english_blank;

create table if not exists molip_english_blank.scripts (
  id text primary key,
  owner_username text not null,
  title text not null,
  raw_text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_opened_at timestamptz not null default now()
);

create index if not exists scripts_owner_updated_idx
  on molip_english_blank.scripts (owner_username, updated_at desc);

create table if not exists molip_english_blank.quiz_sessions (
  id text primary key,
  owner_username text not null,
  script_id text not null references molip_english_blank.scripts(id) on delete cascade,
  created_at timestamptz not null default now(),
  total_questions integer not null,
  total_blanks integer not null,
  correct_blanks integer not null,
  wrong_sentences integer not null,
  blank_ratio integer not null
);

create index if not exists quiz_sessions_owner_created_idx
  on molip_english_blank.quiz_sessions (owner_username, created_at desc);

create table if not exists molip_english_blank.sentence_stats (
  owner_username text not null,
  script_id text not null references molip_english_blank.scripts(id) on delete cascade,
  sentence_key text not null,
  number text not null,
  meaning text not null,
  english text not null,
  study_reveal_count integer not null default 0,
  quiz_attempts integer not null default 0,
  wrong_count integer not null default 0,
  wrong_blank_count integer not null default 0,
  last_studied_at timestamptz,
  last_quiz_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner_username, script_id, sentence_key)
);

create index if not exists sentence_stats_owner_wrong_idx
  on molip_english_blank.sentence_stats (owner_username, wrong_count desc, wrong_blank_count desc);

alter table molip_english_blank.scripts disable row level security;
alter table molip_english_blank.quiz_sessions disable row level security;
alter table molip_english_blank.sentence_stats disable row level security;

grant usage on schema molip_english_blank to anon, authenticated;
grant all on table molip_english_blank.scripts to anon, authenticated;
grant all on table molip_english_blank.quiz_sessions to anon, authenticated;
grant all on table molip_english_blank.sentence_stats to anon, authenticated;
