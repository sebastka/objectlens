// Applies the saved theme before the first paint (a file, not inline: the CSP allows no inline scripts).
try {
  const t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {
  // storage unavailable
}
