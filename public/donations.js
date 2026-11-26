export async function configureDonationLinks() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) return;
    const { donations = {} } = await response.json();
    for (const link of document.querySelectorAll('[data-donation]')) {
      const value = donations[link.dataset.donation];
      if (typeof value !== 'string' || !value.trim() || /YOUR_|PLACEHOLDER/i.test(value)) continue;
      let url;
      try { url = new URL(value, window.location.origin); } catch { continue; }
      if (url.protocol !== 'https:') continue;
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.removeAttribute('aria-disabled');
      link.removeAttribute('title');
    }
  } catch {
    // Donation links remain disabled if configuration cannot be loaded.
  }
}
