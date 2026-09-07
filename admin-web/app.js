// Мобильная веб-админка (Блок 6). Использует ровно те же Supabase Edge
// Functions, что и десктопное приложение (telegram-login-start,
// telegram-webhook, admin-action) — отдельного бэкенда нет. Вход — тот же
// Telegram-флоу (токен + подтверждение в боте + поллинг статуса), что и в
// десктопном приложении; admin-action сам отклоняет (403) любого, кто не
// входит в список администраторов на сервере — эта страница публична, но
// реальные данные показывает только двум админам.

const { SUPABASE_URL, SUPABASE_ANON_KEY, BOT_USERNAME } = window.APP_CONFIG;
const POLL_INTERVAL_MS = 2500;
const TOKEN_KEY = 'admin_login_token';
const HEARTBEAT_INTERVAL_MS = 45 * 1000; // как в десктопном приложении
const ONLINE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 2;

const screens = {
  login: document.getElementById('screen-login'),
  waiting: document.getElementById('screen-waiting'),
  rejected: document.getElementById('screen-rejected'),
  admin: document.getElementById('screen-admin'),
};

function showScreen(name) {
  for (const key of Object.keys(screens)) screens[key].hidden = key !== name;
}

async function supabaseRequest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
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
    throw err;
  }
  return data;
}

const adminAction = (action, payload) => callFunction('admin-action', { action, adminToken, ...payload });

let adminToken = null;
let pollTimer = null;

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function fetchTokenRow(token) {
  const rows = await supabaseRequest(
    `telegram_login_tokens?token=eq.${encodeURIComponent(token)}&select=status,telegram_user`
  );
  return rows && rows.length ? rows[0] : null;
}

// ------------------------------- Вход -------------------------------

const loginError = document.getElementById('login-error');
const waitingText = document.getElementById('waiting-text');
const tgOpenLink = document.getElementById('tg-open-link');

async function beginLogin() {
  loginError.textContent = '';
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/telegram-login-start`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ purpose: 'login' }),
    });
    if (!res.ok) throw new Error(`Не удалось начать вход (${res.status})`);
    const { token } = await res.json();
    tgOpenLink.href = `https://t.me/${BOT_USERNAME}?start=${token}`;
    waitingText.textContent = 'Нажмите «Открыть Telegram» и подтвердите Start в чате с ботом...';
    showScreen('waiting');
    startPolling(token);
  } catch (err) {
    loginError.textContent = 'Ошибка входа: ' + err.message;
  }
}

function startPolling(token) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const row = await fetchTokenRow(token);
      const status_ = row ? row.status : null;
      if (status_ === 'pending_telegram') {
        waitingText.textContent = 'Нажмите Start в открывшемся чате с ботом...';
      } else if (status_ === 'pending_admin') {
        waitingText.textContent = 'Ожидание подтверждения другого администратора...';
      } else if (status_ === 'approved') {
        stopPolling();
        await finishLogin(token);
      } else if (status_ === 'rejected') {
        stopPolling();
        showScreen('rejected');
      } else if (status_ === null) {
        stopPolling();
        showScreen('login');
      }
    } catch (err) {
      console.error(err);
    }
  }, POLL_INTERVAL_MS);
}

async function finishLogin(token) {
  // approved на сервере ещё не значит "админ" — это может быть обычный
  // одобренный пользователь. admin-action сам проверяет ADMIN_CHAT_IDS и
  // вернёт 403, если это не один из двух админов. Этот же вызов сразу даёт
  // список пользователей — раньше здесь был отдельный "пробный" запрос
  // list_users только ради проверки прав, а loadUsers() тут же повторял
  // тот же запрос заново, удваивая время первой загрузки.
  let users;
  try {
    ({ users } = await callFunction('admin-action', { action: 'list_users', adminToken: token }));
  } catch (err) {
    if (err.status === 403) {
      loginError.textContent = 'Эта учётная запись не администратор.';
    } else {
      loginError.textContent = 'Ошибка проверки прав: ' + err.message;
    }
    showScreen('login');
    return;
  }
  adminToken = token;
  localStorage.setItem(TOKEN_KEY, token);
  showScreen('admin');
  renderUsersList(users);
}

function logout() {
  adminToken = null;
  localStorage.removeItem(TOKEN_KEY);
  showScreen('login');
}

// ------------------------------- Вкладки -------------------------------

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tab-users').hidden = tab !== 'users';
  document.getElementById('tab-history').hidden = tab !== 'history';
  document.getElementById('tab-chat').hidden = tab !== 'chat';
  if (tab === 'users') loadUsers();
  if (tab === 'history') loadHistoryForSelectedDate();
  if (tab === 'chat') loadChatThreads();
}

// ------------------------------- Пользователи -------------------------------

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function onlineStatus(lastHeartbeatAt) {
  if (!lastHeartbeatAt) return { online: false, label: 'не в сети' };
  const ms = Date.now() - new Date(lastHeartbeatAt).getTime();
  if (ms < ONLINE_THRESHOLD_MS) return { online: true, label: 'в сети' };
  return { online: false, label: `был(а) ${fmtDate(lastHeartbeatAt)} ${fmtTime(lastHeartbeatAt)}` };
}

async function loadUsers() {
  const listEl = document.getElementById('users-list');
  listEl.innerHTML = '<p class="empty-note">Загрузка...</p>';
  try {
    const { users } = await adminAction('list_users', {});
    renderUsersList(users);
  } catch (err) {
    listEl.innerHTML = '';
    listEl.appendChild(emptyNote('Ошибка: ' + err.message));
  }
}

function renderUsersList(users) {
  const listEl = document.getElementById('users-list');
  listEl.innerHTML = '';
  if (!users.length) {
    listEl.appendChild(emptyNote('Пользователей нет.'));
    return;
  }
  for (const u of users) listEl.appendChild(renderUserCard(u));
}

// Пользовательские данные (имя/username из Telegram-профиля, текст
// сообщений, IP/device) нельзя вставлять через innerHTML — Telegram
// first_name/last_name задаёт сам пользователь произвольной строкой,
// и это единственная админ-панель, где их видит человек с правами
// (persistent XSS иначе). Собираем разметку из DOM-узлов, весь
// пользовательский текст идёт только через textContent.
function emptyNote(text) {
  const p = document.createElement('p');
  p.className = 'empty-note';
  p.textContent = text;
  return p;
}

function renderUserCard(u) {
  const card = document.createElement('div');
  card.className = 'card-row';
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || `id ${u.telegram_id}`;
  const online = onlineStatus(u.last_heartbeat_at);

  card.innerHTML = `
    <div class="card-row-top">
      <div>
        <div class="card-name"></div>
        <div class="card-sub"><span class="online-dot ${online.online ? 'online' : ''}"></span><span class="online-label"></span></div>
      </div>
      <span class="badge ${u.trusted ? 'trusted' : ''}">${u.trusted ? 'Доверенный' : 'Обычный'}</span>
    </div>
    <div class="card-actions">
      <button class="chip-btn trusted-btn">${u.trusted ? 'Снять доверие' : 'Доверенный'}</button>
      <button class="chip-btn history-btn">История входов</button>
      <button class="chip-btn ${u.blocked ? 'success' : 'danger'} kick-btn">${u.blocked ? 'Восстановить' : 'Кикнуть'}</button>
    </div>
  `;
  card.querySelector('.card-name').textContent = name + (u.username ? ` @${u.username}` : '');
  card.querySelector('.online-label').textContent = online.label;

  card.querySelector('.trusted-btn').addEventListener('click', async () => {
    try {
      await adminAction('set_trusted', { targetTelegramId: u.telegram_id, trusted: !u.trusted });
      u.trusted = !u.trusted;
      renderUsersRefreshRow(card, u, name);
    } catch (err) { alert('Ошибка: ' + err.message); }
  });

  card.querySelector('.kick-btn').addEventListener('click', async () => {
    const confirmMsg = u.blocked
      ? 'Восстановить доступ этому пользователю?'
      : 'Кикнуть пользователя? Если у него сейчас открыт AUTOMAX KG — он будет закрыт принудительно в течение нескольких секунд, даже во время активной записи на машину.';
    if (!confirm(confirmMsg)) return;
    try {
      await adminAction(u.blocked ? 'unkick' : 'kick', { targetTelegramId: u.telegram_id });
      u.blocked = !u.blocked;
      renderUsersRefreshRow(card, u, name);
    } catch (err) { alert('Ошибка: ' + err.message); }
  });

  card.querySelector('.history-btn').addEventListener('click', () => openLoginHistory(u, name));

  return card;
}

function renderUsersRefreshRow(card, u, name) {
  const replacement = renderUserCard(u);
  card.replaceWith(replacement);
}

// ------------------------------- История входов (по пользователю) -------------------------------

const overlay = document.getElementById('user-detail-overlay');
const overlayTitle = document.getElementById('user-detail-title');
const overlayBody = document.getElementById('user-detail-body');

document.getElementById('user-detail-close').addEventListener('click', () => { overlay.hidden = true; });

async function openLoginHistory(u, name) {
  overlayTitle.textContent = `${name} — история входов`;
  overlayBody.innerHTML = '';
  overlayBody.appendChild(emptyNote('Загрузка...'));
  overlay.hidden = false;
  try {
    const { logins } = await adminAction('list_login_history', { targetTelegramId: u.telegram_id });
    overlayBody.innerHTML = '';
    if (!logins.length) {
      overlayBody.appendChild(emptyNote('Записей нет.'));
      return;
    }
    for (const l of logins) {
      const row = document.createElement('div');
      row.className = 'event-row';
      const place = [l.city, l.country].filter(Boolean).join(', ') || 'город неизвестен';
      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${fmtDate(l.created_at)} ${fmtTime(l.created_at)}`;
      const placeEl = document.createElement('div');
      placeEl.textContent = place;
      const detailEl = document.createElement('div');
      detailEl.style.color = 'var(--muted)';
      detailEl.textContent = `${l.ip || '—'} · ${l.device || '—'}`;
      row.append(timeEl, placeEl, detailEl);
      overlayBody.appendChild(row);
    }
  } catch (err) {
    overlayBody.innerHTML = '';
    overlayBody.appendChild(emptyNote('Ошибка: ' + err.message));
  }
}

// ------------------------------- История сессий (по дате) -------------------------------

const historyDateInput = document.getElementById('history-date');

function todayLocalIso() {
  const d = new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

historyDateInput.value = todayLocalIso();
historyDateInput.addEventListener('change', loadHistoryForSelectedDate);

async function loadHistoryForSelectedDate() {
  const date = historyDateInput.value || todayLocalIso();
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<p class="empty-note">Загрузка...</p>';
  const [y, m, d] = date.split('-').map(Number);
  const startIso = new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
  const endIso = new Date(y, m - 1, d + 1, 0, 0, 0, 0).toISOString();
  try {
    const { sessions } = await adminAction('list_sessions_by_date', { startIso, endIso });
    listEl.innerHTML = '';
    if (!sessions.length) {
      listEl.appendChild(emptyNote('За эту дату сессий нет.'));
      return;
    }
    for (const s of sessions) listEl.appendChild(renderSessionCard(s));
  } catch (err) {
    listEl.innerHTML = '';
    listEl.appendChild(emptyNote('Ошибка: ' + err.message));
  }
}

function renderSessionCard(s) {
  const card = document.createElement('div');
  card.className = 'card-row';
  const name = s.telegram_username ? `@${s.telegram_username}` : (s.telegram_name || `id ${s.telegram_id}`);
  card.innerHTML = `
    <div class="card-row-top">
      <div>
        <div class="card-name"></div>
        <div class="card-sub"></div>
      </div>
      <button class="paid-toggle-btn ${s.paid ? 'paid' : 'unpaid'}">${s.paid ? 'Оплачено' : 'Не оплачено'}</button>
    </div>
  `;
  card.querySelector('.card-name').textContent = name;
  card.querySelector('.card-sub').textContent =
    `${s.brand} ${s.model} · ${fmtTime(s.started_at)}${s.ended_at ? ' – ' + fmtTime(s.ended_at) : ' · в процессе'}`;
  card.querySelector('.paid-toggle-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const next = !s.paid;
    try {
      await adminAction('set_paid', { sessionId: s.id, paid: next });
      s.paid = next;
      const btn = e.currentTarget;
      btn.classList.toggle('paid', next);
      btn.classList.toggle('unpaid', !next);
      btn.textContent = next ? 'Оплачено' : 'Не оплачено';
    } catch (err) { alert('Ошибка: ' + err.message); }
  });
  card.addEventListener('click', () => openSessionEvents(s, name));
  return card;
}

async function openSessionEvents(s, name) {
  overlayTitle.textContent = `${name} — ${s.brand} ${s.model}`;
  overlayBody.innerHTML = '';
  overlayBody.appendChild(emptyNote('Загрузка...'));
  overlay.hidden = false;
  try {
    const { events } = await adminAction('list_session_events', { sessionId: s.id });
    overlayBody.innerHTML = '';
    if (!events.length) {
      overlayBody.appendChild(emptyNote('Событий не зафиксировано.'));
      return;
    }
    for (const ev of events) {
      const row = document.createElement('div');
      row.className = 'event-row';
      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = `${fmtDate(ev.created_at)} ${fmtTime(ev.created_at)}`;
      const typeEl = document.createElement('div');
      typeEl.textContent = ev.event_type;
      row.append(timeEl, typeEl);
      overlayBody.appendChild(row);
    }
  } catch (err) {
    overlayBody.innerHTML = '';
    overlayBody.appendChild(emptyNote('Ошибка: ' + err.message));
  }
}

// ------------------------------- Чат с пользователями (Блок 7) -------------------------------

let activeChatTelegramId = null;

async function loadChatThreads() {
  const listEl = document.getElementById('chat-threads-list');
  listEl.innerHTML = '';
  listEl.appendChild(emptyNote('Загрузка...'));
  try {
    const { threads } = await adminAction('list_support_threads', {});
    listEl.innerHTML = '';
    if (!threads.length) {
      listEl.appendChild(emptyNote('Сообщений нет.'));
      return;
    }
    for (const t of threads) listEl.appendChild(renderChatThreadCard(t));
  } catch (err) {
    listEl.innerHTML = '';
    listEl.appendChild(emptyNote('Ошибка: ' + err.message));
  }
}

function chatThreadName(t) {
  if (!t.user) return `id ${t.telegram_id}`;
  return t.user.username ? `@${t.user.username}` : [t.user.first_name, t.user.last_name].filter(Boolean).join(' ') || `id ${t.telegram_id}`;
}

function renderChatThreadCard(t) {
  const card = document.createElement('div');
  card.className = 'card-row';
  const name = chatThreadName(t);
  const nameEl = document.createElement('div');
  nameEl.className = 'card-name';
  nameEl.textContent = name;
  const previewEl = document.createElement('div');
  previewEl.className = 'chat-thread-preview';
  previewEl.textContent = (t.last_sender === 'admin' ? 'Вы: ' : '') + t.last_text;
  card.append(nameEl, previewEl);
  card.addEventListener('click', () => openChatConversation(t.telegram_id, name));
  return card;
}

const chatScreen = document.getElementById('chat-conversation-screen');

async function openChatConversation(telegramId, name) {
  activeChatTelegramId = telegramId;
  document.getElementById('chat-conversation-title').textContent = name;
  const messagesEl = document.getElementById('chat-conversation-messages');
  messagesEl.innerHTML = '';
  messagesEl.appendChild(emptyNote('Загрузка...'));
  chatScreen.hidden = false;
  try {
    const { messages } = await adminAction('list_support_messages', { targetTelegramId: telegramId });
    renderChatMessages(messages);
  } catch (err) {
    messagesEl.innerHTML = '';
    messagesEl.appendChild(emptyNote('Ошибка: ' + err.message));
  }
}

function renderChatMessages(messages) {
  const messagesEl = document.getElementById('chat-conversation-messages');
  messagesEl.innerHTML = '';
  for (const m of messages) {
    const row = document.createElement('div');
    row.className = `msg ${m.sender_role === 'admin' ? 'from-admin' : 'from-user'}`;
    const textEl = document.createElement('div');
    textEl.textContent = m.text;
    const timeEl = document.createElement('div');
    timeEl.className = 'msg-time';
    timeEl.textContent = `${fmtDate(m.created_at)} ${fmtTime(m.created_at)}`;
    row.append(textEl, timeEl);
    messagesEl.appendChild(row);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

let chatReplySending = false;

async function sendChatReply() {
  const input = document.getElementById('chat-reply-input');
  const text = input.value.trim();
  if (!text || !activeChatTelegramId) return;
  // Клик по кнопке и Enter в поле оба вызывают эту функцию, а сам запрос
  // к admin-action не мгновенный — без блокировки на время отправки
  // повторный клик/Enter до ответа сервера реально дублирует сообщение
  // (найдено вживую: одна и та же реплика дважды подряд в переписке).
  // Проверка флага здесь, синхронно, до первого await — input.disabled
  // ниже тоже блокирует, но применяется только после первой паузы, а два
  // вызова, начавшиеся почти одновременно, оба успевают проскочить эту
  // проверку раньше, чем DOM-свойство станет true.
  if (chatReplySending) return;
  chatReplySending = true;
  const sendBtn = document.getElementById('chat-reply-send-btn');
  input.disabled = true;
  sendBtn.disabled = true;
  try {
    await adminAction('send_support_reply', { targetTelegramId: activeChatTelegramId, text });
    input.value = '';
    const { messages } = await adminAction('list_support_messages', { targetTelegramId: activeChatTelegramId });
    renderChatMessages(messages);
  } catch (err) {
    alert('Не удалось отправить: ' + err.message);
  } finally {
    chatReplySending = false;
    input.disabled = false;
    sendBtn.disabled = false;
  }
}

document.getElementById('chat-conversation-back').addEventListener('click', () => {
  chatScreen.hidden = true;
  activeChatTelegramId = null;
  loadChatThreads();
});
document.getElementById('chat-reply-send-btn').addEventListener('click', sendChatReply);
document.getElementById('chat-reply-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChatReply();
});

// ------------------------------- Инициализация -------------------------------

document.getElementById('tg-login-btn').addEventListener('click', beginLogin);
document.getElementById('cancel-login-btn').addEventListener('click', () => { stopPolling(); showScreen('login'); });
document.getElementById('rejected-back-btn').addEventListener('click', () => showScreen('login'));
document.getElementById('logout-btn').addEventListener('click', logout);
document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

(async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  const saved = localStorage.getItem(TOKEN_KEY);
  if (saved) {
    try {
      const { users } = await callFunction('admin-action', { action: 'list_users', adminToken: saved });
      adminToken = saved;
      showScreen('admin');
      renderUsersList(users);
      return;
    } catch (err) {
      localStorage.removeItem(TOKEN_KEY);
    }
  }
  showScreen('login');
})();
