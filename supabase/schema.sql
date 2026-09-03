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
