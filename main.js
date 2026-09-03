const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

// Внешняя программа AUTOMAX KG. Не изменять, не переписывать — только запуск как отдельный процесс.
const AUTOMAXKG_BAT_PATH = 'C:\\Users\\alish\\OneDrive\\Desktop\\rusifikatorkg\\@AUTOMAXKG) .bat';

function createWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 640,
    title: 'russificator.kg',
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
