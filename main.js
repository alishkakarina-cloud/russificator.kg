const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
