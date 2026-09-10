// Вставить в Supabase Dashboard -> Edge Functions -> Create a new function
// (имя функции: login-status) -> вставить этот код -> Deploy.
// Секретов не требует сверх стандартных SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.
//
// Раньше клиент читал telegram_login_tokens и blocked_telegram_users
// НАПРЯМУЮ анонимным ключом через REST (anon-политика "using (true)"). Идея
// была "point lookup по неугадываемому token/id", но RLS так не работает —
// политика действует на уровне СТРОКИ, а не запроса: она разрешает читать
// ЛЮБУЮ строку целиком (в т.ч. без фильтра, т.е. листингом всей таблицы),
// просто клиент обычно и так фильтровал по своему токену. Кто угодно с
// публичным anon-ключом (он и так лежит в config.js) мог выкачать все
// когда-либо выданные approved-токены чужих пользователей и угнать чужую
// сессию. Эта функция — правильная реализация того же point-lookup: точечный
// запрос делает service_role здесь, а не RLS на клиентском запросе.
//
// action 'token_status' — статус токена входа (полностью замещает прямое
// чтение telegram_login_tokens с клиента, см. fetchTokenRow в renderer.js).
// action 'blocked' — проверка кика (полностью замещает прямое чтение
// blocked_telegram_users с клиента, см. isBlocked в renderer.js). Принимает
// loginToken, а не telegram_id — идентичность подтверждается сервером по
// уже одобренному токену входа, клиент не может спросить про чужой id.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => null);
  if (!body?.action) return json({ error: 'action обязателен' }, 400);

  if (body.action === 'token_status') {
    if (!body.token) return json({ error: 'token обязателен' }, 400);
    const { data } = await supabase
      .from('telegram_login_tokens')
      .select('status, telegram_user')
      .eq('token', body.token)
      .maybeSingle();
    return json({ row: data ?? null });
  }

  if (body.action === 'blocked') {
    if (!body.loginToken) return json({ error: 'loginToken обязателен' }, 400);
    const { data: tokenRow } = await supabase
      .from('telegram_login_tokens')
      .select('telegram_user, status')
      .eq('token', body.loginToken)
      .maybeSingle();
    // Невалидный/ещё не одобренный токен — не наша забота здесь, остальная
    // логика клиента сама разберётся с невалидной сессией; про кик в этом
    // случае просто нечего проверять.
    if (!tokenRow || tokenRow.status !== 'approved' || !tokenRow.telegram_user) {
      return json({ blocked: false });
    }
    const { data: blocked } = await supabase
      .from('blocked_telegram_users')
      .select('telegram_id')
      .eq('telegram_id', tokenRow.telegram_user.id)
      .maybeSingle();
    return json({ blocked: Boolean(blocked) });
  }

  return json({ error: 'Неизвестное действие' }, 400);
});
