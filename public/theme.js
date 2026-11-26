export function initializeTheme({ document, storage }) {
  const themeSelect = document.getElementById('theme-select');
  let savedTheme;
  try { savedTheme = storage.getItem('theme'); } catch { savedTheme = null; }
  const initialTheme = savedTheme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = initialTheme;
  themeSelect.value = initialTheme;
  themeSelect.addEventListener('change', () => {
    const theme = themeSelect.value;
    document.documentElement.dataset.theme = theme;
    try { storage.setItem('theme', theme); } catch { /* Theme remains active for this page. */ }
  });
}
