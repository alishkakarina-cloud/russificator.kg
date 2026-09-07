// Вставить в Supabase Dashboard -> Edge Functions -> Create a new function
// (имя функции: support-message) -> вставить этот код -> Deploy.
// Тот же секрет TELEGRAM_BOT_TOKEN, что уже используется в telegram-webhook.
//
// Пользовательская сторона переписки "Написать администратору" (Блок 7).
// Идентичность (telegram_id) всегда переопределяется из loginToken на
// сервере — клиент не может прислать чужой telegram_id и прочитать/отправить
// сообщения от чужого имени. Сторона администратора — отдельно, в
// admin-action (list_support_threads/list_support_messages/send_support_reply).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Тот же принцип, что в admin-action/telegram-webhook: список админов — в
// таблице admin_usernames, а не захардкожен здесь.
async function getAdminTelegramIds(): Promise<number[]> {
  const { data: admins } = await supabase.from('admin_usernames').select('username');
  const adminSet = new Set((admins ?? []).map((a) => a.username.toLowerCase()));
  if (!adminSet.size) return [];
  const { data: users } = await supabase.from('telegram_users').select('telegram_id, username');
  return (users ?? [])
    .filter((u) => u.username && adminSet.has(u.username.toLowerCase()))
    .map((u) => u.telegram_id);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}

async function tg(method: string, payload: unknown) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((e) => console.error('Telegram API error', e));
}

async function resolveTelegramId(loginToken: string): Promise<{ id: number; username: string | null } | null> {
  const { data } = await supabase
    .from('telegram_login_tokens')
    .select('telegram_user, status')
    .eq('token', loginToken)
    .maybeSingle();
  if (!data || data.status !== 'approved' || !data.telegram_user) return null;
  return { id: data.telegram_user.id, username: data.telegram_user.username ?? null };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const body = await req.json().catch(() => null);
  if (!body?.action || !body?.loginToken) {
    return json({ error: 'action и loginToken обязательны' }, 400);
  }

  const user = await resolveTelegramId(body.loginToken);
  if (!user) return json({ error: 'Сессия входа недействительна' }, 401);

  switch (body.action) {
    case 'list': {
      const { data, error } = await supabase
        .from('support_messages')
        .select('*')
        .eq('telegram_id', user.id)
        .order('created_at', { ascending: true });
      if (error) return json({ error: error.message }, 500);
      return json({ messages: data ?? [] });
    }

    case 'send': {
      if (typeof body.text !== 'string' || !body.text.trim()) {
        return json({ error: 'text обязателен' }, 400);
      }
      const text = body.text.trim().slice(0, 2000);
      const { error } = await supabase
        .from('support_messages')
        .insert({ telegram_id: user.id, sender_role: 'user', text });
      if (error) return json({ error: error.message }, 500);

      const who = user.username ? `@${user.username}` : `id ${user.id}`;
      for (const chatId of await getAdminTelegramIds()) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: `Новое сообщение от ${who} (russificator.kg):\n\n${text}`,
        });
      }
      return json({ ok: true });
    }

    default:
      return json({ error: 'Неизвестное действие' }, 400);
  }
});
