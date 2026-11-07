export function installExternalLinks({
  desktop = window.desktop,
  doc = document,
  origin = location.origin,
  report = () => {},
} = {}) {
  if (!desktop?.openExternal) return;
  doc.addEventListener('click', event => {
    const anchor = event.target.closest?.('a[href]');
    if (!anchor || anchor.hasAttribute('download')) return;
    let url;
    try {
      url = new URL(anchor.getAttribute('href'), origin);
    } catch {
      return;
    }
    if (url.origin === origin) return;
    if (!['http:', 'https:'].includes(url.protocol)) {
      event.preventDefault();
      report('只支持网页外链。');
      return;
    }
    event.preventDefault();
    desktop.openExternal(url.href).catch(error => report(error?.message || '无法打开链接，请检查默认浏览器。'));
  });
}
