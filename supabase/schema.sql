-- Вставить в Supabase Dashboard -> SQL Editor -> New query -> Run

create table if not exists public.login_requests (
  id uuid primary key default gen_random_uuid(),
  session_id text unique not null,
  method text not null default 'telegram',
  telegram_id bigint,
  telegram_username text,
  status text not null default 'awaiting_telegram_start',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by bigint
);

alter table public.login_requests enable row level security;

-- Приложение (anon-ключ) может создать заявку на вход.
create policy "anon can insert login requests"
  on public.login_requests for insert
  to anon
  with check (true);

-- Приложение (anon-ключ) может читать статус заявки по её session_id (это и есть
-- секрет, дающий доступ к чтению именно этой заявки).
create policy "anon can read login requests"
  on public.login_requests for select
  to anon
  using (true);

-- Обновлять статус (approved/rejected) может только сама Edge Function
-- через service_role ключ, который RLS не проверяет — политика на update
-- для anon сознательно не создаётся, чтобы никто не мог сам себя одобрить.
