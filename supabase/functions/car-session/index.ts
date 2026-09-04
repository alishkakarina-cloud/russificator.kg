// Вставить в Supabase Dashboard -> Edge Functions -> Create a new function
// (имя функции: car-session) -> вставить этот код -> Deploy.
// Секретов не требует сверх стандартных SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
// (подставляются автоматически).
//
// Все чтения/записи car_sessions идут только отсюда, не напрямую anon-ключом:
// каждый вызов подтверждает личность по loginToken (тому самому токену из
// telegram_login_tokens, который реально подтверждён через вебхук — его
// нельзя подделать, просто зная свой telegram id) и работает только с
// сессиями этого telegram id.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function logEvent(sessionId: string | null, telegramId: number | null, eventType: string, detail?: unknown) {
  await supabase.from('session_audit_log').insert({ session_id: sessionId, telegram_id: telegramId, event_type: eventType, detail: detail ?? null });
}

async function resolveTelegramUser(loginToken: string) {
  const { data } = await supabase
    .from('telegram_login_tokens')
    .select('telegram_user, status')
    .eq('token', loginToken)
    .maybeSingle();
  if (!data || data.status !== 'approved' || !data.telegram_user) return null;
  return data.telegram_user as { id: number; first_name: string; last_name: string | null; username: string | null };
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => null);
  if (!body?.action || !body?.loginToken) {
    return json({ error: 'action и loginToken обязательны' }, 400);
  }

  const user = await resolveTelegramUser(body.loginToken);
  if (!user) {
    return json({ error: 'Сессия входа недействительна' }, 401);
  }

  // Доверенным пользователям (см. admin-panel) клиент не применяет
  // 10-минутный таймер локальной сессии — постоянный доступ на любом их
  // устройстве. telegram_users закрыта от anon-ключа (см. schema.sql), так
  // что проверить статус можно только через service_role здесь.
  if (body.action === 'get_trusted') {
    const { data } = await supabase.from('telegram_users').select('trusted').eq('telegram_id', user.id).maybeSingle();
    return json({ trusted: Boolean(data?.trusted) });
  }

  if (body.action === 'get_active') {
    const { data } = await supabase
      .from('car_sessions')
      .select('id, brand, model, started_at')
      .eq('telegram_id', user.id)
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return json({ session: data ?? null });
  }

  if (body.action === 'start') {
    if (!body.brand || !body.model) return json({ error: 'brand и model обязательны' }, 400);

    // Не даём открыть вторую сессию, пока предыдущая не закрыта "Завершено" —
    // тот же запрет, что и на запуск AUTOMAX KG повторно.
    const { data: existing } = await supabase
      .from('car_sessions')
      .select('id, brand, model, started_at')
      .eq('telegram_id', user.id)
      .is('ended_at', null)
      .maybeSingle();
    if (existing) {
      return json({ error: 'already_active', session: existing }, 409);
    }

    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    const { data, error } = await supabase
      .from('car_sessions')
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
    await logEvent(data.id, user.id, 'session_started', { brand: body.brand, model: body.model });
    return json({ session: data });
  }

  if (body.action === 'finish') {
    if (!body.sessionId) return json({ error: 'sessionId обязателен' }, 400);

    const { data, error } = await supabase
      .from('car_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', body.sessionId)
      .eq('telegram_id', user.id)
      .is('ended_at', null)
      .select()
      .maybeSingle();

    if (error) return json({ error: error.message }, 500);
    if (data) await logEvent(data.id, user.id, 'session_finished', body.detail ?? null);
    return json({ session: data });
  }

  // Общее логирование того, что происходит вне Edge Functions (реальный
  // запуск AUTOMAX KG — отдельный процесс в Electron, сама функция об этом
  // не знает; и истечение локальной 10-минутной сессии — решение клиента).
  // sessionId проверяется на принадлежность этому telegram_id, если указан,
  // чтобы нельзя было залогировать событие в чужую сессию.
  if (body.action === 'log_event') {
    if (typeof body.eventType !== 'string') return json({ error: 'eventType обязателен' }, 400);

    let sessionId: string | null = null;
    if (body.sessionId) {
      const { data: owned } = await supabase
        .from('car_sessions')
        .select('id')
        .eq('id', body.sessionId)
        .eq('telegram_id', user.id)
        .maybeSingle();
      if (!owned) return json({ error: 'Сессия не найдена' }, 404);
      sessionId = owned.id;
    }

    await logEvent(sessionId, user.id, body.eventType, body.detail);
    return json({ ok: true });
  }

  return json({ error: 'Неизвестное действие' }, 400);
});
