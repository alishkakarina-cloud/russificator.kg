-- Вставить в Supabase Dashboard -> SQL Editor -> New query -> Run
-- (если ранее уже создавали таблицу login_requests из прошлой версии — этот
-- скрипт её не трогает, можно просто выполнить как есть; login_requests
-- в проекте больше не используется, её можно удалить командой
-- `drop table if exists public.login_requests;`, если она была создана)

create table if not exists public.telegram_login_tokens (
  token text primary key,
  telegram_user jsonb,
  confirmed_at timestamptz,
  status text not null default 'pending_telegram',
  decided_at timestamptz,
  decided_by bigint,
  created_at timestamptz not null default now()
);

alter table public.telegram_login_tokens enable row level security;

-- Приложение (anon-ключ) только читает статус своего токена для поллинга.
-- Создаёт токен и меняет статус только Edge Function через service_role
-- (он не проверяется RLS) — anon не может ни завести токен сам, ни
-- одобрить себе вход.
create policy "anon can read token status"
  on public.telegram_login_tokens for select
  to anon
  using (true);

-- Кик через бота (/kick, /unkick — см. telegram-webhook). Приложение читает
-- эту таблицу при запуске и при продлении локальной сессии, чтобы кик
-- срабатывал даже внутри 30-минутного окна доверия устройству.
create table if not exists public.blocked_telegram_users (
  telegram_id bigint primary key,
  blocked_at timestamptz not null default now(),
  blocked_by bigint
);

alter table public.blocked_telegram_users enable row level security;

create policy "anon can read blocklist"
  on public.blocked_telegram_users for select
  to anon
  using (true);

-- Все, кто хоть раз проходил через /start бота — заполняется вебхуком при
-- каждом входе (upsert). trusted — доверенные пользователи (см. ниже).
-- Никаких anon-политик: имена и telegram id читает/пишет только
-- Edge Function admin-action (через service_role, с проверкой, что
-- запрашивает реально админ) — не выставляем историю входов напрямую
-- через анонимный ключ.
create table if not exists public.telegram_users (
  telegram_id bigint primary key,
  username text,
  first_name text,
  last_name text,
  trusted boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table public.telegram_users enable row level security;

-- Каталог марок/моделей с ценами — публичные данные, показываются в
-- выпадающем списке на главном экране. Расширяется добавлением строк, без
-- пересборки приложения.
create table if not exists public.car_models (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  model text not null,
  price integer not null,
  sort_order integer not null default 0
);

alter table public.car_models enable row level security;

create policy "anon can read car models"
  on public.car_models for select
  to anon
  using (true);

insert into public.car_models (brand, model, price, sort_order) values
  ('CHANGAN', 'Q05', 1500, 1),
  ('CHANGAN', 'UNI-Z', 3500, 2),
  ('CHANGAN', 'CS75 PRO', 3500, 3),
  ('CHANGAN', 'CS55 PLUS', 3500, 4),
  ('CHANGAN', 'UNI-V', 3500, 5)
on conflict do nothing;

-- Сессии работы с конкретной машиной. Создаётся Edge Function car-session
-- (action start) при запуске AUTOMAX KG из выпадающего списка, закрывается
-- ею же (action finish) по кнопке "Завершено". paid переключает только
-- admin-action. Никаких anon-политик — все чтения/записи идут через эти
-- две Edge Functions (service_role), с проверкой личности по токену входа.
create table if not exists public.car_sessions (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  telegram_username text,
  telegram_name text,
  brand text not null,
  model text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  paid boolean not null default false
);

alter table public.car_sessions enable row level security;
