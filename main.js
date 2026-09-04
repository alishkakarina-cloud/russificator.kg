const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
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
// как отдельный процесс. Файлы не входят в публичный установщик (они —
// приватная бизнес-прошивка) и не привязаны ни к какому конкретному
// компьютеру или пользователю Windows: путь всегда вычисляется от
// app.getPath('userData'), который на любой машине указывает в правильное
// место сам по себе. Если файлов там ещё нет (первый запуск на новом
// компьютере) — они скачиваются с приватного хранилища после входа, см.
// automaxkg-status/automaxkg-download ниже.
const AUTOMAXKG_DIR = path.join(app.getPath('userData'), 'runtime-data');
const AUTOMAXKG_BAT_PATH = path.join(AUTOMAXKG_DIR, '@AUTOMAXKG) .bat');

function getAutomaxKgLaunchPath() {
  return AUTOMAXKG_BAT_PATH;
}

function isAutomaxKgPresent() {
  return fs.existsSync(AUTOMAXKG_BAT_PATH);
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

ipcMain.handle('automaxkg-status', () => ({ available: isAutomaxKgPresent() }));

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
