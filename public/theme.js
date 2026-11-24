export function initializeTheme({ document, window, storage }) {
  const themeToggle = document.getElementById('theme-toggle');
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let savedTheme;
  try { savedTheme = storage.getItem('theme'); } catch { savedTheme = null; }
  if (savedTheme === 'light' || savedTheme === 'dark') {
    document.documentElement.dataset.theme = savedTheme;
  }

  const updateThemeToggle = () => {
    const theme = document.documentElement.dataset.theme;
    const isDark = theme ? theme === 'dark' : systemTheme.matches;
    const label = `Switch to ${isDark ? 'light' : 'dark'} mode`;
    themeToggle.setAttribute('aria-pressed', String(isDark));
    themeToggle.setAttribute('aria-label', label);
    themeToggle.setAttribute('title', label);
    themeToggle.setAttribute('data-icon', isDark ? 'sun' : 'moon');
  };

  updateThemeToggle();
  systemTheme.addEventListener('change', updateThemeToggle);
  themeToggle.addEventListener('click', () => {
    const theme = themeToggle.getAttribute('aria-pressed') === 'true' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { storage.setItem('theme', theme); } catch { /* Theme remains active for this page. */ }
    updateThemeToggle();
  });
  return { updateThemeToggle, systemTheme };
}
