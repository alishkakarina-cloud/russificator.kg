// Паттерн вход-через-Telegram (токен + вебхук + поллинг) взят из проекта
// Trecker (app/api/telegram-login/*, app/api/telegram-webhook) и адаптирован
// под Electron: открытие t.me-ссылки идёт через системный браузер
// (shell.openExternal), а не через window.open, генерация токена — через
// Edge Function telegram-login-start вместо серверного API-роута Next.js.
// Отличие от Trecker: после подтверждения личности в Telegram доступ не
// открывается сразу — решение принимают администраторы кнопками в боте, и
// клиент продолжает поллинг статуса без тайм-аута, пока не придёт решение.

const { SUPABASE_URL, SUPABASE_ANON_KEY, BOT_USERNAME } = window.APP_CONFIG;
const POLL_INTERVAL_MS = 2500;
const STORAGE_KEY = 'russificator_login_token';

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

async function fetchTokenStatus(token) {
  const rows = await supabaseRequest(
    `telegram_login_tokens?token=eq.${encodeURIComponent(token)}&select=status`
  );
  return rows && rows.length ? rows[0].status : null;
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function applyStatus(status) {
  if (status === 'pending_telegram') {
    waitingText.textContent = 'Нажмите Start в открывшемся чате с ботом...';
  } else if (status === 'pending_admin') {
    waitingText.textContent = 'Ожидание подтверждения администратора...';
  } else if (status === 'approved') {
    stopPolling();
    localStorage.removeItem(STORAGE_KEY);
    showScreen('main');
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
      applyStatus(await fetchTokenStatus(token));
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
    applyStatus('pending_telegram');
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

async function resumeExistingSession() {
  const token = localStorage.getItem(STORAGE_KEY);
  if (!token) {
    showScreen('login');
    return;
  }
  try {
    const status = await fetchTokenStatus(token);
    if (status === 'approved') {
      showScreen('main');
    } else if (status === 'pending_telegram' || status === 'pending_admin') {
      showScreen('waiting');
      applyStatus(status);
      startPolling(token);
    } else {
      localStorage.removeItem(STORAGE_KEY);
      showScreen('login');
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
  status.textContent = 'Запуск...';
  try {
    await window.automaxkg.launch();
    status.textContent = 'AUTOMAX KG запущен в отдельном окне.';
  } catch (err) {
    status.textContent = 'Ошибка запуска: ' + err.message;
  }
});

resumeExistingSession();
