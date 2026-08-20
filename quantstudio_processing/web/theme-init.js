(() => {
  const root = document.documentElement;
  root.classList.add('js');
  document.getElementById('theme-color-system-dark')?.remove();

  let preference = 'system';
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch (_) {
    /* Storage may be unavailable; following the system is a safe default. */
  }

  root.dataset.themePreference = preference;
  if (preference !== 'system') root.dataset.theme = preference;

  const systemIsDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  const effectiveTheme = preference === 'system'
    ? (systemIsDark ? 'dark' : 'light')
    : preference;
  const themeColor = document.getElementById('theme-color');
  if (themeColor) {
    themeColor.removeAttribute('media');
    themeColor.content = effectiveTheme === 'dark'
      ? (themeColor.dataset.dark || '#10171C')
      : (themeColor.dataset.light || '#E7ECEF');
  }
})();
