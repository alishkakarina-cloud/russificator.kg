const launchBtn = document.getElementById('launch-btn');
const status = document.getElementById('status');

launchBtn.addEventListener('click', async () => {
  status.textContent = 'Запуск...';
  try {
    await window.automaxkg.launch();
    status.textContent = 'AUTOMAX KG запущен в отдельном окне.';
  } catch (err) {
    status.textContent = 'Ошибка запуска: ' + err.message;
  }
});
