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

-- НИКАКИХ anon-политик на select. Раньше была политика "using (true)" в
-- расчёте на то, что клиент сам фильтрует запрос по своему токену — но RLS
-- действует на уровне СТРОКИ, а не запроса: такая политика на деле разрешает
-- прочитать ВСЮ таблицу целиком (листинг без фильтра тоже проходит), включая
-- чужие approved-токены и telegram_user (имя/username/id). Кто угодно с
-- публичным anon-ключом мог выкачать чужие токены и угнать чужую сессию —
-- нашли и закрыли эту дыру. Статус токена теперь читает только Edge Function
-- login-status (service_role, point-lookup по присланному в теле токену) —
-- см. renderer.js fetchTokenRow. Создаёт токен и меняет статус тоже только
-- через service_role — anon не может ни завести токен сам, ни одобрить
-- себе вход.

-- Кик через бота (/kick, /unkick — см. telegram-webhook). Приложение читает
-- эту таблицу при запуске и при продлении локальной сессии, чтобы кик
-- срабатывал даже внутри 10-минутного окна доверия устройству.
create table if not exists public.blocked_telegram_users (
  telegram_id bigint primary key,
  blocked_at timestamptz not null default now(),
  blocked_by bigint
);

alter table public.blocked_telegram_users enable row level security;

-- НИКАКИХ anon-политик на select — тот же паттерн-ошибка, что и у
-- telegram_login_tokens выше ("using (true)" = листинг всей таблицы, а не
-- point-lookup). Кик теперь проверяет: (1) Edge Function login-status,
-- action 'blocked' — клиент дёргает её при старте/продлении локальной
-- сессии (см. renderer.js isBlocked), и (2) КАЖДАЯ ресурсная Edge Function
-- (car-session, activation-request, heartbeat, record-login,
-- support-message, automaxkg-manifest) — внутри resolveTelegramUser/
-- resolveTelegramId, той же проверкой, что и approved-статус токена. Раньше
-- эта вторая часть отсутствовала полностью: кикнутый пользователь с уже
-- выданным approved-токеном сохранял полный доступ ко всем этим функциям
-- бесконечно, несмотря на кик — клиентская проверка ничего не гарантирует,
-- её можно пропатчить или просто дёрнуть функцию напрямую.

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

-- Полный аудит-лог: вход/одобрение/отклонение/кик (session_id пуст — эти
-- события ещё не привязаны ни к какой машине), выбор марки/модели, запуск
-- AUTOMAX KG (или ошибка запуска), "Завершено", истечение локальной сессии.
-- on delete set null — при (гипотетическом) удалении car_sessions лог не
-- пропадает, просто теряет привязку к конкретной сессии.
-- Пишут только Edge Functions (service_role) — никаких anon-политик.
create table if not exists public.session_audit_log (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.car_sessions(id) on delete set null,
  telegram_id bigint,
  event_type text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

alter table public.session_audit_log enable row level security;

create index if not exists session_audit_log_session_id_idx on public.session_audit_log (session_id);

-- Принудительное обновление: min_version — минимально разрешённая версия
-- программы. Если у пользователя версия младше — приложение показывает
-- экран принудительного обновления вместо экрана входа (см. checkForcedUpdate
-- в renderer.js) и не даёт продолжить, пока не обновится. Значение по
-- умолчанию (1.0.0) никого не блокирует — поднимается вручную в этой
-- таблице, когда реально нужно заставить всех обновиться до конкретной
-- версии. anon может только читать — менять могут только через service_role/
-- дашборд Supabase, не из самого приложения.
create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

create policy "anon can read app settings"
  on public.app_settings for select
  to anon
  using (true);

insert into public.app_settings (key, value)
values ('min_version', '1.0.0')
on conflict (key) do nothing;

-- Администраторы теперь по списку юзернеймов, а не по захардкоженным
-- telegram-ID в коде трёх разных Edge Functions (admin-action,
-- telegram-webhook, support-message — все теперь читают эту таблицу).
-- username всегда хранится в нижнем регистре, без "@" — сверка тоже всегда
-- по нижнему регистру, чтобы не зависеть от того, как юзернейм набран.
-- Добавить нового админа — просто вставить сюда ещё одну строку, код
-- переписывать не нужно. Никаких anon-политик — читают/пишут только
-- Edge Functions через service_role.
create table if not exists public.admin_usernames (
  username text primary key,
  added_at timestamptz not null default now()
);

alter table public.admin_usernames enable row level security;

insert into public.admin_usernames (username) values
  ('fxallish'),
  ('wiqqq99')
on conflict do nothing;

-- Заявки на активацию (выбор марки/модели -> подтверждение админом в боте).
-- Отдельная таблица и отдельный механизм от входа (telegram_login_tokens) —
-- сознательно не объединяем, чтобы не путать вход в приложение и заявку на
-- работу с конкретной машиной. Создаёт/меняет только activation-request
-- (service_role) и telegram-webhook (callback activate_confirm/activate_reject).
-- НИКАКИХ anon-политик. Раньше была "using (true)" в расчёте на
-- point-lookup по неугадываемому id заявки — тот же паттерн-ошибка, что и у
-- telegram_login_tokens (RLS проверяет строку, не фильтр запроса, так что
-- это был листинг ВСЕХ заявок всех пользователей). Статус заявки клиент
-- теперь опрашивает через саму activation-request (action 'status',
-- loginToken + requestId, с проверкой telegram_id — см. renderer.js).
create table if not exists public.activation_requests (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  telegram_username text,
  telegram_name text,
  brand text not null,
  model text not null,
  status text not null default 'pending', -- pending | confirmed | rejected | cancelled
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by bigint
);

alter table public.activation_requests enable row level security;
