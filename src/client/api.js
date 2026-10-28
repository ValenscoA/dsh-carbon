/**
 * The host routes the page reads.
 *
 * URL construction goes through `document.baseURI` rather than a leading `/`,
 * so a harness mounted under a path prefix still resolves the routes (§ the
 * market does the same). `credentials: same-origin` is explicit because the
 * routes are same-origin-fenced on the host side.
 */

function route(path) {
  return new URL(`dsh-carbon/${path}`, document.baseURI);
}

async function readJson(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`HTTP ${response.status}`);
  }
  if (body === null || typeof body !== 'object' || body.ok !== true) {
    throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`);
  }
  return body;
}

/** Attach the filters every reading shares: fleet, window, row cap. */
function filtered(path, { infra, range, since, until, limit, fresh } = {}) {
  const url = route(path);
  if (typeof infra === 'string' && infra.length > 0) url.searchParams.set('infra', infra);
  if (typeof range === 'string' && range.length > 0) url.searchParams.set('range', range);
  if (typeof since === 'string' && since.length > 0) url.searchParams.set('since', since);
  if (typeof until === 'string' && until.length > 0) url.searchParams.set('until', until);
  if (Number.isFinite(limit)) url.searchParams.set('limit', String(limit));
  if (fresh) url.searchParams.set('fresh', '1');
  return url;
}

export async function fetchSummary({ infra, range, since, until, limit, signal, fresh = false } = {}) {
  const response = await fetch(filtered('summary', { infra, range, since, until, limit, fresh }), {
    method: 'GET',
    signal,
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return readJson(response);
}

export async function fetchMethodology({ signal } = {}) {
  const response = await fetch(route('methodology'), {
    method: 'GET',
    signal,
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return readJson(response);
}

/** The card as SVG text: the page turns it into a PNG itself, in a canvas. */
export async function fetchCard({ infra, range, since, until } = {}) {
  const response = await fetch(filtered('card.svg', { infra, range, since, until }), {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { accept: 'image/svg+xml' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

export function cardUrl({ infra, range, since, until } = {}) {
  return filtered('card.svg', { infra, range, since, until }).toString();
}

/**
 * Rasterise the card in the reader's own browser.
 *
 * The host could not do this without shipping a browser; the page already has
 * one. 2x, so the PNG survives a retina screen and a cropped preview.
 */
export async function cardToPng(svgText, scale = 2) {
  const width = 1200;
  const height = 630;
  const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('the card image could not be decoded'));
      element.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('canvas is unavailable');
    context.fillStyle = '#0e1116';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const raster = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (raster === null) throw new Error('the PNG could not be encoded');
    return raster;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Hand a generated file to the browser's download flow. */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Copy text, with a fallback for a page without the async clipboard API. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
