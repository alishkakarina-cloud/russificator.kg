// Вставить в Supabase Dashboard -> Edge Functions -> Create a new function
// (имя функции: record-login) -> вставить этот код -> Deploy.
//
// Вызывается клиентом ОДИН раз при каждом новом входе (не при каждом
// возобновлении уже открытой локальной сессии) — записывает город (по IP,
// через бесплатный ip-api.com), сам IP и тип устройства/ОС. Специально
// вызывается напрямую из приложения (а не, например, из telegram-webhook),
// потому что IP нужен именно РЕАЛЬНЫЙ IP пользователя — если бы запись шла
// из telegram-webhook, это был бы IP серверов Telegram, а не человека.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function resolveTelegramUser(loginToken: string) {
  const { data } = await supabase
    .from('telegram_login_tokens')
    .select('telegram_user, status')
    .eq('token', loginToken)
    .maybeSingle();
  if (!data || data.status !== 'approved' || !data.telegram_user) return null;
  return data.telegram_user as { id: number };
}

function clientIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip');
}

async function geoLookup(ip: string | null) {
  if (!ip) return { city: null, country: null };
  try {
    // Бесплатный план ip-api.com — только http, не https.
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,country`);
    const data = await res.json();
    if (data.status !== 'success') return { city: null, country: null };
    return { city: data.city ?? null, country: data.country ?? null };
  } catch {
    return { city: null, country: null };
  }
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => null);
  if (!body?.loginToken) return json({ error: 'loginToken обязателен' }, 400);

  const user = await resolveTelegramUser(body.loginToken);
  if (!user) return json({ error: 'Сессия входа недействительна' }, 401);

  const ip = clientIp(req);
  const { city, country } = await geoLookup(ip);

  await supabase.from('login_history').insert({
    telegram_id: user.id,
    ip,
    city,
    country,
    device: typeof body.device === 'string' ? body.device.slice(0, 200) : null,
  });

  return json({ ok: true });
});
