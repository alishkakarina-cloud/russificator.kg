// Вставить в Supabase Dashboard -> Edge Functions -> Create a new function
// (имя функции: admin-action) -> вставить этот код -> Deploy.
// Секретов не требует сверх стандартных SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.
//
// Все действия админ-панели (список пользователей, история сессий по дате,
// доверенный/кик, статус оплаты) идут только отсюда. adminToken — это
// собственный loginToken администратора (тот же, что и у обычных
// пользователей, из telegram_login_tokens) — функция сама проверяет, что он
// approved и что его telegram id входит в список админов, не доверяя
// telegram id, присланному в теле запроса.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// @TOGUZZ11 и @Wiqqq99 — оба равноправные администраторы.
const ADMIN_CHAT_IDS = [7155433371, 8106761823];

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function logEvent(sessionId: string | null, telegramId: number | null, eventType: string, detail?: unknown) {
  await supabase.from('session_audit_log').insert({ session_id: sessionId, telegram_id: telegramId, event_type: eventType, detail: detail ?? null });
}

async function requireAdmin(adminToken: string): Promise<number | null> {
  const { data } = await supabase
    .from('telegram_login_tokens')
    .select('telegram_user, status')
    .eq('token', adminToken)
    .maybeSingle();
  const id = data?.status === 'approved' ? data.telegram_user?.id : null;
  return id && ADMIN_CHAT_IDS.includes(id) ? id : null;
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => null);
  if (!body?.action || !body?.adminToken) {
    return json({ error: 'action и adminToken обязательны' }, 400);
  }

  const adminId = await requireAdmin(body.adminToken);
  if (!adminId) {
    return json({ error: 'Нет прав администратора' }, 403);
  }

  switch (body.action) {
    case 'list_users': {
      const [{ data: users }, { data: blocked }] = await Promise.all([
        supabase.from('telegram_users').select('*').order('last_seen_at', { ascending: false }),
        supabase.from('blocked_telegram_users').select('telegram_id'),
      ]);
      const blockedIds = new Set((blocked ?? []).map((b) => b.telegram_id));
      return json({
        users: (users ?? []).map((u) => ({ ...u, blocked: blockedIds.has(u.telegram_id) })),
      });
    }

    case 'set_trusted': {
      if (typeof body.targetTelegramId !== 'number' || typeof body.trusted !== 'boolean') {
        return json({ error: 'targetTelegramId и trusted обязательны' }, 400);
      }
      const { error } = await supabase
        .from('telegram_users')
        .update({ trusted: body.trusted })
        .eq('telegram_id', body.targetTelegramId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    case 'kick': {
      if (typeof body.targetTelegramId !== 'number') return json({ error: 'targetTelegramId обязателен' }, 400);
      const { error } = await supabase
        .from('blocked_telegram_users')
        .upsert({ telegram_id: body.targetTelegramId, blocked_by: adminId, blocked_at: new Date().toISOString() });
      if (error) return json({ error: error.message }, 500);

      // Если у кикнутого прямо сейчас открыта работа с машиной — привязываем
      // событие к этой сессии тоже, чтобы это было видно в её детальном логе.
      const { data: active } = await supabase
        .from('car_sessions')
        .select('id')
        .eq('telegram_id', body.targetTelegramId)
        .is('ended_at', null)
        .maybeSingle();
      await logEvent(active?.id ?? null, body.targetTelegramId, 'user_kicked', { blocked_by: adminId, via: 'admin_panel' });
      return json({ ok: true });
    }

    case 'unkick': {
      if (typeof body.targetTelegramId !== 'number') return json({ error: 'targetTelegramId обязателен' }, 400);
      const { error } = await supabase.from('blocked_telegram_users').delete().eq('telegram_id', body.targetTelegramId);
      if (error) return json({ error: error.message }, 500);
      await logEvent(null, body.targetTelegramId, 'user_unkicked', { by: adminId, via: 'admin_panel' });
      return json({ ok: true });
    }

    case 'list_sessions_by_date': {
      // Границы дня считает клиент в своём локальном часовом поясе и шлёт
      // готовые UTC-инстанты — иначе выбор "сегодня" по местному времени не
      // совпадал бы с UTC-сутками на сервере (сессии около полуночи
      // проваливались бы не в тот день).
      if (typeof body.startIso !== 'string' || typeof body.endIso !== 'string') {
        return json({ error: 'startIso и endIso обязательны' }, 400);
      }
      const { data, error } = await supabase
        .from('car_sessions')
        .select('*')
        .gte('started_at', body.startIso)
        .lt('started_at', body.endIso)
        .order('started_at', { ascending: false });
      if (error) return json({ error: error.message }, 500);
      return json({ sessions: data ?? [] });
    }

    case 'list_session_events': {
      if (typeof body.sessionId !== 'string') return json({ error: 'sessionId обязателен' }, 400);
      const { data, error } = await supabase
        .from('session_audit_log')
        .select('*')
        .eq('session_id', body.sessionId)
        .order('created_at', { ascending: true });
      if (error) return json({ error: error.message }, 500);
      return json({ events: data ?? [] });
    }

    case 'set_paid': {
      if (typeof body.sessionId !== 'string' || typeof body.paid !== 'boolean') {
        return json({ error: 'sessionId и paid обязательны' }, 400);
      }
      const { error } = await supabase.from('car_sessions').update({ paid: body.paid }).eq('id', body.sessionId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    default:
      return json({ error: 'Неизвестное действие' }, 400);
  }
});
