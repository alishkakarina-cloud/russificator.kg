const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
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

// Внешняя программа AUTOMAX KG. Не изменять, не переписывать — только запуск как отдельный процесс.
const AUTOMAXKG_BAT_PATH = 'C:\\Users\\alish\\OneDrive\\Desktop\\rusifikatorkg\\@AUTOMAXKG) .bat';

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
  const errorMessage = await shell.openPath(AUTOMAXKG_BAT_PATH);
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
