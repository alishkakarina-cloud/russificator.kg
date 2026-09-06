// Вставить в Supabase Dashboard -> Edge Functions -> Create a new function
// (имя функции: automaxkg-key) -> вставить этот код -> Deploy.
// Требует секрет AUTOMAXKG_ENC_MASTER_SECRET (задать один раз через
// `supabase secrets set AUTOMAXKG_ENC_MASTER_SECRET=<случайная длинная строка>`)
// сверх стандартных SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.
//
// Файлы AUTOMAX KG на диске клиента хранятся зашифрованными (AES-256-GCM) —
// ключ никогда не лежит на диске клиента в открытом виде и не зашит в
// приложении. Ключ для КОНКРЕТНОГО устройства выдаётся здесь, каждый раз
// заново, и только если пользователь сейчас реально одобрен и не кикнут —
// точно та же проверка, что и everywhere else в проекте (resolveTelegramUser +
// blocked_telegram_users), не статичный секрет.
//
// Ключ детерминированно выводится из (мастер-секрет + deviceId) через
// HMAC-SHA256 — сервер ничего не хранит по каждому устройству отдельно,
// просто пересчитывает тот же ключ каждый раз. deviceId — случайный
// идентификатор, сгенерированный самим приложением при первом запуске,
// не секрет сам по себе (это как логин, а не пароль) — секретность даёт
// именно мастер-ключ, который никогда не покидает сервер.
//
// Важное следствие такой схемы: у каждого устройства СВОЙ ключ шифрования
// (потому что и производный HMAC свой) — если ключ одного пользователя
// когда-либо утечёт, это расшифрует файлы только НА ЕГО диске, а не у всех
// пользователей сразу.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MASTER_SECRET = Deno.env.get('AUTOMAXKG_ENC_MASTER_SECRET')!;

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

async function isBlocked(telegramId: number) {
  const { data } = await supabase
    .from('blocked_telegram_users')
    .select('telegram_id')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  return Boolean(data);
}

async function deriveKeyHex(deviceId: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(MASTER_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', keyMaterial, new TextEncoder().encode(deviceId));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => null);
  if (!body?.loginToken || !body?.deviceId) {
    return json({ error: 'loginToken и deviceId обязательны' }, 400);
  }

  const user = await resolveTelegramUser(body.loginToken);
  if (!user) return json({ error: 'Сессия входа недействительна' }, 401);

  if (await isBlocked(user.id)) {
    return json({ error: 'Доступ заблокирован администратором' }, 403);
  }

  const key = await deriveKeyHex(body.deviceId);
  return json({ key });
});
