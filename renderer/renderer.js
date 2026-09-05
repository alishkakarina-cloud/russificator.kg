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
  waiting: document.getElementById('screen-waiting'),
  rejected: document.getElementById('screen-rejected'),
  downloading: document.getElementById('screen-downloading'),
  main: document.getElementById('screen-main'),
  terminal: document.getElementById('screen-terminal'),
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
async function ensureAutomaxKgReady(loginToken) {
  const { available } = await window.automaxkg.status();
  if (available) return true;

  pendingLoginToken = loginToken;
  showScreen('downloading');
  downloadErrorEl.hidden = true;
  downloadRetryBtn.hidden = true;
  downloadProgressFill.style.width = '0%';
  downloadProgressText.textContent = 'Подготовка списка файлов...';

  try {
    const { files } = await callFunction('automaxkg-manifest', { loginToken });
    downloadProgressText.textContent = `Скачано 0 из ${files.length} файлов (0%)`;
    const result = await window.automaxkg.download(files);
    if (!result.ok) throw new Error(result.error);
    return true;
  } catch (err) {
    downloadErrorEl.hidden = false;
    downloadErrorEl.textContent = 'Ошибка скачивания: ' + err.message;
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

// Перепроверяет кик после "Завершено" — но только если сейчас нет активной
// сессии работы с машиной (пока activeCarSession не пуст, кик откладывается
// до нажатия "Завершено", см. ограничения задачи). НЕ продлевает 10-минутный
// таймер входа — раньше здесь был sessionStore.touch(), из-за чего каждое
// "Завершено" визуально сбрасывало обратный отсчёт до 10:00, что и было
// зафиксировано как нежелательное поведение: таймер должен идти строго от
// момента входа, независимо от того, сколько машин пользователь успел
// закрыть за это время.
async function checkKickAfterFinish() {
  if (activeCarSession) return true;

  const session = await window.sessionStore.get();
  if (!session) return true;

  try {
    if (await isBlocked(session.telegramId)) {
      stopSessionTimer();
      await window.sessionStore.clear();
      showScreen('login');
      return false;
    }
  } catch (err) {
    console.error('Проверка блокировки не удалась, продолжаем офлайн', err);
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

  const result = await window.automaxkg.startTerminal(term.cols, term.rows);
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
    await window.app.setTerminalMode(false);
    showScreen('main');
    renderActiveSession();
    // Кик мог накопиться, пока сессия была активна — проверяем сразу.
    // Таймер сессии входа НЕ трогаем — он продолжает идти от момента входа.
    await checkKickAfterFinish();
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
  } else {
    stopSessionTimer();
  }
  renderActiveSession();
}

carDropdownBtn.addEventListener('click', toggleCarDropdown);
finishBtn.addEventListener('click', finishSession);
terminalFinishBtn.addEventListener('click', finishSession);

document.getElementById('telegram-login-btn').addEventListener('click', beginTelegramLogin);
document.getElementById('cancel-login-btn').addEventListener('click', cancelLogin);
document.getElementById('retry-login-btn').addEventListener('click', retryLogin);

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
  const historySection = document.getElementById('admin-history');
  const usersSection = document.getElementById('admin-users');

  if (tab === 'history') {
    historyTab.classList.add('active');
    usersTab.classList.remove('active');
    historySection.hidden = false;
    usersSection.hidden = true;
  } else {
    historyTab.classList.remove('active');
    usersTab.classList.add('active');
    historySection.hidden = true;
    usersSection.hidden = false;
    loadUsersList();
  }
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
  header.innerHTML = `<div>Пользователь</div><div>Доверенный</div><div>Доступ</div>`;
  return header;
}

function renderUserRow(u, adminToken) {
  const row = document.createElement('div');
  row.className = 'user-row';
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || `id ${u.telegram_id}`;
  row.innerHTML = `
    <div class="col-name">${name}${u.username ? `<span class="username">@${u.username}</span>` : ''}</div>
    <button class="trusted-toggle-btn ${u.trusted ? 'on' : ''}">Доверенный</button>
    <button class="kick-toggle-btn ${u.blocked ? 'blocked' : ''}">${u.blocked ? 'Восстановить' : 'Кикнуть'}</button>
  `;

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

adminOpenBtn.addEventListener('click', openAdminPanel);
document.getElementById('admin-back-btn').addEventListener('click', closeAdminPanel);
document.getElementById('admin-tab-history').addEventListener('click', () => switchAdminTab('history'));
document.getElementById('admin-tab-users').addEventListener('click', () => switchAdminTab('users'));
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

resumeExistingSession();
