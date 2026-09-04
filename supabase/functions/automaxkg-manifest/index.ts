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

async function listAllFiles(prefix: string): Promise<{ path: string; size: number }[]> {
  const { data: entries, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error || !entries) return [];

  const files: { path: string; size: number }[] = [];
  for (const entry of entries) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id === null) {
      // Папка (у файлов Supabase Storage всегда проставляет id).
      files.push(...(await listAllFiles(entryPath)));
    } else {
      files.push({ path: entryPath, size: entry.metadata?.size ?? 0 });
    }
  }
  return files;
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
