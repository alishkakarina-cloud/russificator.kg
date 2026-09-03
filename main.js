const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

app.disableHardwareAcceleration();

// Локальная сессия на этом устройстве: сохраняется в файле в системной
// пользовательской папке (userData) — при копировании на другой компьютер
// не переносится и не работает там, чего требованием и ограничивались.
// clearInvalidConfig: если файл сессии повреждён (например, вручную
// отредактирован или битая запись на диск) — сбрасываем его вместо падения
// всего приложения при старте.
const sessionStore = new Store({ name: 'session', clearInvalidConfig: true });

// Внешняя программа AUTOMAX KG. Не изменять, не переписывать — только запуск
// как отдельный процесс. Исходно лежала видимо на Рабочем столе; при первом
// запуске обновлённого приложения переносится (см. migrateAutomaxKg ниже) в
// скрытую системную папку рядом с остальными служебными файлами (session.json
// и т.п.), чтобы случайный/обычный пользователь не наткнулся на неё в
// проводнике в обход входа. Это снижает шанс случайного обхода, но не
// защищает от того, кто целенаправленно ищет скрытые файлы — папка всё ещё
// физически на диске, просто со стандартным Windows-атрибутом "скрытый".
const AUTOMAXKG_OLD_DIR = 'C:\\Users\\alish\\OneDrive\\Desktop\\rusifikatorkg';
const AUTOMAXKG_OLD_BAT_PATH = path.join(AUTOMAXKG_OLD_DIR, '@AUTOMAXKG) .bat');
const AUTOMAXKG_DIR = path.join(app.getPath('userData'), 'runtime-data');
const AUTOMAXKG_BAT_PATH = path.join(AUTOMAXKG_DIR, '@AUTOMAXKG) .bat');

function sleepSync(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

// Разовый перенос: срабатывает один раз на компьютере, где всё ещё стоит
// старая видимая копия. Пробуем move (rename) — данные не теряются, просто
// меняют путь; папка лежит в OneDrive Desktop, и его же процесс может держать
// на ней хэндл (EBUSY), а не только классический EXDEV (разные диски) —
// поэтому при любой ошибке rename после пары попыток откатываемся на
// реальное копирование байтов (это обычно проходит, даже когда сам rename
// директории не проходит) с последующим удалением исходника.
function migrateAutomaxKg() {
  if (fs.existsSync(AUTOMAXKG_BAT_PATH)) return; // уже перенесено раньше
  if (!fs.existsSync(AUTOMAXKG_OLD_BAT_PATH)) return; // нечего переносить, работаем со старого пути

  let renamed = false;
  let lastErr = null;
  for (let attempt = 0; attempt < 3 && !renamed; attempt++) {
    try {
      if (attempt > 0) sleepSync(700);
      fs.renameSync(AUTOMAXKG_OLD_DIR, AUTOMAXKG_DIR);
      renamed = true;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!renamed) {
    try {
      console.log('rename не прошёл (' + lastErr?.code + '), переносим копированием байтов:', AUTOMAXKG_OLD_DIR);
      fs.cpSync(AUTOMAXKG_OLD_DIR, AUTOMAXKG_DIR, { recursive: true });
    } catch (copyErr) {
      console.error('Не удалось перенести AUTOMAX KG в скрытую папку — работаем со старого видимого пути', copyErr);
      return;
    }
    cleanupOldAutomaxKgDir();
  }

  try {
    execFileSync('attrib', ['+h', AUTOMAXKG_DIR]);
  } catch (attrErr) {
    console.error('Перенесено, но не удалось выставить атрибут "скрытый"', attrErr);
  }
  console.log('AUTOMAX KG перенесена в скрытую папку:', AUTOMAXKG_DIR);
}

// Удаляет старую копию после успешного копирования в новое место. Без
// ретраев с ожиданием здесь: эта функция вызывается на каждом старте
// приложения (на случай если OneDrive в прошлый раз мешал), а не только
// один раз при миграции — блокирующие повторные попытки задерживали бы
// открытие окна на каждом запуске, пока OneDrive держит папку (может быть
// постоянно). Одна быстрая попытка: получилось — отлично, нет — просто
// убеждаемся, что атрибут "скрытый" всё равно стоит, и не мешаем запуску.
function cleanupOldAutomaxKgDir() {
  if (!fs.existsSync(AUTOMAXKG_OLD_DIR)) return;

  try {
    fs.rmSync(AUTOMAXKG_OLD_DIR, { recursive: true, force: true });
    console.log('Старая копия AUTOMAX KG удалена с Рабочего стола.');
    return;
  } catch (rmErr) {
    try {
      execFileSync('attrib', ['+h', AUTOMAXKG_OLD_DIR]);
    } catch (attrErr) {
      console.error('Не удалось ни удалить, ни скрыть старую копию', attrErr);
    }
  }
}

// Если перенос по какой-то причине не удался — приложение продолжает
// работать со старого видимого пути, а не ломает запуск AUTOMAX KG.
function getAutomaxKgLaunchPath() {
  return fs.existsSync(AUTOMAXKG_BAT_PATH) ? AUTOMAXKG_BAT_PATH : AUTOMAXKG_OLD_BAT_PATH;
}

const MAIN_SIZE = { width: 480, height: 640 };
const ADMIN_SIZE = { width: 860, height: 700 };

let mainWindow = null;

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
}

ipcMain.handle('launch-automaxkg', async () => {
  // Открывает AUTOMAX KG так же, как двойной клик в проводнике: отдельное окно,
  // рабочая директория выставляется системой в папку файла сама (относительные пути внутри .bat это требуют).
  const errorMessage = await shell.openPath(getAutomaxKgLaunchPath());
  if (errorMessage) {
    return { ok: false, error: errorMessage };
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

app.whenReady().then(() => {
  migrateAutomaxKg();
  // Если сама папка уже перенесена, но старую видимую копию в прошлый раз
  // не удалось убрать (OneDrive держал хэндл) — пробуем на каждом следующем
  // запуске, пока не получится.
  cleanupOldAutomaxKgDir();
  createWindow();

  // Обновление кода приложения (это) и обновление файлов прошивок AUTOMAX KG —
  // разные, никак не связанные механизмы. Здесь только про сам код.
  // Тихая докачка + применение при следующем перезапуске — поведение
  // electron-updater по умолчанию; checkForUpdatesAndNotify сама показывает
  // системное уведомление, когда обновление скачано.
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('Проверка обновлений не удалась', err);
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
