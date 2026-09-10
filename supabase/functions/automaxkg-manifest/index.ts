// Вставить в Supabase Dashboard -> Edge Functions -> Create a new function
// (имя функции: automaxkg-manifest) -> вставить этот код -> Deploy.
// Секретов не требует сверх стандартных SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.
//
// AUTOMAX KG (~3 ГБ, приватная бизнес-прошивка) лежит в приватном бакете
// Storage "automaxkg" — публично не раздаётся нигде, в отличие от установщика
// russificator.kg на GitHub. Доступ к файлам получает только тот, кто уже
// прошёл вход через Telegram и был одобрен админом (тот же loginToken, что
// и везде в проекте) — функция сама проверяет статус approved, не доверяя
// ничему, присланному в теле запроса. Возвращает список файлов с короткоживущими
// подписанными ссылками (несколько часов — первая закачка ~3 ГБ может идти
// долго на медленном интернете), по одной ссылке каждый файл скачивает
// напрямую с Supabase Storage, сохраняя относительный путь.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'automaxkg';
const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60; // 6 часов на всю закачку

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Структура AUTOMAX KG глубоко вложенная (tinove/timove/IflytekSpeech/...) —
// раньше подпапки обходились строго по одной (await внутри for), то есть
// время построения манифеста росло с глубиной/шириной дерева как сумма
// отдельных сетевых кругов до Storage API. Здесь все записи текущего уровня
// (и, рекурсивно, их вложенные обходы) запускаются одновременно —
// Promise.all ждёт их все, но сами запросы идут параллельно, а не по очереди.
async function listAllFiles(prefix: string): Promise<{ path: string; size: number }[]> {
  const { data: entries, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error || !entries) return [];

  const groups = await Promise.all(
    entries.map(async (entry): Promise<{ path: string; size: number }[]> => {
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        // Папка (у файлов Supabase Storage всегда проставляет id).
        return listAllFiles(entryPath);
      }
      return [{ path: entryPath, size: entry.metadata?.size ?? 0 }];
    })
  );
  return groups.flat();
}

async function resolveTelegramUser(loginToken: string) {
  const { data } = await supabase
    .from('telegram_login_tokens')
    .select('telegram_user, status')
    .eq('token', loginToken)
    .maybeSingle();
  if (!data || data.status !== 'approved' || !data.telegram_user) return null;
  const user = data.telegram_user as { id: number };
  // approved-токен не истекает сам по себе, а кик (blocked_telegram_users)
  // раньше проверялся только в клиенте и при новом /start в боте — сам
  // запрос сюда с уже выданным токеном никак не блокировался (в т.ч. запрос
  // подписанных ссылок на ~3ГБ приватной прошивки). Теперь кик проверяется
  // на той же границе, что и остальная авторизация: кикнутый получает тот
  // же 401, что и при невалидной сессии.
  const { data: blocked } = await supabase
    .from('blocked_telegram_users')
    .select('telegram_id')
    .eq('telegram_id', user.id)
    .maybeSingle();
  if (blocked) return null;
  return user;
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => null);
  if (!body?.loginToken) return json({ error: 'loginToken обязателен' }, 400);

  const user = await resolveTelegramUser(body.loginToken);
  if (!user) return json({ error: 'Сессия входа недействительна' }, 401);

  // storage.list() отдаёт только один уровень вложенности за раз, а структура
  // AUTOMAX KG вложенная (apk/, tinove/timove/…) — обходим рекурсивно.
  const items = await listAllFiles('');
  if (items.length === 0) return json({ error: 'AUTOMAX KG не найдена в хранилище' }, 500);

  const paths = items.map((i) => i.path);
  const sizeByPath = new Map(items.map((i) => [i.path, i.size]));

  const { data: signed, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);

  if (signError) return json({ error: signError.message }, 500);

  // Размер передаём клиенту, чтобы он мог проверить целостность каждого
  // скачанного файла (сверить фактический размер на диске с ожидаемым) —
  // без этого оборванная на середине закачка осталась бы незамеченной.
  const manifest = signed
    .filter((s) => s.signedUrl && !s.error)
    .map((s) => ({ path: s.path, url: s.signedUrl, size: sizeByPath.get(s.path) ?? 0 }));

  return json({ files: manifest });
});
