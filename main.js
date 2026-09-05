const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execFileSync } = require('child_process');
const pty = require('node-pty');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// У окна приложения нет консоли — без файлового лога любая проблема с
// автообновлением (не тот файл скачался, не удалось запустить установщик и
// т.п.) была абсолютно невидима: ошибка просто улетала в console.error в
// никуда. Лог пишется в %APPDATA%\russificator-kg\logs\main.log.
log.transports.file.level = 'info';
autoUpdater.logger = log;

app.disableHardwareAcceleration();

// Обнаружено при диагностике зависаний автообновления: фоновая проверка
// обновлений (не связанная напрямую с активной работой пользователя) в
// редких случаях может привести к необработанной ошибке где-то в глубине
// electron-updater/сетевого стека — без этого перехватчика такая ошибка
// уронила бы ВЕСЬ процесс целиком, включая активный терминал AUTOMAX KG,
// если пользователь в этот момент как раз русифицирует машину. Автообновление
// никогда не должно иметь возможность оборвать активную работу — логируем и
// продолжаем жить, вместо того чтобы дать процессу упасть.
process.on('uncaughtException', (err) => {
  log.error('[критично] Необработанное исключение — процесс продолжает работу:', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('[критично] Необработанный отказ промиса — процесс продолжает работу:', reason);
});

// Локальная сессия на этом устройстве: сохраняется в файле в системной
// пользовательской папке (userData) — при копировании на другой компьютер
// не переносится и не работает там, чего требованием и ограничивались.
// clearInvalidConfig: если файл сессии повреждён (например, вручную
// отредактирован или битая запись на диск) — сбрасываем его вместо падения
// всего приложения при старте.
const sessionStore = new Store({ name: 'session', clearInvalidConfig: true });

// Внешняя программа AUTOMAX KG. Не изменять, не переписывать — только запуск
// как отдельный процесс. Файлы не входят в публичный установщик (они —
// приватная бизнес-прошивка) и не привязаны ни к какому конкретному
// компьютеру или пользователю Windows: путь всегда вычисляется от
// app.getPath('userData'), который на любой машине указывает в правильное
// место сам по себе. Если файлов там ещё нет (первый запуск на новом
// компьютере) — они скачиваются с приватного хранилища после входа, см.
// automaxkg-status/automaxkg-download ниже.
const AUTOMAXKG_DIR = path.join(app.getPath('userData'), 'runtime-data');
const AUTOMAXKG_BAT_PATH = path.join(AUTOMAXKG_DIR, '@AUTOMAXKG) .bat');

function isAutomaxKgPresent() {
  return fs.existsSync(AUTOMAXKG_BAT_PATH);
}

// Единственный источник AUTOMAX KG теперь — облачная докачка через Supabase
// после входа (см. automaxkg-download ниже). До этого AUTOMAX KG раньше
// существовала отдельными самостоятельными копиями (видимая на Рабочем
// столе/в OneDrive, плюс случайные дубликаты от более ранних попыток её
// скрыть) — эти копии больше не нужны и не должны оставаться на диске в
// обход программы.
//
// Список путей сознательно узкий — только точные места, куда наша же
// программа в разное время реально клала AUTOMAX KG. Мы намеренно НЕ
// сканируем весь диск/Рабочий стол/Документы в поисках "чего-то похожего":
// код, который сам ищет и молча удаляет файлы по всему компьютеру
// пользователя, — это ровно то поведение, которое антивирусы распознают как
// вредоносное (вайпер), и могло бы усилить недоверие Windows к программе,
// а не снять его.
function getKnownOrphanedAutomaxKgDirs() {
  const home = os.homedir();
  return [
    path.join(home, 'OneDrive', 'Desktop', 'rusifikatorkg'),
    path.join(home, 'Desktop', 'rusifikatorkg'),
    'C:\\rusifikatorkg',
  ];
}

// Прежде чем удалить — проверяем, что это действительно похоже на AUTOMAX KG
// по содержимому (adb.exe рядом с папкой apk или tinove), а не просто
// случайная папка с похожим именем/путём у пользователя. Файла самого .bat
// может не быть (встречались неполные копии от прежних попыток переноса) —
// поэтому проверяем по инструментам, а не по нему.
function looksLikeAutomaxKgDir(dir) {
  try {
    const hasAdb = fs.existsSync(path.join(dir, 'adb.exe'));
    const hasKnownSubdir = fs.existsSync(path.join(dir, 'apk')) || fs.existsSync(path.join(dir, 'tinove'));
    return hasAdb && hasKnownSubdir;
  } catch {
    return false;
  }
}

function cleanupOrphanedAutomaxKgCopies() {
  const removed = [];
  for (const dir of getKnownOrphanedAutomaxKgDirs()) {
    if (path.resolve(dir) === path.resolve(AUTOMAXKG_DIR)) continue; // на всякий случай не даём задеть рабочую копию
    if (!fs.existsSync(dir)) continue;
    if (!looksLikeAutomaxKgDir(dir)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
      console.log('Удалена старая независимая копия AUTOMAX KG:', dir);
    } catch (err) {
      console.error('Не удалось удалить старую копию AUTOMAX KG:', dir, err);
    }
  }
  return removed;
}

// AUTOMAX KG теперь запускается не отдельным окном ОС (shell.openPath), а
// управляемым дочерним процессом через псевдотерминал (node-pty) — вывод и
// ввод зеркалятся в терминал внутри главного окна (renderer, xterm.js). Сама
// AUTOMAX KG (её .bat, её меню) не меняется — меняется только способ запуска
// и отображения. Единовременно может быть активен только один процесс, как
// и раньше был возможен только один car_session.
let activePty = null;

function killActivePty() {
  if (activePty) {
    try {
      activePty.kill();
    } catch (err) {
      console.error('Не удалось завершить процесс AUTOMAX KG', err);
    }
    activePty = null;
  }
}

// Скачивает один файл по прямой (подписанной) ссылке в destPath, следуя
// редиректам вручную — Supabase Storage сам по себе не редиректит, но код
// написан на случай, если ссылка когда-то будет проксироваться через CDN.
function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const doGet = (u) => {
      const req = https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          doGet(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} для ${u}`));
          return;
        }

        const file = fs.createWriteStream(destPath);
        // Обрыв соединения посреди передачи выдаёт 'error' на самом потоке
        // ответа (res), не только на запросе — без этого слушателя такая
        // ошибка ушла бы необработанной и могла уронить весь процесс main.js.
        let settled = false;
        const fail = (err) => {
          if (settled) return;
          settled = true;
          file.destroy();
          fs.rm(destPath, { force: true }, () => {});
          reject(err);
        };
        res.on('error', fail);
        file.on('error', fail);
        res.pipe(file);
        file.on('finish', () => {
          if (settled) return;
          settled = true;
          file.close(() => resolve());
        });
      });
      req.on('error', reject);
    };
    doGet(url);
  });
}

// Части больших файлов (>50МБ) были загружены в хранилище раздельно как
// <путь>.part000, <путь>.part001, ... (см. upload_large_files.js в истории
// разработки) из-за ограничения бесплатного плана Supabase Storage в 50МБ на
// объект. После скачивания всех частей на диск клиента их нужно склеить
// обратно в один файл в исходном порядке и удалить сами части.
function reassembleParts(dir) {
  const partRe = /\.part(\d{3})$/;
  const groups = {};

  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const m = entry.name.match(partRe);
        if (m) {
          const base = full.slice(0, -m[0].length);
          (groups[base] = groups[base] || []).push({ full, idx: Number(m[1]) });
        }
      }
    }
  }
  walk(dir);

  for (const base of Object.keys(groups)) {
    const parts = groups[base].sort((a, b) => a.idx - b.idx);
    // Если какая-то часть не докачалась (обрыв сети), индексы будут не
    // подряд — проверяем ДО удаления/склейки, чтобы не оставить на диске
    // молча повреждённый (укороченный) файл вместо явной ошибки.
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].idx !== i) {
        throw new Error(
          `отсутствует часть ${path.basename(base)}.part${String(i).padStart(3, '0')} — скачивание неполное`
        );
      }
    }
    if (fs.existsSync(base)) fs.rmSync(base);
    for (const p of parts) {
      fs.appendFileSync(base, fs.readFileSync(p.full));
    }
    for (const p of parts) {
      fs.rmSync(p.full);
    }
  }
}

const MAIN_SIZE = { width: 480, height: 640 };
const ADMIN_SIZE = { width: 860, height: 700 };
const TERMINAL_SIZE = { width: 900, height: 640 };

let mainWindow = null;
let allowClose = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: MAIN_SIZE.width,
    height: MAIN_SIZE.height,
    title: 'russificator.kg',
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Без этого Chromium душит setInterval, пока окно свёрнуто/в фоне —
      // после ~5 минут в фоне таймеры схлопываются до одного тика в минуту.
      // Экран ожидания подтверждения именно так и живёт: пользователь
      // переключается в Telegram нажать Start, админ — в Telegram нажать
      // "Принять", а окно всё это время висит в фоне и должно продолжать
      // опрашивать статус каждые 2.5 сек, а не раз в минуту.
      backgroundThrottling: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // AUTOMAX KG теперь наш дочерний процесс — закрытие окна во время активной
  // работы с машиной реально его убьёт (раньше не могло, это было отдельное
  // окно ОС). Если это может прервать запись на устройство, предупреждаем и
  // требуем явного подтверждения, а не закрываем молча.
  mainWindow.on('close', (e) => {
    if (allowClose || !activePty) return;
    e.preventDefault();
    dialog
      .showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Закрыть', 'Отмена'],
        defaultId: 1,
        cancelId: 1,
        title: 'AUTOMAX KG ещё работает',
        message: 'AUTOMAX KG ещё работает с подключённой машиной.',
        detail: 'Если сейчас идёт запись на устройство, закрытие может её прервать. Закрыть всё равно?',
      })
      .then((result) => {
        if (result.response === 0) {
          allowClose = true;
          killActivePty();
          mainWindow.close();
        }
      });
  });
}

// Запускает AUTOMAX KG как управляемый дочерний процесс через псевдотерминал
// вместо отдельного окна ОС. cwd выставляем явно в AUTOMAXKG_DIR — раньше
// рабочую директорию выставляла сама ОС по местоположению файла (как при
// двойном клике), здесь мы её задаём напрямую тем же результатом.
ipcMain.handle('automaxkg-terminal-start', (event, { cols, rows }) => {
  if (activePty) {
    return { ok: false, error: 'AUTOMAX KG уже запущена' };
  }
  if (!isAutomaxKgPresent()) {
    return { ok: false, error: 'Файлы AUTOMAX KG не найдены на этом компьютере' };
  }

  try {
    // Имя файла AUTOMAX KG содержит скобки и пробел ('@AUTOMAXKG) .bat'), а
    // у cmd.exe /c есть особая (задокументированная, но не самая очевидная)
    // логика снятия кавычек с аргумента: если внутри кавычек встречаются
    // спецсимволы вроде "(" ")", обычное экранирование пути ломается и cmd
    // обрезает путь ровно на скобке. Рабочий обход — обернуть путь ДВОЙНЫМИ
    // кавычками и передать готовую командную строку целиком (не массивом
    // аргументов, иначе node-pty заново заэкранирует уже готовые кавычки).
    // Проверено вручную на реальном файле AUTOMAX KG — без этого запуск
    // падает с "не является внутренней или внешней командой".
    activePty = pty.spawn('cmd.exe', `/d /s /c ""${AUTOMAXKG_BAT_PATH}""`, {
      name: 'xterm-256color',
      cols: cols > 0 ? cols : 80,
      rows: rows > 0 ? rows : 30,
      cwd: AUTOMAXKG_DIR,
      env: process.env,
    });
  } catch (err) {
    activePty = null;
    return { ok: false, error: err.message };
  }

  const sender = event.sender;
  activePty.onData((data) => {
    if (!sender.isDestroyed()) sender.send('automaxkg-terminal-data', data);
  });
  activePty.onExit(({ exitCode }) => {
    activePty = null;
    if (!sender.isDestroyed()) sender.send('automaxkg-terminal-exit', { exitCode });
  });

  return { ok: true };
});

// Каждое нажатие клавиши пользователем передаётся процессу как есть — это
// просто "окно-зеркало", никакой автоматизации ввода или разбора меню.
ipcMain.on('automaxkg-terminal-input', (_event, data) => {
  if (activePty) activePty.write(data);
});

ipcMain.on('automaxkg-terminal-resize', (_event, { cols, rows }) => {
  if (activePty && cols > 0 && rows > 0) {
    try {
      activePty.resize(cols, rows);
    } catch (err) {
      // Процесс мог уже завершиться между отправкой resize и обработкой.
    }
  }
});

// Раньше "Завершено" только фиксировало время в базе — сам процесс был
// независимым окном ОС, и программа не могла на него повлиять. Теперь это
// наш дочерний процесс, и мы можем его закрыть — но только по этому явному,
// осознанному действию пользователя, не принудительно по кику/таймауту (это
// поведение сознательно не меняется, см. touchSessionOrKick в renderer.js).
ipcMain.handle('automaxkg-terminal-kill', () => {
  killActivePty();
  return { ok: true };
});

ipcMain.handle('automaxkg-status', () => ({ available: isAutomaxKgPresent() }));

// Разовое уведомление для интерфейса о том, что при старте были найдены и
// удалены старые независимые копии AUTOMAX KG — renderer запрашивает это
// один раз после входа; если ничего не удалялось, вернётся пустой список и
// баннер просто не покажется.
ipcMain.handle('automaxkg-cleanup-result', () => orphanedCleanupResult);

// Скачивает файлы AUTOMAX KG с приватного хранилища в скрытую системную
// папку. Список файлов (с короткоживущими подписанными ссылками) renderer
// получает заранее от Edge Function automaxkg-manifest, которая сама
// проверяет, что пользователь вошёл и одобрен — здесь мы просто скачиваем
// то, что было выдано, без повторной проверки прав (это не точка входа
// для произвольных URL с фронтенда, ссылки всегда только от нашей функции).
ipcMain.handle('automaxkg-download', async (event, { files }) => {
  fs.mkdirSync(AUTOMAXKG_DIR, { recursive: true });
  const total = files.length;
  let done = 0;

  for (const f of files) {
    const destPath = path.join(AUTOMAXKG_DIR, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    let lastErr = null;
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        await downloadToFile(f.url, destPath);
        // Проверка целостности: без неё оборванная на середине закачка
        // молча остаётся на диске как будто всё хорошо, и позже AUTOMAX KG
        // может получить битый/укороченный файл, не зная об этом.
        if (typeof f.size === 'number' && f.size > 0) {
          const actualSize = fs.statSync(destPath).size;
          if (actualSize !== f.size) {
            throw new Error(`размер не совпадает (получено ${actualSize}, ожидалось ${f.size})`);
          }
        }
        ok = true;
      } catch (err) {
        lastErr = err;
        try {
          fs.rmSync(destPath, { force: true });
        } catch {}
      }
    }
    if (!ok) {
      return { ok: false, error: `Не удалось скачать ${f.path}: ${lastErr?.message || lastErr}` };
    }

    done++;
    event.sender.send('automaxkg-download-progress', { done, total });
  }

  try {
    reassembleParts(AUTOMAXKG_DIR);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  try {
    execFileSync('attrib', ['+h', AUTOMAXKG_DIR]);
  } catch (attrErr) {
    console.error('Скачано, но не удалось выставить атрибут "скрытый"', attrErr);
  }

  return { ok: true };
});

ipcMain.handle('open-external', async (_event, url) => {
  // Разрешаем открывать только Telegram-ссылки (диплинк логина), чтобы renderer
  // не мог заставить приложение открыть произвольный внешний адрес.
  if (typeof url !== 'string' || !/^https:\/\/t\.me\//.test(url)) {
    throw new Error('Разрешены только ссылки t.me');
  }
  await shell.openExternal(url);
});

ipcMain.handle('session-get', () => sessionStore.get('session') || null);

ipcMain.handle('session-set', (_event, data) => {
  sessionStore.set('session', data);
});

ipcMain.handle('session-clear', () => {
  sessionStore.delete('session');
});

ipcMain.handle('session-touch', () => {
  const session = sessionStore.get('session');
  if (!session) return null;
  session.lastActivityAt = Date.now();
  sessionStore.set('session', session);
  return session;
});

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('set-admin-mode', (_event, isAdmin) => {
  if (!mainWindow) return;
  const size = isAdmin ? ADMIN_SIZE : MAIN_SIZE;
  mainWindow.setResizable(true);
  mainWindow.setSize(size.width, size.height);
  mainWindow.center();
  mainWindow.setResizable(isAdmin);
});

ipcMain.handle('set-terminal-mode', (_event, isTerminal) => {
  if (!mainWindow) return;
  const size = isTerminal ? TERMINAL_SIZE : MAIN_SIZE;
  mainWindow.setResizable(true);
  mainWindow.setSize(size.width, size.height);
  mainWindow.center();
  mainWindow.setResizable(isTerminal);
});

let orphanedCleanupResult = [];

// Последний известный статус проверки обновления — renderer запрашивает его
// один раз при загрузке экрана входа (get-update-status, на случай если
// проверка уже успела завершиться до того, как renderer подписался на
// событие), плюс подписывается на живое событие ниже для случая, когда
// проверка ещё идёт в момент загрузки экрана.
let latestUpdateStatus = null;

function sendUpdateStatus(status) {
  latestUpdateStatus = status;
  if (mainWindow) mainWindow.webContents.send('update-status-changed', status);
}

ipcMain.handle('get-update-status', () => latestUpdateStatus);

ipcMain.handle('start-update-download', () => {
  autoUpdater.downloadUpdate().catch((err) => {
    log.error('[update] запуск докачки не удался', err);
    if (mainWindow) mainWindow.webContents.send('update-download-error', { message: err.message });
  });
  return { ok: true };
});

app.whenReady().then(() => {
  orphanedCleanupResult = cleanupOrphanedAutomaxKgCopies();
  createWindow();

  // Обновление кода приложения (это) и обновление файлов прошивок AUTOMAX KG —
  // разные, никак не связанные механизмы. Здесь только про сам код.
  if (app.isPackaged) {
    // Дифференциальная докачка (скачать только изменённые блоки, а не весь
    // файл заново) на практике стабильно падает с ошибкой "sha512 checksum
    // mismatch" при сравнении с предыдущей версией — воспроизведено и на
    // этом компьютере, и независимо на компьютере реального пользователя.
    // electron-updater сам откатывается на полную докачку при такой ошибке,
    // но именно на этом повторном заходе после сбоя докачка иногда зависает
    // без единой ошибки в логе (тоже подтверждено дважды на двух разных
    // машинах). Отключаем дифференциальную докачку совсем — качаем всегда
    // полный файл сразу, без промежуточного неудачного шага, который,
    // похоже, и оставляет соединение в нестабильном состоянии.
    autoUpdater.disableDifferentialDownload = true;

    // Раньше докачка начиналась сама, тихо, без ведома пользователя, сразу
    // как только находилось обновление (autoDownload по умолчанию — true).
    // Теперь только ПРОВЕРЯЕМ наличие обновления сразу при старте — саму
    // докачку запускает пользователь явно, нажав кнопку "Доступно новое
    // обновление" на экране входа (см. renderer.js, кнопка появляется/
    // прячется по событию update-status-changed).
    autoUpdater.autoDownload = false;

    autoUpdater.on('checking-for-update', () => log.info('[update] проверка обновлений...'));
    autoUpdater.on('update-available', (info) => {
      log.info('[update] найдено обновление:', info.version);
      sendUpdateStatus({ available: true, version: info.version });
    });
    autoUpdater.on('update-not-available', () => {
      log.info('[update] обновлений нет, версия актуальна');
      sendUpdateStatus({ available: false });
    });
    autoUpdater.on('download-progress', (p) => {
      log.info(`[update] скачивание: ${Math.round(p.percent)}%`);
      if (mainWindow) mainWindow.webContents.send('update-download-progress', { percent: p.percent });
    });
    autoUpdater.on('update-downloaded', (info) => {
      log.info('[update] обновление скачано полностью, применяем и перезапускаемся:', info.version);
      autoUpdater.quitAndInstall();
    });
    autoUpdater.on('error', (err) => {
      log.error('[update] ошибка автообновления:', err);
      if (mainWindow) mainWindow.webContents.send('update-download-error', { message: err.message });
    });

    autoUpdater.checkForUpdates().catch((err) => {
      log.error('Проверка обновлений не удалась', err);
    });
  }
});

app.on('window-all-closed', () => {
  // Подстраховка на случай, если окно закрылось в обход диалога выше
  // (например, через диспетчер задач) — не оставляем осиротевший процесс.
  killActivePty();
  if (process.platform !== 'darwin') app.quit();
});
