// Вставить в Supabase Dashboard -> Edge Functions -> Create a new function
// (имя функции: telegram-webhook) -> вставить этот код -> Deploy.
//
// Перед деплоем добавить секрет: Edge Functions -> Manage secrets ->
//   TELEGRAM_BOT_TOKEN = <токен бота>
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY подставляются автоматически.
//
// После деплоя сообщить URL функции, чтобы прописать его в Telegram как webhook.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// @TOGUZZ11 и @Wiqqq99 — оба равноправные администраторы.
const ADMIN_CHAT_IDS = [7155433371, 8106761823];

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function tg(method: string, payload: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

Deno.serve(async (req) => {
  const update = await req.json().catch(() => null);
  if (!update) return new Response('ok');

  // 1) Пользователь нажал Start по диплинку из приложения: "/start <session_id>"
  if (update.message?.text?.startsWith('/start')) {
    const parts = update.message.text.trim().split(/\s+/);
    const sessionId = parts[1];
    const from = update.message.from;

    if (sessionId) {
      const { data: row } = await supabase
        .from('login_requests')
        .update({
          telegram_id: from.id,
          telegram_username: from.username ?? null,
          status: 'pending_admin',
        })
        .eq('session_id', sessionId)
        .eq('status', 'awaiting_telegram_start')
        .select()
        .maybeSingle();

      if (row) {
        await tg('sendMessage', {
          chat_id: from.id,
          text: 'Заявка отправлена администратору. Ожидайте подтверждения.',
        });
        const label = from.username ? `@${from.username}` : `id ${from.id}`;
        for (const adminId of ADMIN_CHAT_IDS) {
          await tg('sendMessage', {
            chat_id: adminId,
            text: `Запрос на вход в russificator.kg\nПользователь: ${label} (id ${from.id})`,
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Принять', callback_data: `approve:${sessionId}` },
                { text: '⛔ Отклонить', callback_data: `reject:${sessionId}` },
              ]],
            },
          });
        }
      } else {
        await tg('sendMessage', {
          chat_id: from.id,
          text: 'Заявка не найдена или уже обработана. Попробуйте войти в приложении заново.',
        });
      }
    }
    return new Response('ok');
  }

  // 2) Админ нажал "Принять" / "Отклонить"
  if (update.callback_query) {
    const cq = update.callback_query;
    const adminId = cq.from.id;
    const [action, sessionId] = (cq.data ?? '').split(':');

    if (!ADMIN_CHAT_IDS.includes(adminId)) {
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Нет прав.', show_alert: true });
      return new Response('ok');
    }

    if (action !== 'approve' && action !== 'reject') {
      await tg('answerCallbackQuery', { callback_query_id: cq.id });
      return new Response('ok');
    }

    const { data: row } = await supabase
      .from('login_requests')
      .update({
        status: action === 'approve' ? 'approved' : 'rejected',
        decided_at: new Date().toISOString(),
        decided_by: adminId,
      })
      .eq('session_id', sessionId)
      .eq('status', 'pending_admin')
      .select()
      .maybeSingle();

    const resultText = row
      ? (action === 'approve' ? '✅ Принято' : '⛔ Отклонено')
      : 'Уже обработано другим админом';

    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: resultText });
    await tg('editMessageText', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: `${cq.message.text}\n\n${resultText}`,
    });

    return new Response('ok');
  }

  return new Response('ok');
});
