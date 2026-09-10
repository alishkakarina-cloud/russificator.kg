// Вставить в Supabase Dashboard -> Edge Functions -> Create a new function
// (имя функции: activation-request) -> вставить этот код -> Deploy.
// Тот же секрет TELEGRAM_BOT_TOKEN, что уже используется в telegram-webhook/
// support-message.
//
// Отдельный, самостоятельный механизм от входа в приложение (telegram-login-
// start/telegram-webhook с purpose='login') — с ним НЕ пересекается ни по
// таблице (activation_requests, не telegram_login_tokens), ни по callback_data
// в боте (activate_confirm:/activate_reject:, не approve:/reject:). Здесь
// пользователь уже вошёл и выбрал машину — это заявка на саму работу с
// машиной, подтверждает её админ прямо в боте, пользователь в Telegram не
// переходит вообще.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function tg(method: string, payload: unknown) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((e) => console.error('Telegram API error', e));
}

async function resolveTelegramUser(loginToken: string) {
  const { data } = await supabase
    .from('telegram_login_tokens')
    .select('telegram_user, status')
    .eq('token', loginToken)
    .maybeSingle();
  if (!data || data.status !== 'approved' || !data.telegram_user) return null;
  const user = data.telegram_user as { id: number; first_name: string; last_name: string | null; username: string | null };
  // approved-токен не истекает сам по себе, а кик (blocked_telegram_users)
  // раньше проверялся только в клиенте и при новом /start в боте — сам
  // запрос сюда с уже выданным токеном никак не блокировался. Теперь кик
  // проверяется на той же границе, что и остальная авторизация: кикнутый
  // получает тот же 401, что и при невалидной сессии.
  const { data: blocked } = await supabase
    .from('blocked_telegram_users')
    .select('telegram_id')
    .eq('telegram_id', user.id)
    .maybeSingle();
  if (blocked) return null;
  return user;
}

// Тот же принцип, что в admin-action/telegram-webhook/support-message —
// список админов в таблице admin_usernames, не захардкожен.
async function getAdminTelegramIds(): Promise<number[]> {
  const { data: admins } = await supabase.from('admin_usernames').select('username');
  const adminSet = new Set((admins ?? []).map((a) => a.username.toLowerCase()));
  if (!adminSet.size) return [];
  const { data: users } = await supabase.from('telegram_users').select('telegram_id, username');
  return (users ?? [])
    .filter((u) => u.username && adminSet.has(u.username.toLowerCase()))
    .map((u) => u.telegram_id);
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => null);
  if (!body?.action || !body?.loginToken) {
    return json({ error: 'action и loginToken обязательны' }, 400);
  }

  const user = await resolveTelegramUser(body.loginToken);
  if (!user) return json({ error: 'Сессия входа недействительна' }, 401);

  if (body.action === 'create') {
    if (!body.brand || !body.model) return json({ error: 'brand и model обязательны' }, 400);

    // Не даём наплодить заявки, пока предыдущая ещё не решена — тот же
    // принцип, что и с car_sessions (одна активная работа на пользователя).
    const { data: existing } = await supabase
      .from('activation_requests')
      .select('id')
      .eq('telegram_id', user.id)
      .eq('status', 'pending')
      .maybeSingle();
    if (existing) return json({ request: existing });

    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    const { data, error } = await supabase
      .from('activation_requests')
      .insert({
        telegram_id: user.id,
        telegram_username: user.username,
        telegram_name: name,
        brand: body.brand,
        model: body.model,
      })
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);

    const who = user.username ? `@${user.username}` : name || `id ${user.id}`;
    const adminIds = await getAdminTelegramIds();
    for (const adminId of adminIds) {
      await tg('sendMessage', {
        chat_id: adminId,
        text: `Заявка на активацию — russificator.kg\n${who}\n${body.brand} ${body.model}\nВремя: ${new Date().toLocaleString('ru-RU')}`,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Подтвердить', callback_data: `activate_confirm:${data.id}` },
            { text: '⛔ Отклонить', callback_data: `activate_reject:${data.id}` },
          ]],
        },
      });
    }

    return json({ request: data });
  }

  // Статус заявки клиент опрашивает через эту же функцию (а не напрямую
  // anon-ключом, как было раньше) — anon-политика "using (true)" на
  // activation_requests на деле разрешала ЛИСТИНГ всей таблицы (RLS
  // проверяет строку, не фильтр запроса), а не point-lookup по id, как
  // задумывалось. Здесь identity уже подтверждена по loginToken выше, плюс
  // явная проверка telegram_id — так нельзя даже случайно опросить чужую
  // заявку, зная только её id.
  if (body.action === 'status') {
    if (!body.requestId) return json({ error: 'requestId обязателен' }, 400);
    const { data, error } = await supabase
      .from('activation_requests')
      .select('status')
      .eq('id', body.requestId)
      .eq('telegram_id', user.id)
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    return json({ status: data ? data.status : null });
  }

  if (body.action === 'cancel') {
    if (!body.requestId) return json({ error: 'requestId обязателен' }, 400);
    const { data, error } = await supabase
      .from('activation_requests')
      .update({ status: 'cancelled', decided_at: new Date().toISOString() })
      .eq('id', body.requestId)
      .eq('telegram_id', user.id)
      .eq('status', 'pending')
      .select()
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    return json({ request: data });
  }

  return json({ error: 'Неизвестное действие' }, 400);
});
