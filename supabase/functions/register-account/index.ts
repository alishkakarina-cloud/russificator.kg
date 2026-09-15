// Вставить в Supabase Dashboard -> Edge Functions -> Create a new function
// (имя функции: register-account) -> вставить этот код -> Deploy.
//
// Финальный шаг регистрации по никнейму/паролю. Личность (реальный
// Telegram ID + юзернейм из whitelist) уже подтверждена на предыдущем шаге
// (telegram-webhook, purpose='register', статус токена стал
// 'registration_confirmed') — здесь только заводим сами учётные данные
// (никнейм+пароль) и сразу выдаём обычный approved loginToken, чтобы не
// заставлять человека логиниться отдельным шагом сразу после регистрации.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import bcrypt from 'https://esm.sh/bcryptjs@2.4.3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => null);
  if (!body?.loginToken || !body?.nickname || !body?.password) {
    return json({ error: 'loginToken, nickname и password обязательны' }, 400);
  }

  const nickname = String(body.nickname).trim();
  const password = String(body.password);
  if (nickname.length < 3) return json({ error: 'Никнейм должен быть не короче 3 символов' }, 400);
  if (password.length < 6) return json({ error: 'Пароль должен быть не короче 6 символов' }, 400);

  const { data: tokenRow } = await supabase
    .from('telegram_login_tokens')
    .select('telegram_user, status')
    .eq('token', body.loginToken)
    .maybeSingle();

  if (!tokenRow || tokenRow.status !== 'registration_confirmed' || !tokenRow.telegram_user) {
    return json({ error: 'Личность не подтверждена — начните регистрацию заново' }, 401);
  }

  const telegramId = tokenRow.telegram_user.id as number;

  const { data: existing } = await supabase
    .from('local_accounts')
    .select('telegram_id')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  if (existing) return json({ error: 'Для этого Telegram-аккаунта уже создана учётная запись' }, 409);

  const passwordHash = await bcrypt.hash(password, 10);

  const { error: insertError } = await supabase
    .from('local_accounts')
    .insert({ telegram_id: telegramId, nickname, password_hash: passwordHash });

  if (insertError) {
    // unique_violation на nickname — самая вероятная причина конфликта здесь.
    if (insertError.code === '23505') return json({ error: 'Этот никнейм уже занят' }, 409);
    return json({ error: insertError.message }, 500);
  }

  // Сразу выдаём обычный approved loginToken — те же правила действуют
  // дальше (car-session, admin-action, automaxkg-*), никакого отдельного
  // "второго входа" сразу после регистрации не требуется.
  const newToken = crypto.randomUUID();
  const { error: mintError } = await supabase.from('telegram_login_tokens').insert({
    token: newToken,
    status: 'approved',
    purpose: 'login',
    telegram_user: tokenRow.telegram_user,
    confirmed_at: new Date().toISOString(),
    decided_at: new Date().toISOString(),
    decided_by: null,
  });
  if (mintError) return json({ error: mintError.message }, 500);

  return json({ token: newToken });
});
