// Минифицирует renderer/renderer.js и renderer/styles.css прямо перед
// упаковкой (electron-builder копирует их в приложение как есть — исходники
// в репозитории никогда не хранятся минифицированными), затем ВСЕГДА
// возвращает файлы к исходному читаемому виду — успешна сборка или нет,
// прервана вручную (Ctrl+C) или упала с ошибкой. Рабочее дерево репозитория
// после запуска этого скрипта всегда остаётся таким же, каким было до него.
//
// main.js/preload.js (код главного процесса) и admin-web (отдельный сайт,
// деплоится независимо на Vercel) сюда не входят — они не влияют на
// скорость отрисовки интерфейса приложения, минифицировать их незачем.
//
// Идентификаторы (имена функций/переменных) НЕ переименовываются
// (minifyIdentifiers: false) — только пробелы/переносы строк и комментарии
// (которых в renderer.js очень много) убираются, а мёртвый код синтаксически
// упрощается. Это осознанно консервативный выбор: даёт почти весь реальный
// выигрыш в размере, но не трогает имена — надёжнее для файла такого размера
// в приложении, где ошибка означает сломанную работу с реальными клиентами.

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGETS = [
  { file: path.join(ROOT, 'renderer', 'renderer.js'), loader: 'js' },
  { file: path.join(ROOT, 'renderer', 'styles.css'), loader: 'css' },
];

const originals = TARGETS.map(({ file }) => fs.readFileSync(file, 'utf8'));
let restored = false;

function restore() {
  if (restored) return;
  restored = true;
  TARGETS.forEach(({ file }, i) => fs.writeFileSync(file, originals[i]));
}

process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

let exitCode = 1;
try {
  for (const { file, loader } of TARGETS) {
    const code = fs.readFileSync(file, 'utf8');
    const result = esbuild.transformSync(code, {
      loader,
      minifyWhitespace: true,
      minifySyntax: true,
      minifyIdentifiers: false,
    });
    fs.writeFileSync(file, result.code);
  }

  const extraArgs = process.argv.slice(2); // например: --publish always
  const result = spawnSync('npx', ['electron-builder', ...extraArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });
  exitCode = result.status === null ? 1 : result.status;
} finally {
  restore();
}

process.exit(exitCode);
