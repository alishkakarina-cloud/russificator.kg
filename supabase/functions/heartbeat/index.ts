// Вставить в Supabase Dashboard -> Edge Functions -> Create a new function
// (имя функции: heartbeat) -> вставить этот код -> Deploy.
//
// Вызывается клиентом каждые 45 секунд, пока приложение открыто с активной
// сессией — просто обновляет отметку времени. "Онлайн" в админ-панели —
// не отдельный статус на сервере, а просто "last_heartbeat_at не старше
// пары интервалов" — вычисляется на клиенте при отображении списка.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => null);
  if (!body?.loginToken) return json({ error: 'loginToken обязателен' }, 400);

  const { data } = await supabase
    .from('telegram_login_tokens')
    .select('telegram_user, status')
    .eq('token', body.loginToken)
    .maybeSingle();

  if (!data || data.status !== 'approved' || !data.telegram_user) {
    return json({ error: 'Сессия входа недействительна' }, 401);
  }

  // approved-токен не истекает сам по себе, а кик (blocked_telegram_users)
  // раньше проверялся только в клиенте и при новом /start в боте — сам
  // heartbeat никак не блокировался. Теперь кик проверяется на той же
  // границе, что и остальная авторизация.
  const { data: blocked } = await supabase
    .from('blocked_telegram_users')
    .select('telegram_id')
    .eq('telegram_id', data.telegram_user.id)
    .maybeSingle();
  if (blocked) return json({ error: 'Сессия входа недействительна' }, 401);

  await supabase
    .from('telegram_users')
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq('telegram_id', data.telegram_user.id);

  return json({ ok: true });
});
