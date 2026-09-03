// Паттерн вход-через-Telegram (токен + вебхук + поллинг) взят из проекта
// Trecker (app/api/telegram-login/*, app/api/telegram-webhook) и адаптирован
// под Electron: открытие t.me-ссылки идёт через системный браузер
// (shell.openExternal), а не через window.open, генерация токена — через
// Edge Function telegram-login-start вместо серверного API-роута Next.js.
// Отличие от Trecker: после подтверждения личности в Telegram доступ не
// открывается сразу — решение принимают администраторы кнопками в боте, и
// клиент продолжает поллинг статуса без тайм-аута, пока не придёт решение.
//
// Поверх этого — локальная сессия на 30 минут (см. main.js/preload.js
// sessionStore, хранится в userData через electron-store): после approved
// повторный запуск в течение получаса сразу открывает главный экран, без
// нового входа. 30 минут — точное значение по ТЗ, не менять.

const { SUPABASE_URL, SUPABASE_ANON_KEY, BOT_USERNAME } = window.APP_CONFIG;
const POLL_INTERVAL_MS = 2500;
const STORAGE_KEY = 'russificator_login_token';
const SESSION_MS = 30 * 60 * 1000;

const screens = {
  login: document.getElementById('screen-login'),
  waiting: document.getElementById('screen-waiting'),
  rejected: document.getElementById('screen-rejected'),
  main: document.getElementById('screen-main'),
};
const waitingText = document.getElementById('waiting-text');
const loginStatus = document.getElementById('login-status');

let pollTimer = null;

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].hidden = key !== name;
  }
}

async function supabaseRequest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

async function startTelegramLoginToken() {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/telegram-login-start`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Не удалось начать вход (${res.status}): ${await res.text()}`);
  }
  const { token } = await res.json();
  return token;
}

async function fetchTokenRow(token) {
  const rows = await supabaseRequest(
    `telegram_login_tokens?token=eq.${encodeURIComponent(token)}&select=status,telegram_user`
  );
  return rows && rows.length ? rows[0] : null;
}

// Кикнут ли этот telegram id (см. /kick, /unkick в telegram-webhook). Сетевая
// ошибка не блокирует локальную сессию — считаем, что не кикнут, и даём
// поработать офлайн; кик подтянется на следующей успешной проверке.
async function isBlocked(telegramId) {
  if (!telegramId) return false;
  const rows = await supabaseRequest(
    `blocked_telegram_users?telegram_id=eq.${telegramId}&select=telegram_id`
  );
  return Boolean(rows && rows.length);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function enterMainScreen(telegramId) {
  if (telegramId) {
    try {
      await window.sessionStore.set({
        telegramId,
        approvedAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionToken: crypto.randomUUID(),
      });
    } catch (err) {
      console.error('Не удалось сохранить локальную сессию', err);
    }
  }
  showScreen('main');
}

function applyStatus(row) {
  const status = row ? row.status : null;
  if (status === 'pending_telegram') {
    waitingText.textContent = 'Нажмите Start в открывшемся чате с ботом...';
  } else if (status === 'pending_admin') {
    waitingText.textContent = 'Ожидание подтверждения администратора...';
  } else if (status === 'approved') {
    stopPolling();
    localStorage.removeItem(STORAGE_KEY);
    enterMainScreen(row.telegram_user && row.telegram_user.id);
  } else if (status === 'rejected') {
    stopPolling();
    localStorage.removeItem(STORAGE_KEY);
    showScreen('rejected');
  } else if (status === null) {
    stopPolling();
    localStorage.removeItem(STORAGE_KEY);
    showScreen('login');
  }
}

function startPolling(token) {
  stopPolling();
  // Без тайм-аута: запрос висит до явного решения администратора.
  pollTimer = setInterval(async () => {
    try {
      applyStatus(await fetchTokenRow(token));
    } catch (err) {
      console.error(err);
    }
  }, POLL_INTERVAL_MS);
}

async function beginTelegramLogin() {
  loginStatus.textContent = '';
  try {
    const token = await startTelegramLoginToken();
    localStorage.setItem(STORAGE_KEY, token);
    await window.app.openExternal(`https://t.me/${BOT_USERNAME}?start=${token}`);
    showScreen('waiting');
    applyStatus({ status: 'pending_telegram' });
    startPolling(token);
  } catch (err) {
    loginStatus.textContent = 'Ошибка входа: ' + err.message;
  }
}

function cancelLogin() {
  stopPolling();
  localStorage.removeItem(STORAGE_KEY);
  showScreen('login');
}

function retryLogin() {
  showScreen('login');
}

// Локальная сессия на этом устройстве (Блок 1/2): если ей меньше 30 минут с
// последней активности и telegram id не в бан-листе на сервере — сразу
// главный экран, без повторного входа и ожидания админа.
async function tryLocalSession() {
  let session;
  try {
    session = await window.sessionStore.get();
  } catch (err) {
    console.error('Не удалось прочитать локальную сессию', err);
    return false;
  }
  if (!session) return false;

  if (Date.now() - session.lastActivityAt > SESSION_MS) {
    await window.sessionStore.clear();
    return false;
  }

  try {
    if (await isBlocked(session.telegramId)) {
      await window.sessionStore.clear();
      return false;
    }
  } catch (err) {
    console.error('Проверка блокировки не удалась, продолжаем офлайн', err);
  }

  await window.sessionStore.touch();
  showScreen('main');
  return true;
}

// Продлевает 30-минутное окно при активности на главном экране (Блок 2.4) и
// одновременно перепроверяет кик на сервере (Блок 3) — так кик срабатывает
// даже внутри уже открытого окна доверия, а не только при следующем запуске.
async function touchSessionOrKick() {
  const session = await window.sessionStore.get();
  if (!session) return true;

  try {
    if (await isBlocked(session.telegramId)) {
      await window.sessionStore.clear();
      showScreen('login');
      return false;
    }
  } catch (err) {
    console.error('Проверка блокировки не удалась, продолжаем офлайн', err);
  }

  await window.sessionStore.touch();
  return true;
}

async function resumeExistingSession() {
  if (await tryLocalSession()) return;

  const token = localStorage.getItem(STORAGE_KEY);
  if (!token) {
    showScreen('login');
    return;
  }
  try {
    const row = await fetchTokenRow(token);
    if (row && (row.status === 'pending_telegram' || row.status === 'pending_admin')) {
      showScreen('waiting');
    }
    applyStatus(row);
    if (row && (row.status === 'pending_telegram' || row.status === 'pending_admin')) {
      startPolling(token);
    }
  } catch (err) {
    console.error(err);
    showScreen('login');
  }
}

document.getElementById('telegram-login-btn').addEventListener('click', beginTelegramLogin);
document.getElementById('cancel-login-btn').addEventListener('click', cancelLogin);
document.getElementById('retry-login-btn').addEventListener('click', retryLogin);

const launchBtn = document.getElementById('launch-btn');
const status = document.getElementById('status');

launchBtn.addEventListener('click', async () => {
  const allowed = await touchSessionOrKick();
  if (!allowed) return;

  status.textContent = 'Запуск...';
  try {
    await window.automaxkg.launch();
    status.textContent = 'AUTOMAX KG запущен в отдельном окне.';
  } catch (err) {
    status.textContent = 'Ошибка запуска: ' + err.message;
  }
});

window.app.getVersion().then((version) => {
  document.getElementById('app-version').textContent = `v${version}`;
});

resumeExistingSession();
