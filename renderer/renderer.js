// Паттерн вход-через-Telegram (токен + вебхук + поллинг) взят из проекта
// Trecker и адаптирован под Electron (shell.openExternal вместо window.open).
// Поверх — админ-подтверждение (или авто-approve для доверенных / авто-reject
// для кикнутых), локальная 10-минутная сессия устройства, и учёт сессий
// работы с конкретной машиной (car_sessions) с защитой от прерывания, пока
// сессия активна.

const { SUPABASE_URL, SUPABASE_ANON_KEY, BOT_USERNAME } = window.APP_CONFIG;
const POLL_INTERVAL_MS = 2500;
const STORAGE_KEY = 'russificator_login_token';
const SESSION_MS = 10 * 60 * 1000;

const screens = {
  login: document.getElementById('screen-login'),
  register: document.getElementById('screen-register'),
  forcedUpdate: document.getElementById('screen-forced-update'),
  waiting: document.getElementById('screen-waiting'),
  rejected: document.getElementById('screen-rejected'),
  downloading: document.getElementById('screen-downloading'),
  main: document.getElementById('screen-main'),
  terminal: document.getElementById('screen-terminal'),
  support: document.getElementById('screen-support'),
  admin: document.getElementById('screen-admin'),
};
const waitingText = document.getElementById('waiting-text');
const loginStatus = document.getElementById('login-status');
const status = document.getElementById('status');

let pollTimer = null;
// Пока это не null — кик/истечение сессии не разлогинивают принудительно
// (см. touchSessionOrKick), только "Завершено" её закрывает.
let activeCarSession = null;

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

async function callFunction(name, body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `${name} ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const carSession = (action, payload) => callFunction('car-session', { action, ...payload });
const adminAction = (action, payload) => callFunction('admin-action', { action, ...payload });

async function startTelegramLoginToken(purpose = 'login') {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/telegram-login-start`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ purpose }),
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

// ------------------------------- Локальная сессия -------------------------------

const downloadProgressFill = document.getElementById('download-progress-fill');
const downloadProgressText = document.getElementById('download-progress-text');
const downloadErrorEl = document.getElementById('download-error');
const downloadRetryBtn = document.getElementById('download-retry-btn');
let pendingLoginToken = null;

window.automaxkg.onDownloadProgress(({ done, total }) => {
  if (!total) return;
  const pct = Math.round((done / total) * 100);
  downloadProgressFill.style.width = pct + '%';
  downloadProgressText.textContent = `Скачано ${done} из ${total} файлов (${pct}%)`;
});

// Перед первым показом главного экрана проверяет, есть ли уже AUTOMAX KG на
// этом компьютере (в userData/runtime-data). На новой машине их там нет —
// список файлов с приватного хранилища и подписанные ссылки на скачивание
// выдаёт automaxkg-manifest, доступ к которой есть только у вошедшего и
// одобренного пользователя (проверяется на сервере по loginToken).
// deviceId — стабильный случайный идентификатор ЭТОГО компьютера (хранится
// в main.js через electron-store, не привязан к логину) — сервер выводит из
// него свой ключ шифрования для этого устройства (automaxkg-key), поэтому
// у каждого устройства свой ключ, а не один общий на всех.
let cachedDeviceId = null;
async function getCachedDeviceId() {
  if (!cachedDeviceId) cachedDeviceId = await window.automaxkg.getDeviceId();
  return cachedDeviceId;
}

// Ключ шифрования никогда не хранится на диске — запрашивается заново с
// сервера каждый раз, когда реально нужен (первое скачивание/шифрование на
// месте/расшифровка перед запуском). Сервер сам проверяет, что loginToken
// сейчас approved и не кикнут — см. automaxkg-key.
async function fetchEncryptionKey(loginToken) {
  const deviceId = await getCachedDeviceId();
  const { key } = await callFunction('automaxkg-key', { loginToken, deviceId });
  return key;
}

async function ensureAutomaxKgReady(loginToken) {
  const { available, needsEncryption } = await window.automaxkg.status();
  if (available) return true;

  pendingLoginToken = loginToken;
  showScreen('downloading');
  downloadErrorEl.hidden = true;
  downloadRetryBtn.hidden = true;
  downloadProgressFill.style.width = '0%';

  try {
    if (needsEncryption) {
      // Файлы уже были скачаны раньше, до появления шифрования — шифруем их
      // на месте, без повторного скачивания ~3ГБ с нуля.
      downloadProgressText.textContent = 'Защищаем файлы на диске (один раз)...';
      const key = await fetchEncryptionKey(loginToken);
      const result = await window.automaxkg.encryptExisting(key);
      if (!result.ok) throw new Error(result.error);
      return true;
    }

    downloadProgressText.textContent = 'Подготовка списка файлов...';
    const { files } = await callFunction('automaxkg-manifest', { loginToken });
    downloadProgressText.textContent = `Скачано 0 из ${files.length} файлов (0%)`;
    const key = await fetchEncryptionKey(loginToken);
    const result = await window.automaxkg.download(files, key);
    if (!result.ok) throw new Error(result.error);
    return true;
  } catch (err) {
    downloadErrorEl.hidden = false;
    downloadErrorEl.textContent = 'Ошибка: ' + err.message;
    downloadRetryBtn.hidden = false;
    return false;
  }
}

downloadRetryBtn.addEventListener('click', async () => {
  if (await ensureAutomaxKgReady(pendingLoginToken)) {
    showScreen('main');
    await initMainScreen();
  }
});

async function enterMainScreen(telegramId, loginToken) {
  if (telegramId) {
    try {
      await window.sessionStore.set({
        telegramId,
        loginToken,
        approvedAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionToken: crypto.randomUUID(),
      });
    } catch (err) {
      console.error('Не удалось сохранить локальную сессию', err);
    }

    // Запись входа (город по IP + устройство) — один раз именно здесь,
    // при НОВОМ входе, а не при каждом resume уже открытой локальной
    // сессии (см. tryLocalSession — там этот вызов намеренно отсутствует).
    try {
      const device = await window.app.getDeviceInfo();
      await callFunction('record-login', { loginToken, device });
    } catch (err) {
      console.error('Не удалось записать вход в историю', err);
    }
  }
  if (!(await ensureAutomaxKgReady(loginToken))) return;
  showScreen('main');
  await initMainScreen();
}

function applyStatus(row) {
  const status_ = row ? row.status : null;
  if (status_ === 'pending_telegram') {
    waitingText.textContent = 'Нажмите Start в открывшемся чате с ботом...';
  } else if (status_ === 'pending_admin') {
    waitingText.textContent = 'Ожидание подтверждения администратора...';
  } else if (status_ === 'approved') {
    stopPolling();
    const token = localStorage.getItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);
    enterMainScreen(row.telegram_user && row.telegram_user.id, token);
  } else if (status_ === 'rejected') {
    stopPolling();
    localStorage.removeItem(STORAGE_KEY);
    showScreen('rejected');
  } else if (status_ === null) {
    stopPolling();
    localStorage.removeItem(STORAGE_KEY);
    showScreen('login');
  }
}

function startPolling(token) {
  stopPolling();
  // Без тайм-аута: запрос висит до явного решения администратора (или до
  // мгновенного авто-approve/reject для доверенных/кикнутых).
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

// ------------------------- Вход по никнейму/паролю -------------------------
// Обычный путь для всех, кроме админов (они по-прежнему жмут "Войти через
// Telegram" ниже). Выданный login-account токен — обычный approved
// loginToken, вся остальная логика приложения не отличает, как он получен.

async function loginWithPassword() {
  const nicknameEl = document.getElementById('login-nickname');
  const passwordEl = document.getElementById('login-password');
  const statusEl = document.getElementById('login-password-status');
  const btn = document.getElementById('login-password-btn');

  const nickname = nicknameEl.value.trim();
  const password = passwordEl.value;
  statusEl.textContent = '';
  if (!nickname || !password) {
    statusEl.textContent = 'Заполните никнейм и пароль';
    return;
  }

  btn.disabled = true;
  try {
    const { token } = await callFunction('login-account', { nickname, password });
    const row = await fetchTokenRow(token);
    await enterMainScreen(row?.telegram_user?.id, token);
  } catch (err) {
    statusEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------ Регистрация ------------------------------
// Юзернейм проверяется на сервере по whitelist (Блок 1) — сначала разовое
// подтверждение личности через Telegram (без ручного одобрения админом),
// затем сразу создаётся учётная запись и человек оказывается внутри,
// минуя отдельный повторный вход.

let registerPollTimer = null;

function stopRegisterPolling() {
  if (registerPollTimer) {
    clearInterval(registerPollTimer);
    registerPollTimer = null;
  }
}

function showRegisterScreen() {
  document.getElementById('register-form').hidden = false;
  document.getElementById('register-waiting').hidden = true;
  document.getElementById('register-status').textContent = '';
  document.getElementById('register-username').value = '';
  document.getElementById('register-nickname').value = '';
  document.getElementById('register-password').value = '';
  showScreen('register');
}

function backFromRegister() {
  stopRegisterPolling();
  showScreen('login');
}

async function startRegistration() {
  const usernameEl = document.getElementById('register-username');
  const nicknameEl = document.getElementById('register-nickname');
  const passwordEl = document.getElementById('register-password');
  const statusEl = document.getElementById('register-status');
  const formEl = document.getElementById('register-form');
  const waitingEl = document.getElementById('register-waiting');
  const waitingTextEl = document.getElementById('register-waiting-text');

  const username = usernameEl.value.trim().replace(/^@/, '');
  const nickname = nicknameEl.value.trim();
  const password = passwordEl.value;

  statusEl.textContent = '';
  if (!username) {
    statusEl.textContent = 'Введите Telegram-юзернейм';
    return;
  }
  if (nickname.length < 3) {
    statusEl.textContent = 'Никнейм — не короче 3 символов';
    return;
  }
  if (password.length < 6) {
    statusEl.textContent = 'Пароль — не короче 6 символов';
    return;
  }

  const activateBtn = document.getElementById('register-activate-btn');
  activateBtn.disabled = true;
  try {
    const token = await startTelegramLoginToken('register');
    await window.app.openExternal(`https://t.me/${BOT_USERNAME}?start=${token}`);
    formEl.hidden = true;
    waitingEl.hidden = false;
    waitingTextEl.textContent = 'Откройте Telegram и нажмите Start, чтобы подтвердить...';

    stopRegisterPolling();
    registerPollTimer = setInterval(async () => {
      let row;
      try {
        row = await fetchTokenRow(token);
      } catch (err) {
        return; // сетевой сбой при опросе — пробуем на следующем тике, не прерываем
      }
      if (!row) return;

      if (row.status === 'registration_confirmed') {
        stopRegisterPolling();
        waitingTextEl.textContent = 'Подтверждено — создаём учётную запись...';
        try {
          const { token: newToken } = await callFunction('register-account', { loginToken: token, nickname, password });
          await enterMainScreen(row.telegram_user?.id, newToken);
        } catch (err) {
          formEl.hidden = false;
          waitingEl.hidden = true;
          statusEl.textContent = err.message;
        }
      } else if (row.status === 'rejected') {
        stopRegisterPolling();
        formEl.hidden = false;
        waitingEl.hidden = true;
        statusEl.textContent = 'Отказано: юзернейм не в списке разрешённых или доступ заблокирован.';
      }
    }, POLL_INTERVAL_MS);
  } catch (err) {
    statusEl.textContent = 'Ошибка: ' + err.message;
    formEl.hidden = false;
    waitingEl.hidden = true;
  } finally {
    activateBtn.disabled = false;
  }
}

// Доверенным пользователям (админ-панель -> Пользователи -> "Доверенный")
// 10-минутный таймер не применяется — постоянный доступ без повторного
// входа. Кик по-прежнему действует на них так же, как на всех — trusted
// отключает только этот один конкретный путь разлогина, не оба.
async function isTrustedUser(loginToken) {
  try {
    const result = await carSession('get_trusted', { loginToken });
    return Boolean(result.trusted);
  } catch (err) {
    console.error('Проверка доверенного статуса не удалась, действуем как для обычного пользователя', err);
    return false;
  }
}

async function tryLocalSession() {
  let session;
  try {
    session = await window.sessionStore.get();
  } catch (err) {
    console.error('Не удалось прочитать локальную сессию', err);
    return false;
  }
  if (!session) return false;

  const trusted = await isTrustedUser(session.loginToken);

  if (!trusted && Date.now() - session.lastActivityAt > SESSION_MS) {
    // loginToken остаётся approved на сервере навсегда — 10 минут это только
    // локальное доверие устройству, поэтому залогировать событие всё ещё
    // можно тем же токеном.
    await carSession('log_event', {
      loginToken: session.loginToken,
      eventType: 'session_expired',
      detail: { lastActivityAt: session.lastActivityAt },
    }).catch((e) => console.error('Не удалось залогировать истечение сессии', e));
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

  // Раньше здесь стоял sessionStore.touch() — "продлевал" 10-минутное окно
  // при каждом резюме приложения. Убрано намеренно: таймер должен идти
  // строго от момента входа, не сбрасываясь ни от чего, включая повторное
  // открытие приложения в рамках этих 10 минут.
  if (await ensureAutomaxKgReady(session.loginToken)) {
    showScreen('main');
    await initMainScreen();
  }
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

// ------------------------------- Главный экран -------------------------------

const carDropdownBtn = document.getElementById('car-dropdown-btn');
const carDropdownList = document.getElementById('car-dropdown-list');
const carPicker = document.getElementById('car-picker');
const activeSessionBox = document.getElementById('active-session');
const activeSessionLabel = document.getElementById('active-session-label');
const finishBtn = document.getElementById('finish-session-btn');
const adminOpenBtn = document.getElementById('admin-open-btn');

const terminalFinishBtn = document.getElementById('finish-terminal-btn');
const terminalCarLabel = document.getElementById('terminal-car-label');
const terminalContainer = document.getElementById('terminal-container');
const terminalStatus = document.getElementById('terminal-status');

// ------------------------- Встроенный терминал AUTOMAX KG -------------------------
// AUTOMAX KG больше не открывается отдельным окном ОС — она запускается как
// управляемый дочерний процесс (node-pty) в main-процессе, а её вывод и ввод
// зеркалятся сюда через xterm.js. Сама AUTOMAX KG (её .bat, её меню) не
// меняется — меняется только способ показа: встроенный терминал вместо
// отдельного окна. Никакой автоматизации ввода нет — что пользователь
// нажимает, то и уходит процессу напрямую.

let term = null;
let fitAddon = null;

// Регистрируем ОДИН раз при загрузке, а не при каждом входе в терминал —
// иначе при повторных заходах слушатели накапливались бы и один и тот же
// вывод дублировался бы на экране несколько раз подряд.
window.automaxkg.onTerminalData((data) => {
  if (term) term.write(data);
});
window.automaxkg.onTerminalExit(({ exitCode }) => {
  if (term) term.write(`\r\n\r\n[Процесс AUTOMAX KG завершён, код выхода ${exitCode}]\r\n`);
});

function handleTerminalResize() {
  if (!term || !fitAddon) return;
  fitAddon.fit();
  window.automaxkg.resizeTerminal(term.cols, term.rows);
}

async function enterTerminalScreen(carSess, loginToken) {
  await window.app.setTerminalMode(true);
  showScreen('terminal');
  terminalCarLabel.textContent = `${carSess.brand} ${carSess.model}`;
  terminalStatus.textContent = '';

  terminalContainer.innerHTML = '';
  term = new Terminal({
    convertEol: true,
    fontSize: 14,
    theme: { background: '#0d0f14', foreground: '#e8e8e8' },
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(terminalContainer);
  fitAddon.fit();
  // Каждое нажатие клавиши уходит процессу как есть — это просто
  // "окно-зеркало" на управляемый процесс, без разбора смысла ввода/вывода.
  term.onData((data) => window.automaxkg.sendInput(data));
  window.addEventListener('resize', handleTerminalResize);

  // Ключ запрашивается заново перед КАЖДЫМ запуском (не переиспользуем
  // старый) — сервер каждый раз заново проверяет, что сессия всё ещё
  // approved и пользователь не кикнут, прежде чем его выдать. Затем main.js
  // расшифровывает файлы во временную рабочую копию — это занимает
  // заметное время (~20 сек на 3ГБ на обычном SSD), поэтому явно показываем
  // статус, а не оставляем пустой экран.
  terminalStatus.textContent = 'Подготовка AUTOMAX KG...';
  let key;
  try {
    key = await fetchEncryptionKey(loginToken);
  } catch (err) {
    term.write(`\r\n[Не удалось получить ключ доступа: ${err.message}]\r\n`);
    terminalStatus.textContent = 'Не удалось получить ключ доступа: ' + err.message;
    return;
  }

  const result = await window.automaxkg.startTerminal(term.cols, term.rows, key);
  terminalStatus.textContent = '';
  if (!result.ok) {
    term.write(`\r\n[Ошибка запуска AUTOMAX KG: ${result.error}]\r\n`);
    terminalStatus.textContent = 'Не удалось запустить AUTOMAX KG: ' + result.error;
    await carSession('log_event', {
      loginToken,
      sessionId: carSess.id,
      eventType: 'automaxkg_launch_error',
      detail: { error: result.error },
    }).catch((e) => console.error('Не удалось залогировать ошибку запуска', e));
    return;
  }

  await carSession('log_event', {
    loginToken,
    sessionId: carSess.id,
    eventType: 'automaxkg_launched',
  }).catch((e) => console.error('Не удалось залогировать запуск', e));
}

// ------------------------- Видимый таймер сессии (10 минут) -------------------------
// Раньше 10-минутный лимит проверялся только в момент входа/резюме — пока
// приложение оставалось открытым, ничего не мешало сидеть в нём (и работать
// с AUTOMAX KG) сколько угодно. Теперь лимит соблюдается всё время, пока
// приложение открыто, и виден пользователю как обратный отсчёт — одинаково
// на экране выбора марки и во встроенном терминале (элемент не привязан ни
// к одному .screen, см. styles.css).
//
// СОЗНАТЕЛЬНОЕ РЕШЕНИЕ, НЕ БАГ: по истечении таймера AUTOMAX KG закрывается
// принудительно, даже если в этот момент идёт активная запись прошивки в
// машину. Раньше (и всё ещё для кика администратором) активный процесс
// нарочно не трогался — здесь это правило намеренно нарушено по прямому
// требованию владельца бизнеса, который осознанно принял риск прерывания
// записи ради жёсткого лимита сессии. НЕ "исправлять" это молча обратно на
// более безопасное поведение (например, ждать завершения активной сессии)
// — если понадобится другая логика, это отдельная осознанная задача.

const sessionTimerEl = document.getElementById('session-timer');
const sessionTimerText = document.getElementById('session-timer-text');
let sessionTimerInterval = null;

function stopSessionTimer() {
  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }
  sessionTimerEl.hidden = true;
}

function startSessionTimer(trusted) {
  stopSessionTimer();
  if (trusted) return; // у доверенных истечения нет — таймер не нужен и не показывается

  sessionTimerEl.hidden = false;
  sessionTimerInterval = setInterval(sessionTimerTick, 1000);
  sessionTimerTick();
}

async function sessionTimerTick() {
  const session = await window.sessionStore.get();
  if (!session) {
    stopSessionTimer();
    stopHeartbeat();
    stopKickPoll();
    return;
  }

  const remainingMs = session.lastActivityAt + SESSION_MS - Date.now();
  if (remainingMs <= 0) {
    await forceExpireSession(session);
    return;
  }

  const totalSec = Math.ceil(remainingMs / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  sessionTimerText.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
  sessionTimerEl.classList.toggle('warn', totalSec <= 60);
}

// Принудительное завершение по истечении таймера — единственный случай,
// когда AUTOMAX KG закрывается насильно во время реальной работы (см.
// комментарий выше). Отличается от обычного "Завершено" пометкой в базе
// (reason: 'timer_expired'), чтобы в истории сессий было видно, что это не
// человек сам завершил работу, а сработал лимит времени.
async function forceExpireSession(session) {
  stopSessionTimer();
  stopHeartbeat();
  stopKickPoll();

  await window.automaxkg.killTerminal().catch((e) => console.error('Не удалось завершить AUTOMAX KG при истечении таймера', e));
  window.removeEventListener('resize', handleTerminalResize);
  if (term) {
    term.dispose();
    term = null;
    fitAddon = null;
  }

  if (activeCarSession) {
    await carSession('finish', {
      loginToken: session.loginToken,
      sessionId: activeCarSession.id,
      detail: { auto: true, reason: 'timer_expired' },
    }).catch((e) => console.error('Не удалось закрыть сессию при истечении таймера', e));
    activeCarSession = null;
  }

  await carSession('log_event', {
    loginToken: session.loginToken,
    eventType: 'session_expired',
    detail: { lastActivityAt: session.lastActivityAt, forced: true },
  }).catch((e) => console.error('Не удалось залогировать истечение сессии', e));

  await window.sessionStore.clear();
  await window.app.setTerminalMode(false).catch(() => {});
  showScreen('login');
}

// ------------------------- Мгновенный кик (Блок 5) -------------------------
// СОЗНАТЕЛЬНОЕ РЕШЕНИЕ, НЕ БАГ: кик из админ-панели принудительно закрывает
// AUTOMAX KG на машине пользователя, даже если в этот момент идёт активная
// запись на блок управления по USB/OBD. Риск подтверждён пользователем
// (владельцем продукта) явно и повторно перед реализацией. Отличается от
// forceExpireSession (истечение таймера) тем, что опрашивается гораздо чаще
// (каждые 5 секунд, а не через 1-секундный тик таймера сессии) и действует
// независимо от того, доверенный пользователь или нет — таймера у доверенных
// нет, но кик должен работать для всех.
const KICK_POLL_INTERVAL_MS = 5 * 1000;
let kickPollTimer = null;

function stopKickPoll() {
  if (kickPollTimer) {
    clearInterval(kickPollTimer);
    kickPollTimer = null;
  }
}

function startKickPoll() {
  stopKickPoll();
  kickPollTimer = setInterval(kickPollTick, KICK_POLL_INTERVAL_MS);
}

async function kickPollTick() {
  const session = await window.sessionStore.get();
  if (!session) {
    stopKickPoll();
    return;
  }
  let blocked = false;
  try {
    blocked = await isBlocked(session.telegramId);
  } catch (err) {
    console.error('Не удалось проверить статус блокировки (кик)', err);
    return;
  }
  if (blocked) {
    await forceKickSession(session);
  }
}

async function forceKickSession(session) {
  stopSessionTimer();
  stopHeartbeat();
  stopKickPoll();

  await window.automaxkg.killTerminal().catch((e) => console.error('Не удалось завершить AUTOMAX KG при кике', e));
  window.removeEventListener('resize', handleTerminalResize);
  if (term) {
    term.dispose();
    term = null;
    fitAddon = null;
  }

  if (activeCarSession) {
    await carSession('finish', {
      loginToken: session.loginToken,
      sessionId: activeCarSession.id,
      detail: { auto: true, reason: 'kicked' },
    }).catch((e) => console.error('Не удалось закрыть сессию при кике', e));
    activeCarSession = null;
  }

  await window.sessionStore.clear();
  await window.app.setTerminalMode(false).catch(() => {});
  showScreen('login');
}

let carModelsCache = null;

async function loadCarModels() {
  if (carModelsCache) return carModelsCache;
  carModelsCache = await supabaseRequest('car_models?select=*&order=sort_order.asc');
  return carModelsCache;
}

async function toggleCarDropdown() {
  if (!carDropdownList.hidden) {
    carDropdownList.hidden = true;
    return;
  }
  const models = await loadCarModels();
  carDropdownList.innerHTML = '';
  for (const m of models) {
    const item = document.createElement('div');
    item.className = 'dropdown-item';
    item.innerHTML = `<span>${m.brand} ${m.model}</span><span class="price">${m.price} сом</span>`;
    item.addEventListener('click', () => selectCarModel(m));
    carDropdownList.appendChild(item);
  }
  carDropdownList.hidden = false;
}

document.addEventListener('click', (e) => {
  if (!carPicker.contains(e.target)) carDropdownList.hidden = true;
});

async function selectCarModel(model) {
  carDropdownList.hidden = true;
  const session = await window.sessionStore.get();
  if (!session) {
    showScreen('login');
    return;
  }
  status.textContent = 'Запуск...';
  try {
    const { session: carSess } = await carSession('start', {
      loginToken: session.loginToken,
      brand: model.brand,
      model: model.model,
    });
    activeCarSession = carSess;
    status.textContent = '';
    await enterTerminalScreen(carSess, session.loginToken);
  } catch (err) {
    if (err.status === 409 && err.data && err.data.session) {
      activeCarSession = err.data.session;
      renderActiveSession();
      status.textContent = 'Уже есть незавершённая работа — сначала нажмите «Завершено».';
    } else {
      status.textContent = 'Ошибка: ' + err.message;
    }
  }
}

function renderActiveSession() {
  if (activeCarSession) {
    carPicker.hidden = true;
    activeSessionBox.hidden = false;
    activeSessionLabel.textContent = `${activeCarSession.brand} ${activeCarSession.model}`;
    finishBtn.hidden = false;
  } else {
    carPicker.hidden = false;
    activeSessionBox.hidden = true;
    finishBtn.hidden = true;
  }
}

async function finishSession() {
  if (!activeCarSession) return;
  const session = await window.sessionStore.get();
  if (!session) return;
  finishBtn.disabled = true;
  terminalFinishBtn.disabled = true;
  try {
    // Раньше AUTOMAX KG была независимым окном ОС — "Завершено" только
    // фиксировало время в базе. Теперь это наш дочерний процесс, и мы можем
    // его аккуратно закрыть — но только по этому явному действию человека
    // (killTerminal — не-op, если терминал не был открыт, например при
    // восстановлении зависшей сессии после перезапуска приложения).
    await window.automaxkg.killTerminal().catch((e) => console.error('Не удалось завершить процесс AUTOMAX KG', e));
    window.removeEventListener('resize', handleTerminalResize);
    if (term) {
      term.dispose();
      term = null;
      fitAddon = null;
    }

    await carSession('finish', { loginToken: session.loginToken, sessionId: activeCarSession.id });
    activeCarSession = null;

    // "Завершено" теперь означает конец сессии целиком, а не просто "выбери
    // следующую марку" — пользователь возвращается на экран входа через
    // Telegram и должен пройти его заново (для доверенных — тот же экран,
    // но одобрение проходит автоматически, как и раньше). Останавливаем
    // таймер здесь как обычное следствие выхода из системы, а не как
    // отдельное "продление/сброс" — сам счётчик всё равно больше не нужен,
    // раз пользователь уходит с рабочего экрана.
    stopSessionTimer();
    stopHeartbeat();
    stopKickPoll();
    await window.sessionStore.clear();
    await window.app.setTerminalMode(false);
    showScreen('login');
  } catch (err) {
    status.textContent = 'Не удалось завершить: ' + err.message;
    terminalStatus.textContent = 'Не удалось завершить: ' + err.message;
  } finally {
    finishBtn.disabled = false;
    terminalFinishBtn.disabled = false;
  }
}

async function initMainScreen() {
  // Кнопка "Админ панель" видна всем — доступ к содержимому проверяет сервер
  // (admin-action) по фактическим правам, независимо от того, кто её видит.
  const session = await window.sessionStore.get();
  activeCarSession = null;
  if (session) {
    try {
      const { session: stale } = await carSession('get_active', { loginToken: session.loginToken });
      // initMainScreen вызывается только при входе/резюме или после закрытия
      // админ-панели — то есть никогда в момент, когда встроенный терминал
      // реально открыт в этом же запуске приложения (выбор марки сразу
      // переключает на screen-terminal, а не сюда). Значит любая найденная
      // здесь незавершённая car_session — гарантированно "хвост" от
      // предыдущего запуска (например окно закрыли, не нажав "Завершено"),
      // а не то, что пользователь выбрал сейчас. Раньше это ошибочно
      // показывалось как "уже идёт работа с X Y", из-за чего экран выбора
      // марки пропускался — выглядело как автовыбор марки при входе.
      // Экран выбора должен показываться всегда — тихо закрываем такой хвост
      // сами, не заставляя пользователя вручную жать "Завершено" за сессию,
      // которую он мог даже не видеть.
      if (stale) {
        await carSession('finish', {
          loginToken: session.loginToken,
          sessionId: stale.id,
          detail: { auto: true, reason: 'stale_on_resume' },
        }).catch((e) => console.error('Не удалось автоматически закрыть зависшую сессию', e));
      }
    } catch (err) {
      console.error('Не удалось проверить активную сессию', err);
    }

    startSessionTimer(await isTrustedUser(session.loginToken));
    startHeartbeat(session.loginToken);
    startKickPoll();
  } else {
    stopSessionTimer();
    stopHeartbeat();
    stopKickPoll();
  }
  renderActiveSession();
}

// ------------------------------ Онлайн-статус ------------------------------
// Каждые HEARTBEAT_INTERVAL_MS, пока приложение открыто с активной сессией
// (не только на главном экране — и во встроенном терминале тоже, поэтому
// запускается из initMainScreen так же, как и таймер сессии, а не
// привязано к конкретному экрану). "Онлайн" в админ-панели — это просто
// "последний heartbeat был недавно", отдельного статуса на сервере нет.
const HEARTBEAT_INTERVAL_MS = 45 * 1000;
let heartbeatInterval = null;

function startHeartbeat(loginToken) {
  stopHeartbeat();
  const send = () => callFunction('heartbeat', { loginToken }).catch((e) => console.error('heartbeat не прошёл', e));
  send();
  heartbeatInterval = setInterval(send, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

carDropdownBtn.addEventListener('click', toggleCarDropdown);
finishBtn.addEventListener('click', finishSession);
terminalFinishBtn.addEventListener('click', finishSession);

document.getElementById('telegram-login-btn').addEventListener('click', beginTelegramLogin);
document.getElementById('cancel-login-btn').addEventListener('click', cancelLogin);
document.getElementById('retry-login-btn').addEventListener('click', retryLogin);

document.getElementById('login-password-btn').addEventListener('click', loginWithPassword);
document.getElementById('login-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loginWithPassword();
});
document.getElementById('show-register-btn').addEventListener('click', showRegisterScreen);
document.getElementById('register-activate-btn').addEventListener('click', startRegistration);
document.getElementById('register-back-btn').addEventListener('click', backFromRegister);
document.getElementById('register-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startRegistration();
});

// ------------------------- Обновление: кнопка на входе + принудительный экран -------------------------
// electron-updater только проверяет наличие обновления сам при старте
// (autoDownload выключен в main.js) — саму докачку запускает явный клик по
// кнопке, а не молча в фоне. Два места, где может понадобиться кнопка
// докачки: необязательная "Доступно новое обновление" на обычном экране
// входа, и обязательная на экране принудительного обновления (см.
// checkForcedUpdate ниже) — обе используют один и тот же прогресс/ошибку.

const updateBtn = document.getElementById('update-available-btn');
const updateBtnProgress = document.getElementById('update-btn-progress');
const updateBtnSubtitle = document.getElementById('update-btn-subtitle');
const forcedUpdateBtn = document.getElementById('forced-update-btn');
const forcedUpdateBtnProgress = document.getElementById('forced-update-btn-progress');
const forcedUpdateBtnSubtitle = document.getElementById('forced-update-btn-subtitle');
let updateDownloadInProgress = false;

function showUpdateAvailable() {
  if (updateDownloadInProgress) return;
  updateBtn.hidden = false;
  updateBtnSubtitle.textContent = 'Скачать';
  updateBtnProgress.style.width = '0%';
}

function hideUpdateAvailable() {
  if (updateDownloadInProgress) return;
  updateBtn.hidden = true;
}

function applyUpdateStatus(status) {
  if (status && status.available) showUpdateAvailable();
  else hideUpdateAvailable();
}

window.app.getUpdateStatus().then(applyUpdateStatus);
window.app.onUpdateStatusChanged(applyUpdateStatus);

window.app.onUpdateDownloadProgress(({ percent }) => {
  const pct = Math.round(percent);
  const text = `Скачивание... ${pct}%`;
  updateBtnProgress.style.width = `${pct}%`;
  updateBtnSubtitle.textContent = text;
  forcedUpdateBtnProgress.style.width = `${pct}%`;
  forcedUpdateBtnSubtitle.textContent = text;
});

window.app.onUpdateDownloadError(() => {
  updateDownloadInProgress = false;
  document.getElementById('telegram-login-btn').disabled = false;
  updateBtn.disabled = false;
  updateBtnSubtitle.textContent = 'Ошибка скачивания — нажмите ещё раз';
  updateBtnProgress.style.width = '0%';
  forcedUpdateBtn.disabled = false;
  forcedUpdateBtnSubtitle.textContent = 'Ошибка скачивания — нажмите ещё раз';
  forcedUpdateBtnProgress.style.width = '0%';
});

async function startUpdateDownloadFlow() {
  if (updateDownloadInProgress) return;
  updateDownloadInProgress = true;
  updateBtn.disabled = true;
  forcedUpdateBtn.disabled = true;
  document.getElementById('telegram-login-btn').disabled = true;
  updateBtnSubtitle.textContent = 'Скачивание... 0%';
  updateBtnProgress.style.width = '0%';
  forcedUpdateBtnSubtitle.textContent = 'Скачивание... 0%';
  forcedUpdateBtnProgress.style.width = '0%';
  await window.app.startUpdateDownload();
  // Дальше либо придёт update-download-progress -> ... -> приложение само
  // перезапустится (quitAndInstall в main.js), либо update-download-error,
  // если что-то пошло не так — обработчик выше вернёт кнопки в рабочее
  // состояние.
}

updateBtn.addEventListener('click', startUpdateDownloadFlow);
forcedUpdateBtn.addEventListener('click', startUpdateDownloadFlow);

// ------------------------- Принудительное обновление (min_version) -------------------------
// Минимально разрешённая версия хранится в Supabase (app_settings) — это
// сознательно НЕ то же самое, что "Доступно новое обновление" выше: та
// кнопка — вежливое предложение, эта проверка — жёсткий запрет запускать
// программу младше min_version вообще, до самого экрана входа. Значение
// по умолчанию (1.0.0) никого не блокирует — поднимается вручную в базе,
// когда реально нужно заставить всех обновиться.
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

async function checkForcedUpdate() {
  try {
    const rows = await supabaseRequest('app_settings?key=eq.min_version&select=value');
    const minVersion = rows && rows[0] ? rows[0].value : null;
    if (!minVersion) return false;

    const currentVersion = await window.app.getVersion();
    if (compareVersions(currentVersion, minVersion) < 0) {
      showScreen('forcedUpdate');
      return true;
    }
  } catch (err) {
    // Нет сети / Supabase недоступен — не блокируем работу из-за того, что
    // не смогли проверить требование, продолжаем как обычно.
    console.error('Не удалось проверить минимальную версию, продолжаем без блокировки', err);
  }
  return false;
}

// ------------------------------- Админ-панель -------------------------------

let calendarViewDate = new Date();
let selectedDate = null;

function todayLocalStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function fmtDateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

async function openAdminPanel() {
  await window.app.setAdminMode(true);
  showScreen('admin');
  switchAdminTab('history');

  // По умолчанию сразу сегодня — не нужно каждый раз выбирать дату вручную.
  selectedDate = todayLocalStr();
  calendarViewDate = new Date();
  document.getElementById('date-picker-label').textContent = fmtDateLabel(selectedDate);
  renderCalendar();
  loadSessionsForDate(selectedDate);
}

function toggleCalendarPopover() {
  const popover = document.getElementById('admin-calendar');
  popover.hidden = !popover.hidden;
}

document.addEventListener('click', (e) => {
  const popover = document.getElementById('admin-calendar');
  const btn = document.getElementById('date-picker-btn');
  if (!popover.hidden && !popover.contains(e.target) && e.target !== btn) {
    popover.hidden = true;
  }
});

async function closeAdminPanel() {
  await window.app.setAdminMode(false);
  showScreen('main');
  await initMainScreen();
}

function switchAdminTab(tab) {
  const historyTab = document.getElementById('admin-tab-history');
  const usersTab = document.getElementById('admin-tab-users');
  const whitelistTab = document.getElementById('admin-tab-whitelist');
  const chatTab = document.getElementById('admin-tab-chat');
  const historySection = document.getElementById('admin-history');
  const usersSection = document.getElementById('admin-users');
  const whitelistSection = document.getElementById('admin-whitelist');
  const chatSection = document.getElementById('admin-chat');

  historyTab.classList.toggle('active', tab === 'history');
  usersTab.classList.toggle('active', tab === 'users');
  whitelistTab.classList.toggle('active', tab === 'whitelist');
  chatTab.classList.toggle('active', tab === 'chat');
  historySection.hidden = tab !== 'history';
  usersSection.hidden = tab !== 'users';
  whitelistSection.hidden = tab !== 'whitelist';
  chatSection.hidden = tab !== 'chat';

  if (tab === 'users') loadUsersList();
  if (tab === 'whitelist') loadWhitelist();
  if (tab === 'chat') loadChatThreads();
}

function renderCalendar() {
  const container = document.getElementById('admin-calendar');
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  const monthNames = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
  ];

  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7; // понедельник = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // Локальная дата, не UTC (toISOString() сдвигал бы "сегодня" на вчера
  // ночью в часовых поясах восточнее UTC).
  const todayStr = todayLocalStr();

  let html = `<div class="calendar-header">
    <button class="calendar-nav-btn" id="cal-prev">‹</button>
    <span>${monthNames[month]} ${year}</span>
    <button class="calendar-nav-btn" id="cal-next">›</button>
  </div>
  <div class="calendar-grid">`;

  for (const dow of ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']) {
    html += `<div class="calendar-dow">${dow}</div>`;
  }
  for (let i = 0; i < startOffset; i++) {
    html += `<div class="calendar-day empty"></div>`;
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const classes = ['calendar-day'];
    if (dateStr === todayStr) classes.push('today');
    if (dateStr === selectedDate) classes.push('selected');
    html += `<div class="${classes.join(' ')}" data-date="${dateStr}">${d}</div>`;
  }
  html += '</div>';
  container.innerHTML = html;

  document.getElementById('cal-prev').addEventListener('click', () => {
    calendarViewDate = new Date(year, month - 1, 1);
    renderCalendar();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    calendarViewDate = new Date(year, month + 1, 1);
    renderCalendar();
  });
  container.querySelectorAll('.calendar-day[data-date]').forEach((el) => {
    el.addEventListener('click', () => {
      selectedDate = el.dataset.date;
      document.getElementById('date-picker-label').textContent = fmtDateLabel(selectedDate);
      renderCalendar();
      document.getElementById('admin-calendar').hidden = true;
      loadSessionsForDate(selectedDate);
    });
  });
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function fmtOnlyTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

async function loadSessionsForDate(date) {
  const listEl = document.getElementById('admin-sessions-list');
  listEl.innerHTML = '<p class="empty-note">Загрузка...</p>';
  const session = await window.sessionStore.get();
  // Границы суток считаем в локальном часовом поясе (date — локальный
  // Y-M-D с календаря), а на сервер шлём уже готовые UTC-инстанты.
  const [y, m, d] = date.split('-').map(Number);
  const startIso = new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
  const endIso = new Date(y, m - 1, d + 1, 0, 0, 0, 0).toISOString();
  try {
    const { sessions } = await adminAction('list_sessions_by_date', { adminToken: session.loginToken, startIso, endIso });
    listEl.innerHTML = '';
    listEl.appendChild(renderSessionsHeader());
    if (!sessions.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'За этот день сессий нет.';
      listEl.appendChild(empty);
      return;
    }
    for (const s of sessions) {
      listEl.appendChild(renderSessionRow(s, session.loginToken));
    }
  } catch (err) {
    listEl.innerHTML = `<p class="empty-note">Ошибка: ${err.message}</p>`;
  }
}

function renderSessionsHeader() {
  const header = document.createElement('div');
  header.className = 'session-header-row';
  header.innerHTML = `
    <div>Ник</div>
    <div>Дата</div>
    <div>Марка/модель</div>
    <div>Старт</div>
    <div>Финиш</div>
    <div></div>
  `;
  return header;
}

function renderSessionRow(s, adminToken) {
  const row = document.createElement('div');
  row.className = 'session-row session-row-clickable';
  row.title = 'Открыть подробный лог этой сессии';

  // username приоритетнее имени: имя в Telegram может быть чем угодно
  // (например один символ), а username — куда более надёжный и узнаваемый
  // идентификатор для бизнеса.
  const name = s.telegram_username ? `@${s.telegram_username}` : (s.telegram_name || `id ${s.telegram_id}`);
  row.innerHTML = `
    <div class="col col-name">${name}</div>
    <div class="col col-muted">${fmtDate(s.started_at)}</div>
    <div class="col">${s.brand} ${s.model}</div>
    <div class="col col-muted">${fmtOnlyTime(s.started_at)}</div>
    <div class="col col-muted">${s.ended_at ? fmtOnlyTime(s.ended_at) : 'в процессе'}</div>
    <div class="paid-toggle">
      <button class="paid-toggle-btn ${s.paid ? 'paid' : 'unpaid'}">
        <span class="paid-dot-icon"></span>
        <span class="paid-label">${s.paid ? 'Оплачено' : 'Не оплачено'}</span>
      </button>
      <div class="paid-options" hidden>
        <button class="paid-choice green" title="Оплачено"><span class="paid-dot-icon"></span>Оплачено</button>
        <button class="paid-choice red" title="Не оплачено"><span class="paid-dot-icon"></span>Не оплачено</button>
      </div>
    </div>
  `;

  const toggleBtn = row.querySelector('.paid-toggle-btn');
  const options = row.querySelector('.paid-options');
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.paid-options').forEach((el) => { if (el !== options) el.hidden = true; });
    options.hidden = !options.hidden;
  });

  row.querySelector('.paid-choice.green').addEventListener('click', async (e) => {
    e.stopPropagation();
    await setPaid(s.id, true, adminToken, toggleBtn, options);
  });
  row.querySelector('.paid-choice.red').addEventListener('click', async (e) => {
    e.stopPropagation();
    await setPaid(s.id, false, adminToken, toggleBtn, options);
  });

  row.addEventListener('click', () => openSessionDetail(s, name, adminToken));

  return row;
}

const EVENT_LABELS = {
  telegram_login: 'Вход через Telegram',
  login_approved: 'Вход одобрен',
  login_rejected: 'Вход отклонён',
  user_kicked: 'Пользователь кикнут',
  user_unkicked: 'Доступ восстановлен',
  session_started: 'Выбрана марка/модель, сессия начата',
  automaxkg_launched: 'AUTOMAX KG запущен',
  automaxkg_launch_error: 'Ошибка запуска AUTOMAX KG',
  session_finished: 'Нажато «Завершено»',
  session_expired: 'Локальная сессия истекла (10 минут)',
};

function fmtEventDetail(ev) {
  const d = ev.detail;
  if (!d) return '';
  if (ev.event_type === 'session_started') return `${d.brand ?? ''} ${d.model ?? ''}`.trim();
  if (ev.event_type === 'automaxkg_launch_error') return d.error ?? '';
  if (ev.event_type === 'login_approved' || ev.event_type === 'login_rejected') {
    return d.auto ? `авто (${d.reason})` : `решение админа ${d.decided_by ?? ''}`;
  }
  if (ev.event_type === 'user_kicked') return `админ ${d.blocked_by ?? ''}`;
  return '';
}

async function openSessionDetail(s, name, adminToken) {
  const overlay = document.getElementById('session-detail-overlay');
  const title = document.getElementById('session-detail-title');
  const list = document.getElementById('session-detail-events');
  title.textContent = `${name} — ${s.brand} ${s.model}`;
  list.innerHTML = '<p class="empty-note">Загрузка...</p>';
  overlay.hidden = false;

  try {
    const { events } = await adminAction('list_session_events', { adminToken, sessionId: s.id });
    if (!events.length) {
      list.innerHTML = '<p class="empty-note">Событий не зафиксировано.</p>';
      return;
    }
    list.innerHTML = '';
    for (const ev of events) {
      const row = document.createElement('div');
      row.className = 'event-row';
      let label = EVENT_LABELS[ev.event_type] || ev.event_type;
      if (ev.event_type === 'session_finished' && ev.detail?.auto) {
        label =
          ev.detail.reason === 'timer_expired'
            ? 'Прервана истечением таймера (10 минут)'
            : ev.detail.reason === 'kicked'
            ? 'Прервана мгновенным киком администратора'
            : 'Закрыта автоматически (осталась незавершённой)';
      }
      const detailText = fmtEventDetail(ev);
      row.innerHTML = `
        <div class="event-time">${fmtDate(ev.created_at)} ${fmtOnlyTime(ev.created_at)}</div>
        <div class="event-label">${label}</div>
        <div class="event-detail">${detailText}</div>
      `;
      list.appendChild(row);
    }
  } catch (err) {
    list.innerHTML = `<p class="empty-note">Ошибка: ${err.message}</p>`;
  }
}

// Переиспользует тот же оверлей, что и детали сессии (session-detail-*) —
// показывает последние входы: город/страна по IP, сам IP, устройство.
async function openLoginHistory(u, name, adminToken) {
  const overlay = document.getElementById('session-detail-overlay');
  const title = document.getElementById('session-detail-title');
  const list = document.getElementById('session-detail-events');
  title.textContent = `${name} — история входов`;
  list.innerHTML = '<p class="empty-note">Загрузка...</p>';
  overlay.hidden = false;

  try {
    const { logins } = await adminAction('list_login_history', { adminToken, targetTelegramId: u.telegram_id });
    if (!logins.length) {
      list.innerHTML = '<p class="empty-note">Входов не зафиксировано.</p>';
      return;
    }
    list.innerHTML = '';
    for (const l of logins) {
      const row = document.createElement('div');
      row.className = 'event-row';
      const place = [l.city, l.country].filter(Boolean).join(', ') || 'город неизвестен';
      row.innerHTML = `
        <div class="event-time">${fmtDate(l.created_at)} ${fmtOnlyTime(l.created_at)}</div>
        <div class="event-label">${place}</div>
        <div class="event-detail">${l.ip ?? ''}${l.device ? ' · ' + l.device : ''}</div>
      `;
      list.appendChild(row);
    }
  } catch (err) {
    list.innerHTML = `<p class="empty-note">Ошибка: ${err.message}</p>`;
  }
}

document.getElementById('session-detail-close').addEventListener('click', () => {
  document.getElementById('session-detail-overlay').hidden = true;
});
document.getElementById('session-detail-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'session-detail-overlay') e.target.hidden = true;
});

async function setPaid(sessionId, paid, adminToken, toggleBtn, options) {
  try {
    await adminAction('set_paid', { adminToken, sessionId, paid });
    toggleBtn.classList.toggle('paid', paid);
    toggleBtn.querySelector('.paid-label').textContent = paid ? 'Оплачено' : 'Не оплачено';
    toggleBtn.classList.toggle('unpaid', !paid);
    options.hidden = true;
  } catch (err) {
    console.error('Не удалось изменить статус оплаты', err);
  }
}

document.addEventListener('click', () => {
  document.querySelectorAll('.paid-options').forEach((el) => { el.hidden = true; });
});

async function loadUsersList() {
  const listEl = document.getElementById('admin-users-list');
  listEl.innerHTML = '<p class="empty-note">Загрузка...</p>';
  const session = await window.sessionStore.get();
  try {
    const { users } = await adminAction('list_users', { adminToken: session.loginToken });
    listEl.innerHTML = '';
    listEl.appendChild(renderUsersHeader());
    if (!users.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'Пока никто не входил.';
      listEl.appendChild(empty);
      return;
    }
    for (const u of users) {
      listEl.appendChild(renderUserRow(u, session.loginToken));
    }
  } catch (err) {
    listEl.innerHTML = `<p class="empty-note">Ошибка: ${err.message}</p>`;
  }
}

function renderUsersHeader() {
  const header = document.createElement('div');
  header.className = 'user-header-row';
  header.innerHTML = `<div>Пользователь</div><div>Онлайн</div><div>Доверенный</div><div>Доступ</div><div></div>`;
  return header;
}

// Онлайн — не отдельный статус на сервере, а просто "последний heartbeat
// был не позже двух интервалов назад" (двух — а не одного, чтобы разовая
// задержка сети не показывала человека офлайн, пока он ещё реально в сети).
const ONLINE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 2;

function formatOnlineStatus(lastHeartbeatAt) {
  if (!lastHeartbeatAt) return { online: false, label: 'не в сети' };
  const ms = Date.now() - new Date(lastHeartbeatAt).getTime();
  if (ms < ONLINE_THRESHOLD_MS) return { online: true, label: 'в сети' };
  return { online: false, label: `был(а) ${fmtDate(lastHeartbeatAt)} ${fmtOnlyTime(lastHeartbeatAt)}` };
}

function renderUserRow(u, adminToken) {
  const row = document.createElement('div');
  row.className = 'user-row';
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || `id ${u.telegram_id}`;
  const online = formatOnlineStatus(u.last_heartbeat_at);
  row.innerHTML = `
    <div class="col-name">${name}${u.username ? `<span class="username">@${u.username}</span>` : ''}</div>
    <span class="online-indicator ${online.online ? 'online' : ''}"><span class="online-dot"></span>${online.label}</span>
    <button class="trusted-toggle-btn ${u.trusted ? 'on' : ''}">Доверенный</button>
    <button class="kick-toggle-btn ${u.blocked ? 'blocked' : ''}">${u.blocked ? 'Восстановить' : 'Кикнуть'}</button>
    <button class="history-btn">История</button>
  `;

  row.querySelector('.history-btn').addEventListener('click', () => openLoginHistory(u, name, adminToken));

  row.querySelector('.trusted-toggle-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const next = !u.trusted;
    try {
      await adminAction('set_trusted', { adminToken, targetTelegramId: u.telegram_id, trusted: next });
      u.trusted = next;
      btn.classList.toggle('on', next);
    } catch (err) {
      console.error(err);
    }
  });

  row.querySelector('.kick-toggle-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const action = u.blocked ? 'unkick' : 'kick';
    try {
      await adminAction(action, { adminToken, targetTelegramId: u.telegram_id });
      u.blocked = !u.blocked;
      btn.classList.toggle('blocked', u.blocked);
      btn.textContent = u.blocked ? 'Восстановить' : 'Кикнуть';
    } catch (err) {
      console.error(err);
    }
  });

  return row;
}

// ------------------------------- Whitelist ------------------------------
// Регистрация (вход через Telegram) возможна только для юзернеймов из этого
// списка — проверяется на сервере в telegram-webhook, здесь только
// управление самим списком.

async function loadWhitelist() {
  const listEl = document.getElementById('whitelist-list');
  listEl.innerHTML = '<p class="empty-note">Загрузка...</p>';
  const session = await window.sessionStore.get();
  try {
    const { usernames } = await adminAction('list_whitelist', { adminToken: session.loginToken });
    listEl.innerHTML = '';
    if (!usernames.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'Список пуст — пока никто не сможет зарегистрироваться.';
      listEl.appendChild(empty);
      return;
    }
    for (const u of usernames) {
      listEl.appendChild(renderWhitelistRow(u.username, session.loginToken));
    }
  } catch (err) {
    listEl.innerHTML = `<p class="empty-note">Ошибка: ${err.message}</p>`;
  }
}

function renderWhitelistRow(username, adminToken) {
  const row = document.createElement('div');
  row.className = 'whitelist-row';
  row.innerHTML = `<span>@${username}</span><button class="whitelist-remove-btn">Убрать</button>`;
  row.querySelector('.whitelist-remove-btn').addEventListener('click', async () => {
    try {
      await adminAction('remove_whitelist_username', { adminToken, username });
      loadWhitelist();
    } catch (err) {
      document.getElementById('whitelist-status').textContent = 'Ошибка: ' + err.message;
    }
  });
  return row;
}

const whitelistInput = document.getElementById('whitelist-input');
const whitelistStatus = document.getElementById('whitelist-status');

async function addWhitelistUsername() {
  const value = whitelistInput.value.trim();
  if (!value) return;
  whitelistStatus.textContent = '';
  const session = await window.sessionStore.get();
  try {
    await adminAction('add_whitelist_username', { adminToken: session.loginToken, username: value });
    whitelistInput.value = '';
    loadWhitelist();
  } catch (err) {
    whitelistStatus.textContent = 'Ошибка: ' + err.message;
  }
}

document.getElementById('whitelist-add-btn').addEventListener('click', addWhitelistUsername);
whitelistInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addWhitelistUsername();
});

// ------------------------- "Написать администратору" (Блок 7) -------------------------
// Пользовательская сторона переписки. Поллинг идёт, только пока сам экран
// переписки открыт — уведомлять пользователя о новом ответе, пока он занят
// чем-то другим в приложении, задача не требовала (админ и так узнаёт о
// новом сообщении через уведомление в Telegram-боте, см. support-message).

let supportPollTimer = null;
const SUPPORT_POLL_INTERVAL_MS = 5000;

function stopSupportPoll() {
  if (supportPollTimer) {
    clearInterval(supportPollTimer);
    supportPollTimer = null;
  }
}

function startSupportPoll() {
  stopSupportPoll();
  supportPollTimer = setInterval(loadSupportMessages, SUPPORT_POLL_INTERVAL_MS);
}

async function openSupportChat() {
  document.getElementById('support-status').textContent = '';
  showScreen('support');
  await loadSupportMessages();
  startSupportPoll();
}

function closeSupportChat() {
  stopSupportPoll();
  showScreen('main');
}

async function loadSupportMessages() {
  const session = await window.sessionStore.get();
  if (!session) return;
  try {
    const { messages } = await callFunction('support-message', { action: 'list', loginToken: session.loginToken });
    renderSupportMessages(messages);
  } catch (err) {
    document.getElementById('support-status').textContent = 'Ошибка загрузки: ' + err.message;
  }
}

function renderSupportMessages(messages) {
  const container = document.getElementById('support-messages');
  container.innerHTML = '';
  if (!messages.length) {
    container.innerHTML = '<p class="empty-note">Сообщений пока нет — напишите администратору, если есть вопрос.</p>';
    return;
  }
  for (const m of messages) {
    const row = document.createElement('div');
    row.className = `support-message ${m.sender_role === 'admin' ? 'from-admin' : 'from-user'}`;
    const textEl = document.createElement('div');
    textEl.className = 'support-message-text';
    textEl.textContent = m.text;
    const timeEl = document.createElement('div');
    timeEl.className = 'support-message-time';
    timeEl.textContent = `${fmtDate(m.created_at)} ${fmtOnlyTime(m.created_at)}`;
    row.appendChild(textEl);
    row.appendChild(timeEl);
    container.appendChild(row);
  }
  container.scrollTop = container.scrollHeight;
}

async function sendSupportMessage() {
  const input = document.getElementById('support-input');
  const text = input.value.trim();
  if (!text) return;
  const session = await window.sessionStore.get();
  if (!session) return;
  const btn = document.getElementById('support-send-btn');
  btn.disabled = true;
  try {
    await callFunction('support-message', { action: 'send', loginToken: session.loginToken, text });
    input.value = '';
    await loadSupportMessages();
  } catch (err) {
    document.getElementById('support-status').textContent = 'Не удалось отправить: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('support-open-btn').addEventListener('click', openSupportChat);
document.getElementById('support-back-btn').addEventListener('click', closeSupportChat);
document.getElementById('support-send-btn').addEventListener('click', sendSupportMessage);

// ------------------------- Переписка — сторона администратора -------------------------

let chatThreadsCache = [];
let activeChatTelegramId = null;

async function loadChatThreads() {
  const listEl = document.getElementById('chat-threads-list');
  listEl.innerHTML = '<p class="empty-note">Загрузка...</p>';
  const session = await window.sessionStore.get();
  try {
    const { threads } = await adminAction('list_support_threads', { adminToken: session.loginToken });
    chatThreadsCache = threads;
    if (!threads.length) {
      listEl.innerHTML = '<p class="empty-note">Сообщений нет.</p>';
      return;
    }
    listEl.innerHTML = '';
    for (const t of threads) listEl.appendChild(renderChatThreadRow(t, session.loginToken));
  } catch (err) {
    listEl.innerHTML = `<p class="empty-note">Ошибка: ${err.message}</p>`;
  }
}

function renderChatThreadRow(t, adminToken) {
  const row = document.createElement('div');
  row.className = `chat-thread-row ${t.telegram_id === activeChatTelegramId ? 'active' : ''}`;
  const name = t.user
    ? (t.user.username ? `@${t.user.username}` : [t.user.first_name, t.user.last_name].filter(Boolean).join(' ') || `id ${t.telegram_id}`)
    : `id ${t.telegram_id}`;
  row.innerHTML = `
    <div class="chat-thread-name">${name}</div>
    <div class="chat-thread-preview">${t.last_sender === 'admin' ? 'Вы: ' : ''}${t.last_text}</div>
  `;
  row.addEventListener('click', () => openChatConversation(t.telegram_id, name, adminToken));
  return row;
}

async function openChatConversation(telegramId, name, adminToken) {
  activeChatTelegramId = telegramId;
  document.querySelectorAll('.chat-thread-row').forEach((el, i) => {
    el.classList.toggle('active', chatThreadsCache[i]?.telegram_id === telegramId);
  });
  document.getElementById('chat-conversation-title').textContent = name;
  const messagesEl = document.getElementById('chat-conversation-messages');
  messagesEl.innerHTML = '<p class="empty-note">Загрузка...</p>';
  const input = document.getElementById('chat-reply-input');
  const sendBtn = document.getElementById('chat-reply-send-btn');
  input.disabled = false;
  sendBtn.disabled = false;

  try {
    const { messages } = await adminAction('list_support_messages', { adminToken, targetTelegramId: telegramId });
    messagesEl.innerHTML = '';
    for (const m of messages) {
      const row = document.createElement('div');
      row.className = `support-message ${m.sender_role === 'admin' ? 'from-admin' : 'from-user'}`;
      const textEl = document.createElement('div');
      textEl.className = 'support-message-text';
      textEl.textContent = m.text;
      const timeEl = document.createElement('div');
      timeEl.className = 'support-message-time';
      timeEl.textContent = `${fmtDate(m.created_at)} ${fmtOnlyTime(m.created_at)}`;
      row.appendChild(textEl);
      row.appendChild(timeEl);
      messagesEl.appendChild(row);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } catch (err) {
    messagesEl.innerHTML = `<p class="empty-note">Ошибка: ${err.message}</p>`;
  }
}

async function sendChatReply() {
  if (!activeChatTelegramId) return;
  const input = document.getElementById('chat-reply-input');
  const text = input.value.trim();
  if (!text) return;
  const session = await window.sessionStore.get();
  const sendBtn = document.getElementById('chat-reply-send-btn');
  sendBtn.disabled = true;
  try {
    await adminAction('send_support_reply', { adminToken: session.loginToken, targetTelegramId: activeChatTelegramId, text });
    input.value = '';
    const name = document.getElementById('chat-conversation-title').textContent;
    await openChatConversation(activeChatTelegramId, name, session.loginToken);
    await loadChatThreads();
  } catch (err) {
    alert('Не удалось отправить: ' + err.message);
  } finally {
    sendBtn.disabled = false;
  }
}

document.getElementById('chat-reply-send-btn').addEventListener('click', sendChatReply);
document.getElementById('chat-reply-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChatReply();
});

adminOpenBtn.addEventListener('click', openAdminPanel);
document.getElementById('admin-back-btn').addEventListener('click', closeAdminPanel);
document.getElementById('admin-tab-history').addEventListener('click', () => switchAdminTab('history'));
document.getElementById('admin-tab-users').addEventListener('click', () => switchAdminTab('users'));
document.getElementById('admin-tab-whitelist').addEventListener('click', () => switchAdminTab('whitelist'));
document.getElementById('admin-tab-chat').addEventListener('click', () => switchAdminTab('chat'));
document.getElementById('date-picker-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleCalendarPopover();
});

// ------------------------------------------------------------------------

window.app.getVersion().then((version) => {
  document.getElementById('app-version').textContent = `v${version}`;
});

// Разово показываем, если при старте программа сама нашла и удалила старые
// независимые копии AUTOMAX KG (см. cleanupOrphanedAutomaxKgCopies в main.js)
// — молчаливое удаление файлов пользователя без объяснения было бы плохой
// практикой, даже если оно и оправдано с точки зрения безопасности.
window.automaxkg.getCleanupResult().then((removed) => {
  if (!removed || !removed.length) return;
  const notice = document.getElementById('cleanup-notice');
  const text = document.getElementById('cleanup-notice-text');
  text.textContent =
    `В целях безопасности удалены старые дублирующиеся копии AUTOMAX KG, найденные на этом компьютере (${removed.length}) — ` +
    `теперь программа использует только одну копию, которую скачивает сама.`;
  notice.hidden = false;
});
document.getElementById('cleanup-notice-dismiss').addEventListener('click', () => {
  document.getElementById('cleanup-notice').hidden = true;
});

checkForcedUpdate().then((blocked) => {
  if (!blocked) resumeExistingSession();
});
