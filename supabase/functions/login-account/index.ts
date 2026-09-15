// Вставить в Supabase Dashboard -> Edge Functions -> Create a new function
// (имя функции: login-account) -> вставить этот код -> Deploy.
//
// Обычный вход для не-администраторов — по никнейму+паролю, без Telegram.
// При успехе выдаёт обычный approved loginToken (та же таблица
// telegram_login_tokens, что и у входа через Telegram) — вся остальная
// логика (car-session, admin-action, automaxkg-*) работает одинаково,
// независимо от того, как именно был получен токен.

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
  if (!body?.nickname || !body?.password) {
    return json({ error: 'nickname и password обязательны' }, 400);
  }

  const nickname = String(body.nickname).trim();

  const { data: account } = await supabase
    .from('local_accounts')
    .select('telegram_id, password_hash')
    .eq('nickname', nickname)
    .maybeSingle();

  // Намеренно один и тот же ответ на "нет такого никнейма" и "неверный
  // пароль" — не подсказываем, что из двух неверно.
  const genericError = () => json({ error: 'Неверный никнейм или пароль' }, 401);

  if (!account) return genericError();

  const passwordOk = await bcrypt.compare(String(body.password), account.password_hash);
  if (!passwordOk) return genericError();

  const { data: blocked } = await supabase
    .from('blocked_telegram_users')
    .select('telegram_id')
    .eq('telegram_id', account.telegram_id)
    .maybeSingle();
  if (blocked) return json({ error: 'Доступ заблокирован администратором' }, 403);

  const { data: userRow } = await supabase
    .from('telegram_users')
    .select('*')
    .eq('telegram_id', account.telegram_id)
    .maybeSingle();

  const telegramUserPayload = {
    id: account.telegram_id,
    first_name: userRow?.first_name ?? null,
    last_name: userRow?.last_name ?? null,
    username: userRow?.username ?? null,
  };

  const newToken = crypto.randomUUID();
  const { error: mintError } = await supabase.from('telegram_login_tokens').insert({
    token: newToken,
    status: 'approved',
    purpose: 'login',
    telegram_user: telegramUserPayload,
    confirmed_at: new Date().toISOString(),
    decided_at: new Date().toISOString(),
    decided_by: null,
  });
  if (mintError) return json({ error: mintError.message }, 500);

  return json({ token: newToken });
});
