// Паттерн вход-через-Telegram (токен + вебхук + поллинг) взят из проекта
// Trecker и адаптирован под Electron (shell.openExternal вместо window.open).
// Поверх — админ-подтверждение (или авто-approve для доверенных / авто-reject
// для кикнутых), локальная 30-минутная сессия устройства, и учёт сессий
// работы с конкретной машиной (car_sessions) с защитой от прерывания, пока
// сессия активна.

const { SUPABASE_URL, SUPABASE_ANON_KEY, BOT_USERNAME, ADMIN_CHAT_IDS } = window.APP_CONFIG;
const POLL_INTERVAL_MS = 2500;
const STORAGE_KEY = 'russificator_login_token';
const SESSION_MS = 30 * 60 * 1000;

const screens = {
  login: document.getElementById('screen-login'),
  waiting: document.getElementById('screen-waiting'),
  rejected: document.getElementById('screen-rejected'),
  main: document.getElementById('screen-main'),
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
  await initMainScreen();
  return true;
}

// Продлевает 30-минутное окно и перепроверяет кик — но только если сейчас
// нет активной сессии работы с машиной. Пока activeCarSession не пуст, кик и
// истечение откладываются до нажатия "Завершено" (см. ограничения задачи).
async function touchSessionOrKick() {
  if (activeCarSession) return true;

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

// ------------------------------- Главный экран -------------------------------

const carDropdownBtn = document.getElementById('car-dropdown-btn');
const carDropdownList = document.getElementById('car-dropdown-list');
const carPicker = document.getElementById('car-picker');
const activeSessionBox = document.getElementById('active-session');
const activeSessionLabel = document.getElementById('active-session-label');
const finishBtn = document.getElementById('finish-session-btn');
const adminOpenBtn = document.getElementById('admin-open-btn');

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
    await window.automaxkg.launch();
    status.textContent = '';
    renderActiveSession();
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
  try {
    await carSession('finish', { loginToken: session.loginToken, sessionId: activeCarSession.id });
    activeCarSession = null;
    renderActiveSession();
    // Кик/истечение могли накопиться, пока сессия была активна — проверяем сразу.
    await touchSessionOrKick();
  } catch (err) {
    status.textContent = 'Не удалось завершить: ' + err.message;
  } finally {
    finishBtn.disabled = false;
  }
}

async function initMainScreen() {
  const session = await window.sessionStore.get();
  if (session && ADMIN_CHAT_IDS.includes(session.telegramId)) {
    adminOpenBtn.hidden = false;
  } else {
    adminOpenBtn.hidden = true;
  }

  activeCarSession = null;
  if (session) {
    try {
      const { session: active } = await carSession('get_active', { loginToken: session.loginToken });
      activeCarSession = active;
    } catch (err) {
      console.error('Не удалось проверить активную сессию', err);
    }
  }
  renderActiveSession();
}

carDropdownBtn.addEventListener('click', toggleCarDropdown);
finishBtn.addEventListener('click', finishSession);

document.getElementById('telegram-login-btn').addEventListener('click', beginTelegramLogin);
document.getElementById('cancel-login-btn').addEventListener('click', cancelLogin);
document.getElementById('retry-login-btn').addEventListener('click', retryLogin);

// ------------------------------- Админ-панель -------------------------------

let calendarViewDate = new Date();
let selectedDate = null;

async function openAdminPanel() {
  await window.app.setAdminMode(true);
  showScreen('admin');
  switchAdminTab('history');
  renderCalendar();
}

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
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

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
      renderCalendar();
      loadSessionsForDate(selectedDate);
    });
  });
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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
    if (!sessions.length) {
      listEl.innerHTML = '<p class="empty-note">За этот день сессий нет.</p>';
      return;
    }
    listEl.innerHTML = '';
    for (const s of sessions) {
      listEl.appendChild(renderSessionRow(s, session.loginToken));
    }
  } catch (err) {
    listEl.innerHTML = `<p class="empty-note">Ошибка: ${err.message}</p>`;
  }
}

function renderSessionRow(s, adminToken) {
  const row = document.createElement('div');
  row.className = 'session-row';

  const name = s.telegram_name || (s.telegram_username ? `@${s.telegram_username}` : `id ${s.telegram_id}`);
  row.innerHTML = `
    <div class="col col-name">${name}</div>
    <div class="col">${s.brand} ${s.model}</div>
    <div class="col col-times">${fmtTime(s.started_at)} → ${s.ended_at ? fmtTime(s.ended_at) : 'в процессе'}</div>
    <div class="paid-toggle">
      <button class="paid-toggle-btn ${s.paid ? 'paid' : 'unpaid'}"></button>
      <div class="paid-options" hidden>
        <button class="paid-dot green" title="Оплачено"></button>
        <button class="paid-dot red" title="Не оплачено"></button>
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

  row.querySelector('.paid-dot.green').addEventListener('click', async (e) => {
    e.stopPropagation();
    await setPaid(s.id, true, adminToken, toggleBtn, options);
  });
  row.querySelector('.paid-dot.red').addEventListener('click', async (e) => {
    e.stopPropagation();
    await setPaid(s.id, false, adminToken, toggleBtn, options);
  });

  return row;
}

async function setPaid(sessionId, paid, adminToken, toggleBtn, options) {
  try {
    await adminAction('set_paid', { adminToken, sessionId, paid });
    toggleBtn.classList.toggle('paid', paid);
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
    if (!users.length) {
      listEl.innerHTML = '<p class="empty-note">Пока никто не входил.</p>';
      return;
    }
    listEl.innerHTML = '';
    for (const u of users) {
      listEl.appendChild(renderUserRow(u, session.loginToken));
    }
  } catch (err) {
    listEl.innerHTML = `<p class="empty-note">Ошибка: ${err.message}</p>`;
  }
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

// ------------------------------------------------------------------------

window.app.getVersion().then((version) => {
  document.getElementById('app-version').textContent = `v${version}`;
});

resumeExistingSession();
