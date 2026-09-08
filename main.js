const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
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
// Временная папка докачки — после того как все файлы скачаны и целостность
// каждого проверена (см. automaxkg-download ниже), переносится в
// AUTOMAXKG_DIR одним переименованием.
const AUTOMAXKG_STAGING_DIR = path.join(app.getPath('userData'), 'runtime-data-staging');

function isAutomaxKgPresent() {
  return fs.existsSync(AUTOMAXKG_BAT_PATH);
}

// Если один воркер бросает исключение, Promise.all реджектится немедленно,
// но ОСТАЛЬНЫЕ уже запущенные воркеры при этом не отменяются — они
// продолжают работать в фоне уже ПОСЛЕ того, как вызывающий код (например,
// повторная попытка после сбоя) продолжил выполнение. Поэтому здесь каждый
// воркер сам ловит свою ошибку и просто перестаёт брать новые задачи —
// Promise.all гарантированно дожидается ЗАВЕРШЕНИЯ всех воркеров (успешного
// или нет), и только после этого функция бросает первую пойманную ошибку.
// К моменту, когда caller видит исключение, в директории не остаётся
// никаких фоновых операций.
async function runPool(items, worker, concurrency) {
  const queue = [...items];
  let firstError = null;
  async function run() {
    while (queue.length && !firstError) {
      const item = queue.shift();
      try {
        await worker(item);
      } catch (err) {
        if (!firstError) firstError = err;
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  if (firstError) throw firstError;
}

// Рекурсивно перечисляет все файлы (не папки) в dir, относительные пути.
function walkFiles(dir) {
  const results = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else results.push(path.relative(dir, full));
    }
  }
  walk(dir);
  return results;
}

// На Windows fs.renameSync(tmp, original) иногда падает с кратковременным
// EPERM сразу после большой файловой операции — обычно это антивирус ещё
// держит файл на сканирование долю секунды. Несколько попыток с паузой
// почти всегда решают проблему без участия пользователя.
async function renameWithRetry(from, to, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 150 * (i + 1)));
    }
  }
}

// ---- Защита файлов AUTOMAX KG от случайного обнаружения ----
// Предыдущая попытка (полное шифрование AES-256-GCM + расшифровка во
// временную копию перед каждым запуском) один раз уже уронила реальную
// работу с машинами в проде (падение AUTOMAX KG с кодом 255 на нескольких
// марках после расшифровки, причина не найдена) — сама операция шифровки/
// расшифровки на "горячем пути" запуска оказалась ненадёжной. Вместо этого
// защита теперь целиком на уровне файловой системы, без прикосновения к
// содержимому файлов при каждом запуске: скрытые+системные атрибуты папки
// (ниже, в automaxkg-download) и права NTFS только для текущей учётной
// записи (restrictAccessToCurrentUser). Этого достаточно, чтобы обычный
// человек, оказавшийся за этим компьютером — не целенаправленный
// злоумышленник с инструментами восстановления/анализа диска — не нашёл и
// не скопировал файлы, и ничего не может сломать на запуске, потому что на
// запуске больше ничего не происходит с самими файлами.

// Обычное удаление (fs.rm) на NTFS не трогает байты содержимого — оно
// только убирает запись файла из каталога, поэтому программы восстановления
// (Recuva и подобные) могут вернуть файл, пока место на диске не
// переиспользовано чем-то другим. Здесь мы поверх содержимого файла один
// раз пишем случайные байты — это разрушает то самое содержимое, которое
// такие программы восстанавливают из оставшихся на диске данных — и только
// затем удаляем сам файл. Оговорка: на SSD с активным TRIM это не даёт
// формальной гарантии (контроллер диска мог уже физически перенести старые
// блоки при выравнивании износа) — цель здесь защититься от обычных
// программ восстановления, а не от лабораторного криминалистического
// анализа накопителя, и этой цели затирание отвечает.
const WIPE_CHUNK_SIZE = 4 * 1024 * 1024;

async function secureWipeFile(filePath) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r+');
    const { size } = await handle.stat();
    let offset = 0;
    while (offset < size) {
      const chunkSize = Math.min(WIPE_CHUNK_SIZE, size - offset);
      await handle.write(crypto.randomBytes(chunkSize), 0, chunkSize, offset);
      offset += chunkSize;
    }
    await handle.sync();
  } catch (err) {
    log.error(`Не удалось затереть файл перед удалением, будет просто удалён: ${filePath}`, err);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  await fs.promises.rm(filePath, { force: true });
}

// Затирание/удаление ~3ГБ по одному файлу упирается в диск — та же причина,
// что была у прежнего шифрования (проверено тогда: 6 параллельных операций
// дают почти двукратное ускорение, диск — узкое место, не процессор).
const WIPE_CONCURRENCY = 6;

async function secureWipeDir(dir) {
  if (!fs.existsSync(dir)) return;
  const files = walkFiles(dir);
  await runPool(files, (rel) => secureWipeFile(path.join(dir, rel)), WIPE_CONCURRENCY);
  await fs.promises.rm(dir, { recursive: true, force: true });
}

// Закрывает доступ к папке на уровне файловой системы: только текущая
// Windows-учётная запись (плюс SYSTEM, иначе некоторые системные операции с
// правами могут отказать) может её читать — второй человек, работающий за
// этим же компьютером под своим Windows-логином, не откроет файлы, даже
// зная путь. /inheritance:r обрывает наследование прав от родительской
// папки (иначе унаследованная группа "Пользователи" всё равно давала бы
// доступ на чтение всем учёткам компьютера), /grant:r заменяет список прав
// целиком, а не добавляет к унаследованному.
function restrictAccessToCurrentUser(dir) {
  const account = process.env.USERDOMAIN
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME;
  try {
    execFileSync(
      'icacls',
      [dir, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '/grant:r', 'SYSTEM:(OI)(CI)F'],
      { timeout: 15000 }
    );
  } catch (err) {
    log.error('Не удалось ограничить права доступа к папке AUTOMAX KG', err);
  }
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

async function cleanupOrphanedAutomaxKgCopies() {
  const removed = [];
  for (const dir of getKnownOrphanedAutomaxKgDirs()) {
    if (path.resolve(dir) === path.resolve(AUTOMAXKG_DIR)) continue; // на всякий случай не даём задеть рабочую копию
    if (!fs.existsSync(dir)) continue;
    if (!looksLikeAutomaxKgDir(dir)) continue;
    try {
      await secureWipeDir(dir);
      removed.push(dir);
      console.log('Удалена (с затиранием) старая независимая копия AUTOMAX KG:', dir);
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

// AUTOMAX KG (сторонняя программа — саму её не трогаем, но её поведение
// нужно учитывать) запускает внутри себя adb.exe, который по протоколу ADB
// стартует классический background-сервер: он намеренно отсоединяется от
// родителя и продолжает жить самостоятельно, чтобы не переустанавливать
// USB-соединение при каждом запуске. activePty.kill() убивает только
// cmd.exe/.bat, которые мы сами заспавнили через node-pty — уже
// "отсоединившийся" adb.exe этим не затрагивается и остаётся висеть в
// системе. Пока он жив, Windows держит его .exe-образ и загруженные им DLL
// (AdbWinApi.dll, AdbWinUsbApi.dll) заблокированными на уровне ОС — их
// нельзя ни перезаписать, ни переименовать, ни удалить, никакое число
// повторных попыток здесь не поможет, пока процесс не завершится. Отсюда
// EPERM на переименование/затирание файлов рабочей директории сразу после
// закрытия AUTOMAX KG.
//
// Убиваем только adb.exe, запущенный именно из НАШЕЙ рабочей директории —
// не трогаем сторонние adb.exe (например от Android Studio), если они у
// пользователя есть.
function killOrphanedAdbProcesses() {
  const dirs = [AUTOMAXKG_DIR];
  // Внутри одинарных кавычек PowerShell "\" — обычный символ, не escape (в
  // отличие от JS/JSON) — удваивать его не нужно, иначе -like перестаёт
  // совпадать с реальным путём (ровно так эта функция не сработала при
  // первом тесте: путь с "\\" не совпадал с реальным "\").
  const conditions = dirs
    .map((d) => `$_.ExecutablePath -like '${d.replace(/'/g, "''")}*'`)
    .join(' -or ');
  const script = `Get-CimInstance Win32_Process -Filter "Name='adb.exe'" -ErrorAction SilentlyContinue | Where-Object { ${conditions} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000 });
  } catch (err) {
    console.error('Не удалось завершить осиротевший процесс adb.exe', err);
  }
}

function killActivePty() {
  if (activePty) {
    try {
      activePty.kill();
    } catch (err) {
      console.error('Не удалось завершить процесс AUTOMAX KG', err);
    }
    activePty = null;
  }
  killOrphanedAdbProcesses();
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

  // Диагностика: ошибки/console.error из рендерера раньше нигде не
  // сохранялись (electron-log ловит только исключения из main-процесса) —
  // без этого баг вида "кнопка ничего не делает" из-за JS-исключения в
  // renderer.js было не отличить от сетевой/UI проблемы без ручного
  // открытия DevTools у пользователя.
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // В Electron 26+ level — строка ('error'/'warning'/'info'/'debug'), а не
    // число, как было в старых версиях API — проверяем оба варианта.
    if (level === 'error' || level === 'warning' || level === 2 || level === 3) {
      log.warn(`[renderer console] ${sourceId}:${line} ${message}`);
    }
  });

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
// Запускаем напрямую из AUTOMAXKG_DIR, без какого-либо промежуточного шага
// (файлы не шифруются — защита только на уровне ФС, см. комментарий у
// restrictAccessToCurrentUser выше).
ipcMain.handle('automaxkg-terminal-start', async (event, { cols, rows }) => {
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

ipcMain.handle('automaxkg-status', () => {
  return {
    available: isAutomaxKgPresent(),
  };
});

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
// Качает файлы во временную STAGING-папку, затем переносит в рабочую
// AUTOMAXKG_DIR и закрывает её от посторонних (скрытые+системные атрибуты +
// права NTFS, см. ниже) — без какой-либо криптографии на этом пути, см.
// комментарий про secureWipeFile/restrictAccessToCurrentUser выше.
ipcMain.handle('automaxkg-download', async (event, { files }) => {
  // Защита от осиротевшего adb.exe с предыдущего запуска программы (см.
  // killOrphanedAdbProcesses) — без этого secureWipeDir(AUTOMAXKG_STAGING_DIR)
  // ниже мог бы упасть на заблокированном файле ещё до начала докачки.
  killOrphanedAdbProcesses();
  await secureWipeDir(AUTOMAXKG_STAGING_DIR);
  fs.mkdirSync(AUTOMAXKG_STAGING_DIR, { recursive: true });
  const total = files.length;
  let done = 0;

  for (const f of files) {
    const destPath = path.join(AUTOMAXKG_STAGING_DIR, ...f.path.split('/'));
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
    reassembleParts(AUTOMAXKG_STAGING_DIR);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Если в AUTOMAXKG_DIR уже была предыдущая копия (переустановка/повторная
  // докачка) — затираем её перед заменой, а не просто удаляем (см.
  // secureWipeFile выше). Само перемещение — через renameWithRetry: на
  // Windows переименование сразу после большой файловой операции иногда
  // ловит кратковременный EPERM (антивирус ещё держит файл), несколько
  // попыток с паузой почти всегда решают это без участия пользователя.
  try {
    if (fs.existsSync(AUTOMAXKG_DIR)) await secureWipeDir(AUTOMAXKG_DIR);
    await renameWithRetry(AUTOMAXKG_STAGING_DIR, AUTOMAXKG_DIR);
  } catch (err) {
    return { ok: false, error: `Не удалось сохранить файлы: ${err.message}` };
  }

  try {
    execFileSync('attrib', ['+h', '+s', AUTOMAXKG_DIR]);
  } catch (attrErr) {
    console.error('Скачано, но не удалось выставить атрибуты "скрытый"/"системный"', attrErr);
  }
  restrictAccessToCurrentUser(AUTOMAXKG_DIR);

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

ipcMain.handle('get-device-info', () => `${os.type()} ${os.release()} (${os.arch()})`);

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
  createWindow();

  // Затирание может занять заметное время (если реально что-то нашлось) —
  // не блокируем открытие окна этим, запускаем в фоне. renderer запрашивает
  // результат сам (automaxkg-cleanup-result) уже после входа, к тому моменту
  // это почти всегда успевает завершиться.
  cleanupOrphanedAutomaxKgCopies()
    .then((removed) => {
      orphanedCleanupResult = removed;
    })
    .catch((err) => log.error('Не удалось очистить старые копии AUTOMAX KG', err));

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
