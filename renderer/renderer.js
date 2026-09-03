const { SUPABASE_URL, SUPABASE_ANON_KEY, BOT_USERNAME } = window.APP_CONFIG;
const POLL_INTERVAL_MS = 2500;
const STORAGE_KEY = 'russificator_session_id';

const screens = {
  login: document.getElementById('screen-login'),
  waiting: document.getElementById('screen-waiting'),
  main: document.getElementById('screen-main'),
};

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

function createLoginRequest(sessionId) {
  return supabaseRequest('login_requests', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      session_id: sessionId,
      method: 'telegram',
      status: 'awaiting_telegram_start',
    }),
  });
}

async function fetchLoginRequestStatus(sessionId) {
  const rows = await supabaseRequest(
    `login_requests?session_id=eq.${encodeURIComponent(sessionId)}&select=status`
  );
  return rows && rows.length ? rows[0].status : null;
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(sessionId) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const status = await fetchLoginRequestStatus(sessionId);
      if (status === 'approved') {
        stopPolling();
        localStorage.setItem(STORAGE_KEY, sessionId);
        showScreen('main');
      } else if (status === 'rejected') {
        stopPolling();
        localStorage.removeItem(STORAGE_KEY);
        document.getElementById('login-status').textContent =
          'Вход отклонён администратором.';
        showScreen('login');
      } else if (status === null) {
        stopPolling();
        localStorage.removeItem(STORAGE_KEY);
        showScreen('login');
      }
      // awaiting_telegram_start / pending_admin — просто продолжаем ждать
    } catch (err) {
      console.error(err);
    }
  }, POLL_INTERVAL_MS);
}

async function beginTelegramLogin() {
  const loginStatus = document.getElementById('login-status');
  loginStatus.textContent = '';
  try {
    const sessionId = crypto.randomUUID();
    await createLoginRequest(sessionId);
    localStorage.setItem(STORAGE_KEY, sessionId);
    await window.app.openExternal(`https://t.me/${BOT_USERNAME}?start=${sessionId}`);
    showScreen('waiting');
    startPolling(sessionId);
  } catch (err) {
    loginStatus.textContent = 'Ошибка входа: ' + err.message;
  }
}

function cancelLogin() {
  stopPolling();
  localStorage.removeItem(STORAGE_KEY);
  showScreen('login');
}

async function resumeExistingSession() {
  const sessionId = localStorage.getItem(STORAGE_KEY);
  if (!sessionId) {
    showScreen('login');
    return;
  }
  try {
    const status = await fetchLoginRequestStatus(sessionId);
    if (status === 'approved') {
      showScreen('main');
    } else if (status === 'awaiting_telegram_start' || status === 'pending_admin') {
      showScreen('waiting');
      startPolling(sessionId);
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
