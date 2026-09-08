// Паттерн вход-через-Telegram (токен + вебхук + поллинг) взят из проекта
// Trecker и адаптирован под Electron (shell.openExternal вместо window.open).
// Поверх — админ-подтверждение (или авто-approve для доверенных / авто-reject
// для кикнутых), локальная 10-минутная сессия устройства, и учёт сессий
// работы с конкретной машиной (car_sessions) с защитой от прерывания, пока
// сессия активна.

const { SUPABASE_URL, SUPABASE_ANON_KEY, BOT_USERNAME } = window.APP_CONFIG;
const POLL_INTERVAL_MS = 2500;
const STORAGE_KEY = 'russificator_login_token';
const SESSION_MS = 20 * 60 * 1000;

const screens = {
  login: document.getElementById('screen-login'),
  waiting: document.getElementById('screen-waiting'),
  rejected: document.getElementById('screen-rejected'),
  downloading: document.getElementById('screen-downloading'),
  main: document.getElementById('screen-main'),
  activationWaiting: document.getElementById('screen-activation-waiting'),
  terminal: document.getElementById('screen-terminal'),
  support: document.getElementById('screen-support'),
};
const waitingText = document.getElementById('waiting-text');
const loginStatus = document.getElementById('login-status');
const status = document.getElementById('status');

let pollTimer = null;
// Пока это не null — кик/истечение сессии не разлогинивают принудительно
// (см. touchSessionOrKick), только "Завершено" её закрывает.
let activeCarSession = null;
// Марка/модель, выбранная в списке, но ещё не подтверждённая кнопкой
// "Активация" — car_session на сервере ещё не создана, AUTOMAX KG ещё не
// запущена. Отдельно от activeCarSession (та означает "работа уже реально
// идёт").
let selectedCarModel = null;

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
// Заявка на активацию (после выбора машины) — отдельный, самостоятельный
// механизм от входа в приложение (Telegram-логин выше). Пользователь сюда
// уже вошёл; это про подтверждение админом самой работы с машиной, и
// пользователь при этом никуда не переходит — только опрашивает статус.
const activationRequest = (action, payload) => callFunction('activation-request', { action, ...payload });

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
// одобренного пользователя (проверяется на сервере по loginToken). Сами
// файлы на диске клиента ничем не шифруются — защищены только скрытыми
// атрибутами и правами NTFS на стороне main.js (см. комментарии там), без
// каких-либо ключей на этом пути.
async function ensureAutomaxKgReady(loginToken) {
  const { available } = await window.automaxkg.status();
  if (available) return true;

  pendingLoginToken = loginToken;
  showScreen('downloading');
  downloadErrorEl.hidden = true;
  downloadRetryBtn.hidden = true;
  downloadProgressFill.style.width = '0%';

  try {
    downloadProgressText.textContent = 'Подготовка списка файлов...';
    const { files } = await callFunction('automaxkg-manifest', { loginToken });
    downloadProgressText.textContent = `Скачано 0 из ${files.length} файлов (0%)`;
    const result = await window.automaxkg.download(files);
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

function cancelLogin() {
  stopPolling();
  localStorage.removeItem(STORAGE_KEY);
  showScreen('login');
}

function retryLogin() {
  showScreen('login');
}

// ------------------------------- Вход через Telegram -------------------------------
// Единственный способ входа. Личность подтверждается ботом (тот же
// whitelist, что и раньше), дальше — либо мгновенный auto-approve для
// "доверенных" пользователей, либо заявка двум админам на решение.
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

  // Оба запроса независимы (ни один не использует результат другого) —
  // запускаем параллельно вместо друг за другом, это отдаёт главный экран
  // на один сетевой круг быстрее при каждом старте/резюме приложения.
  const [trusted, blocked] = await Promise.all([
    isTrustedUser(session.loginToken),
    isBlocked(session.telegramId).catch((err) => {
      console.error('Проверка блокировки не удалась, продолжаем офлайн', err);
      return false;
    }),
  ]);

  if (!trusted && Date.now() - session.lastActivityAt > SESSION_MS) {
    // loginToken остаётся approved на сервере навсегда — 20 минут это только
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

  if (blocked) {
    await window.sessionStore.clear();
    return false;
  }

  // Раньше здесь стоял sessionStore.touch() — "продлевал" 20-минутное окно
  // при каждом резюме приложения. Убрано намеренно: таймер должен идти
  // строго от момента входа, не сбрасываясь ни от чего, включая повторное
  // открытие приложения в рамках этих 20 минут.
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
const carActivateBtn = document.getElementById('car-activate-btn');
const activeSessionBox = document.getElementById('active-session');
const activeSessionLabel = document.getElementById('active-session-label');
const finishBtn = document.getElementById('finish-session-btn');

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

  terminalStatus.textContent = 'Подготовка AUTOMAX KG...';
  const result = await window.automaxkg.startTerminal(term.cols, term.rows);
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

// ------------------------- Видимый таймер сессии (20 минут) -------------------------
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
// Вся операция обёрнута в try/finally с showScreen('login') в finally —
// раньше (до этого фикса) window.sessionStore.clear() был единственным
// вызовом здесь БЕЗ .catch(), и если он падал по любой причине (антивирус
// временно заблокировал файл конфигурации, диск недоступен, IPC-сбой), вся
// функция обрывалась необработанным исключением ДО showScreen('login') —
// приложение оставалось на экране терминала навсегда, без возможности снова
// войти без ручного перезапуска. Теперь любой сбой на любом шаге не мешает
// гарантированному возврату на экран входа.
async function forceExpireSession(session) {
  stopSessionTimer();
  stopHeartbeat();
  stopKickPoll();

  try {
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

    await window.sessionStore.clear().catch((e) => console.error('Не удалось очистить локальную сессию при истечении таймера', e));
    await window.app.setTerminalMode(false).catch(() => {});
  } catch (err) {
    console.error('Непредвиденная ошибка при принудительном завершении сессии (истечение таймера)', err);
  } finally {
    showScreen('login');
  }
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

// Тот же фикс, что и в forceExpireSession — гарантированный showScreen('login')
// в finally, независимо от того, упал ли какой-то из шагов ниже.
async function forceKickSession(session) {
  stopSessionTimer();
  stopHeartbeat();
  stopKickPoll();

  try {
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

    await window.sessionStore.clear().catch((e) => console.error('Не удалось очистить локальную сессию при кике', e));
    await window.app.setTerminalMode(false).catch(() => {});
  } catch (err) {
    console.error('Непредвиденная ошибка при принудительном завершении сессии (кик)', err);
  } finally {
    showScreen('login');
  }
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
    item.addEventListener('click', () => chooseCarModel(m));
    carDropdownList.appendChild(item);
  }
  carDropdownList.hidden = false;
}

document.addEventListener('click', (e) => {
  if (!carPicker.contains(e.target)) carDropdownList.hidden = true;
});

// Клик по строке списка — только выбор (марка+модель одной строкой, как и
// была устроена сама механика списка, её не трогаем). Реальный запуск
// (car_session на сервере + AUTOMAX KG) происходит отдельно, по кнопке
// "Активация" — см. activateSelectedCar ниже.
function chooseCarModel(model) {
  carDropdownList.hidden = true;
  selectedCarModel = model;
  carDropdownBtn.textContent = `${model.brand} ${model.model} ✓`;
  carActivateBtn.hidden = false;
  status.textContent = '';
}

// Заявка на активацию: пользователь остаётся на сайте (экран ожидания),
// подтверждает админ прямо в боте — см. activation-request и telegram-webhook
// (блок 2б там). Это НЕ то же самое, что вход в приложение через Telegram
// выше по файлу — отдельная таблица (activation_requests), отдельный
// callback_data в боте (activate_confirm/activate_reject), пользователь в
// Telegram не переходит вообще ни на одном шаге.
const ACTIVATION_POLL_INTERVAL_MS = 4000;
let activationPollTimer = null;
let activeActivationRequestId = null;

function stopActivationPoll() {
  if (activationPollTimer) {
    clearInterval(activationPollTimer);
    activationPollTimer = null;
  }
}

async function activateSelectedCar() {
  if (!selectedCarModel) return;
  const model = selectedCarModel;
  const session = await window.sessionStore.get();
  if (!session) {
    showScreen('login');
    return;
  }
  carActivateBtn.disabled = true;
  status.textContent = 'Отправка заявки...';
  try {
    const { request } = await activationRequest('create', {
      loginToken: session.loginToken,
      brand: model.brand,
      model: model.model,
    });
    status.textContent = '';
    carActivateBtn.hidden = true;
    await enterActivationWaitingScreen(request, session.loginToken, model);
  } catch (err) {
    status.textContent = 'Ошибка: ' + err.message;
  } finally {
    carActivateBtn.disabled = false;
  }
}

async function enterActivationWaitingScreen(request, loginToken, model) {
  activeActivationRequestId = request.id;
  showScreen('activationWaiting');

  if (request.status === 'confirmed') {
    await proceedAfterActivationConfirmed(model, loginToken);
    return;
  }

  stopActivationPoll();
  activationPollTimer = setInterval(async () => {
    if (!activeActivationRequestId) {
      stopActivationPoll();
      return;
    }
    let rows;
    try {
      rows = await supabaseRequest(`activation_requests?id=eq.${activeActivationRequestId}&select=status`);
    } catch (err) {
      return; // сетевой сбой при опросе — пробуем на следующем тике, не прерываем
    }
    const row = rows && rows[0];
    if (!row) return;

    if (row.status === 'confirmed') {
      stopActivationPoll();
      await proceedAfterActivationConfirmed(model, loginToken);
    } else if (row.status === 'rejected') {
      stopActivationPoll();
      activeActivationRequestId = null;
      selectedCarModel = null;
      carDropdownBtn.textContent = 'Начать работу';
      showScreen('main');
      status.textContent = 'Администратор отклонил заявку.';
    }
  }, ACTIVATION_POLL_INTERVAL_MS);
}

// То, что раньше происходило сразу по клику "Активация" — реальный запуск
// работы с машиной, теперь только после подтверждения админом.
async function proceedAfterActivationConfirmed(model, loginToken) {
  activeActivationRequestId = null;
  selectedCarModel = null;
  carDropdownBtn.textContent = 'Начать работу';
  try {
    const { session: carSess } = await carSession('start', {
      loginToken,
      brand: model.brand,
      model: model.model,
    });
    activeCarSession = carSess;
    status.textContent = '';
    await enterTerminalScreen(carSess, loginToken);
  } catch (err) {
    showScreen('main');
    if (err.status === 409 && err.data && err.data.session) {
      activeCarSession = err.data.session;
      renderActiveSession();
      status.textContent = 'Уже есть незавершённая работа — сначала нажмите «Завершено».';
    } else {
      status.textContent = 'Ошибка: ' + err.message;
    }
  }
}

// Отменить заявку по инициативе пользователя (экран ожидания, п.5.8 — без
// таймаута, но с явной кнопкой отмены). Выбор марки/модели не сбрасываем —
// можно сразу нажать "Активация" ещё раз без повторного выбора.
async function cancelActivationRequest() {
  const requestId = activeActivationRequestId;
  stopActivationPoll();
  activeActivationRequestId = null;
  showScreen('main');
  carActivateBtn.hidden = !selectedCarModel;
  if (!requestId) return;
  const session = await window.sessionStore.get();
  if (!session) return;
  await activationRequest('cancel', { loginToken: session.loginToken, requestId }).catch((e) =>
    console.error('Не удалось отменить заявку на активацию', e)
  );
}

function renderActiveSession() {
  if (activeCarSession) {
    carPicker.hidden = true;
    activeSessionBox.hidden = false;
    activeSessionLabel.textContent = `${activeCarSession.brand} ${activeCarSession.model}`;
    finishBtn.hidden = false;
    carActivateBtn.hidden = true;
  } else {
    carPicker.hidden = false;
    activeSessionBox.hidden = true;
    finishBtn.hidden = true;
    carActivateBtn.hidden = !selectedCarModel;
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
  selectedCarModel = null;
  carDropdownBtn.textContent = 'Начать работу';
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

// ------------------------- Кнопка "Выйти" -------------------------
// Полная добровольная деавторизация по явному действию пользователя — в
// отличие от forceExpireSession/forceKickSession выше (те принудительные).
// Если сейчас открыта работа с машиной — не рвём её молча, тот же принцип,
// что и у диалога закрытия окна в main.js (mainWindow.on('close', ...)):
// спрашиваем подтверждение, а не действуем без предупреждения.
async function logout() {
  if (activeCarSession && !confirm('Сейчас открыта работа с машиной. Всё равно выйти из аккаунта?')) {
    return;
  }

  stopSessionTimer();
  stopHeartbeat();
  stopKickPoll();
  stopPolling();
  stopActivationPoll();
  activeActivationRequestId = null;

  localStorage.removeItem(STORAGE_KEY);
  await window.sessionStore.clear().catch((e) => console.error('Не удалось очистить локальную сессию при выходе', e));
  await window.app.setTerminalMode(false).catch(() => {});

  selectedCarModel = null;
  carDropdownBtn.textContent = 'Начать работу';
  carActivateBtn.hidden = true;

  showScreen('login');
}

carDropdownBtn.addEventListener('click', toggleCarDropdown);
carActivateBtn.addEventListener('click', activateSelectedCar);
finishBtn.addEventListener('click', finishSession);
terminalFinishBtn.addEventListener('click', finishSession);
// Кнопка "Выйти" повторяется на каждом экране, доступном только после
// входа (сейчас — главный экран и экран ожидания подтверждения активации).
document.querySelectorAll('.logout-btn').forEach((btn) => btn.addEventListener('click', logout));

document.getElementById('telegram-login-btn').addEventListener('click', beginTelegramLogin);
document.getElementById('cancel-login-btn').addEventListener('click', cancelLogin);
document.getElementById('retry-login-btn').addEventListener('click', retryLogin);
document.getElementById('cancel-activation-btn').addEventListener('click', cancelActivationRequest);

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
    const [rows, currentVersion] = await Promise.all([
      supabaseRequest('app_settings?key=eq.min_version&select=value'),
      window.app.getVersion(),
    ]);
    const minVersion = rows && rows[0] ? rows[0].value : null;
    if (!minVersion) return false;

    if (compareVersions(currentVersion, minVersion) < 0) {
      // Оверлей, а не отдельный экран — показывается поверх того, что уже
      // на экране (обычно screen-login, он не hidden по умолчанию в HTML),
      // блокируя доступ к нему, но не заменяя. Нет ни крестика, ни закрытия
      // по клику мимо/Esc — они здесь просто не реализованы, единственный
      // выход physически в разметке — кнопка "Обновить сейчас".
      document.getElementById('forced-update-overlay').hidden = false;
      return true;
    }
  } catch (err) {
    // Нет сети / Supabase недоступен — не блокируем работу из-за того, что
    // не смогли проверить требование, продолжаем как обычно.
    console.error('Не удалось проверить минимальную версию, продолжаем без блокировки', err);
  }
  return false;
}

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

// Синхронный флаг (не только btn.disabled) — если Enter и клик по кнопке
// срабатывают почти одновременно, оба вызова успевают начаться до того,
// как первый await (sessionStore.get()) вернётся и выставит disabled;
// найдено вживую в веб-админке (та же функция без этой защиты дублировала
// сообщение), здесь ставим ту же защиту на всякий случай.
let supportMessageSending = false;

async function sendSupportMessage() {
  const input = document.getElementById('support-input');
  const text = input.value.trim();
  // Флаг выставляется синхронно, до любого await — иначе два вызова,
  // начавшиеся почти одновременно (Enter + клик), оба проходят проверку
  // раньше, чем первый успеет её выставить.
  if (!text || supportMessageSending) return;
  supportMessageSending = true;
  const btn = document.getElementById('support-send-btn');
  btn.disabled = true;
  try {
    const session = await window.sessionStore.get();
    if (!session) return;
    await callFunction('support-message', { action: 'send', loginToken: session.loginToken, text });
    input.value = '';
    await loadSupportMessages();
  } catch (err) {
    document.getElementById('support-status').textContent = 'Не удалось отправить: ' + err.message;
  } finally {
    supportMessageSending = false;
    btn.disabled = false;
  }
}

document.getElementById('support-open-btn').addEventListener('click', openSupportChat);
document.getElementById('support-back-btn').addEventListener('click', closeSupportChat);
document.getElementById('support-send-btn').addEventListener('click', sendSupportMessage);


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
