// Вставить в Supabase Dashboard -> Edge Functions -> Create a new function
// (имя функции: telegram-webhook) -> вставить этот код -> Deploy.
//
// Перед деплоем добавить секреты: Edge Functions -> Manage secrets ->
//   TELEGRAM_BOT_TOKEN = <токен бота>
//   TELEGRAM_WEBHOOK_SECRET = <случайная строка, та же, что передана в setWebhook secret_token>
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY подставляются автоматически.
//
// Паттерн (токен в /start, подтверждение личности через вебхук, проверка
// секрета заголовком) — тот же, что в проекте Trecker
// (app/api/telegram-webhook). Отличие russificator.kg: после подтверждения
// личности доступ не открывается сразу — вместо этого обоим админам уходит
// сообщение с кнопками Принять/Отклонить, и только их решение меняет статус
// на approved/rejected.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// @TOGUZZ11 и @Wiqqq99 — оба равноправные администраторы.
// ВРЕМЕННО для теста сценария обычного пользователя от лица @TOGUZZ11 —
// вернуть [7155433371, 8106761823] по завершении теста.
const ADMIN_CHAT_IDS = [8106761823];

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function isFromTelegram(req: Request): boolean {
  return req.headers.get('x-telegram-bot-api-secret-token') === TELEGRAM_WEBHOOK_SECRET;
}

async function tg(method: string, payload: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

Deno.serve(async (req) => {
  if (!isFromTelegram(req)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const update = await req.json().catch(() => null);
  if (!update) return new Response(JSON.stringify({ ok: true }));

  // 0) Админ-команды /kick <telegram_id> и /unkick <telegram_id>. Пока нет
  //    отдельной админ-панели — это единственный способ кикнуть пользователя;
  //    приложение проверяет blocked_telegram_users при запуске и при
  //    продлении локальной сессии.
  const adminMessage = update.message;
  if (adminMessage?.text && ADMIN_CHAT_IDS.includes(adminMessage.from?.id)) {
    const kickMatch = adminMessage.text.match(/^\/(kick|unkick)\s+(\d+)/);
    if (kickMatch) {
      const [, cmd, idStr] = kickMatch;
      const targetId = Number(idStr);
      if (cmd === 'kick') {
        await supabase
          .from('blocked_telegram_users')
          .upsert({ telegram_id: targetId, blocked_by: adminMessage.from.id, blocked_at: new Date().toISOString() });
        await tg('sendMessage', { chat_id: adminMessage.chat.id, text: `Пользователь ${targetId} заблокирован.` });
      } else {
        await supabase.from('blocked_telegram_users').delete().eq('telegram_id', targetId);
        await tg('sendMessage', { chat_id: adminMessage.chat.id, text: `Пользователь ${targetId} разблокирован.` });
      }
      return new Response(JSON.stringify({ ok: true }));
    }
  }

  // 1) Пользователь нажал Start по диплинку из приложения: "/start <token>"
  //    — подтверждаем личность. Дальше три варианта: кикнут -> сразу отказ,
  //    доверенный -> сразу approved без пинга админам, иначе -> обычная
  //    заявка админам, как раньше.
  const message = update.message;
  if (message?.text?.startsWith('/start ')) {
    const token = message.text.slice('/start '.length).trim();
    const from = message.from;
    const label = from.username ? `@${from.username}` : `id ${from.id}`;
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ');

    // Учитываем каждого, кто хоть раз нажал Start — видно в админ-панели
    // (список пользователей), независимо от исхода этого конкретного входа.
    await supabase.from('telegram_users').upsert(
      {
        telegram_id: from.id,
        username: from.username ?? null,
        first_name: from.first_name,
        last_name: from.last_name ?? null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'telegram_id', ignoreDuplicates: false }
    );

    const [{ data: blocked }, { data: userRow }] = await Promise.all([
      supabase.from('blocked_telegram_users').select('telegram_id').eq('telegram_id', from.id).maybeSingle(),
      supabase.from('telegram_users').select('trusted').eq('telegram_id', from.id).maybeSingle(),
    ]);

    const telegramUserPayload = {
      id: from.id,
      first_name: from.first_name,
      last_name: from.last_name ?? null,
      username: from.username ?? null,
    };

    if (blocked) {
      await supabase
        .from('telegram_login_tokens')
        .update({ telegram_user: telegramUserPayload, confirmed_at: new Date().toISOString(), status: 'rejected' })
        .eq('token', token)
        .eq('status', 'pending_telegram');
      await tg('sendMessage', { chat_id: from.id, text: 'Доступ заблокирован администратором.' });
      return new Response(JSON.stringify({ ok: true }));
    }

    if (userRow?.trusted) {
      const { data: row } = await supabase
        .from('telegram_login_tokens')
        .update({
          telegram_user: telegramUserPayload,
          confirmed_at: new Date().toISOString(),
          status: 'approved',
          decided_at: new Date().toISOString(),
          decided_by: null,
        })
        .eq('token', token)
        .eq('status', 'pending_telegram')
        .select()
        .maybeSingle();

      if (row) {
        await tg('sendMessage', { chat_id: from.id, text: 'Вход подтверждён автоматически (доверенный пользователь).' });
      } else {
        await tg('sendMessage', {
          chat_id: from.id,
          text: 'Ссылка для входа устарела — вернитесь в приложение и нажмите «Войти через Telegram» ещё раз.',
        });
      }
      return new Response(JSON.stringify({ ok: true }));
    }

    const { data: row } = await supabase
      .from('telegram_login_tokens')
      .update({
        telegram_user: telegramUserPayload,
        confirmed_at: new Date().toISOString(),
        status: 'pending_admin',
      })
      .eq('token', token)
      .eq('status', 'pending_telegram')
      .select()
      .maybeSingle();

    if (row) {
      await tg('sendMessage', {
        chat_id: from.id,
        text: 'Личность подтверждена. Заявка отправлена администратору — ожидайте решения.',
      });
      for (const adminId of ADMIN_CHAT_IDS) {
        await tg('sendMessage', {
          chat_id: adminId,
          text: `Запрос на вход в russificator.kg\n${name} (${label})\nВремя: ${new Date().toLocaleString('ru-RU')}`,
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Принять', callback_data: `approve:${token}` },
              { text: '⛔ Отклонить', callback_data: `reject:${token}` },
            ]],
          },
        });
      }
    } else {
      await tg('sendMessage', {
        chat_id: from.id,
        text: 'Ссылка для входа устарела — вернитесь в приложение и нажмите «Войти через Telegram» ещё раз.',
      });
    }
    return new Response(JSON.stringify({ ok: true }));
  }

  // 2) Админ нажал "Принять" / "Отклонить"
  const cq = update.callback_query;
  if (cq) {
    const adminId = cq.from.id;
    const [action, token] = (cq.data ?? '').split(':');

    if (!ADMIN_CHAT_IDS.includes(adminId)) {
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Нет прав.', show_alert: true });
      return new Response(JSON.stringify({ ok: true }));
    }

    if (action !== 'approve' && action !== 'reject') {
      await tg('answerCallbackQuery', { callback_query_id: cq.id });
      return new Response(JSON.stringify({ ok: true }));
    }

    const { data: row } = await supabase
      .from('telegram_login_tokens')
      .update({
        status: action === 'approve' ? 'approved' : 'rejected',
        decided_at: new Date().toISOString(),
        decided_by: adminId,
      })
      .eq('token', token)
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

    return new Response(JSON.stringify({ ok: true }));
  }

  return new Response(JSON.stringify({ ok: true }));
});
