// Вставить в Supabase Dashboard -> Edge Functions -> Create a new function
// (имя функции: telegram-login-start) -> вставить этот код -> Deploy.
//
// Аналог app/api/telegram-login/start из проекта Trecker: генерирует
// одноразовый токен и заводит по нему запись. Токен создаётся здесь (через
// service_role), а не на клиенте — anon-ключ в приложении может только
// читать статус токена, но не создавать и не менять записи.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// CORS нужен для мобильной веб-админки (admin.russificator.kg) — она вызывает
// эту функцию из настоящего браузера с настоящим Origin, в отличие от
// десктопного приложения (там страница грузится с file://, и Chromium её
// туда не применяет). Без этих заголовков браузер молча блокирует ответ.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const token = crypto.randomUUID();
  const body = await req.json().catch(() => null);
  // purpose: 'login' (обычный вход, сейчас только у админов через Telegram)
  // или 'register' (одноразовое подтверждение личности при регистрации по
  // никнейму/паролю — см. telegram-webhook и register-account).
  const purpose = body?.purpose === 'register' ? 'register' : 'login';

  const { error } = await supabase
    .from('telegram_login_tokens')
    .insert({ token, status: 'pending_telegram', purpose });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  return new Response(JSON.stringify({ token }), {
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
});
