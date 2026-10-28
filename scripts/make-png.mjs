/**
 * Rasterise the generated SVGs to the PNGs the repository serves.
 *
 * `scripts/make-art.mjs` writes SVG only, because SVG is what the page and the
 * README want to keep editable. GitHub and Instagram want pixels, so this
 * renders each one at its intrinsic size with a headless Chrome and writes the
 * result next to it.
 *
 * Run `node scripts/make-png.mjs` for all of them, or name files to redo one.
 * Chrome is found from CHROME_BIN, then the puppeteer cache, then the usual
 * macOS install; set CHROME_BIN if yours lives somewhere else.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const ALL = [
  'docs/logo.svg',
  'docs/banner-horizontal.svg',
  'docs/banner-square.svg',
  'docs/banner-vertical.svg',
  'docs/banner-story.svg',
];

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = join(homedir(), '.cache', 'puppeteer', 'chrome');
  if (existsSync(cache)) {
    for (const version of readdirSync(cache)) {
      for (const name of ['Google Chrome for Testing', 'Google Chrome']) {
        const candidate = join(cache, version, 'chrome-mac-arm64', `${name}.app`, 'Contents', 'MacOS', name);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  throw new Error('no Chrome found: set CHROME_BIN to a Chrome or Chrome for Testing binary');
}

/** The SVG states its own size, so the raster matches the vector by definition. */
function sizeOf(file) {
  const head = readFileSync(file, 'utf8').slice(0, 600);
  const width = /<svg[^>]*\bwidth="(\d+(?:\.\d+)?)"/.exec(head);
  const height = /<svg[^>]*\bheight="(\d+(?:\.\d+)?)"/.exec(head);
  if (!width || !height) throw new Error(`${file}: no width/height on <svg>`);
  return { width: Number(width[1]), height: Number(height[1]) };
}

function connect(chrome, port) {
  const browser = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(process.env.TMPDIR ?? '/tmp', `dsh-carbon-png-${process.pid}`)}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return browser;
}

async function waitForPort(base) {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${base}/json/version`)).ok) return;
    } catch {
      // Chrome has not opened the socket yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Chrome did not open its debugging port');
}

async function session(port) {
  const base = `http://127.0.0.1:${port}`;
  await waitForPort(base);
  const tabs = await (await fetch(`${base}/json`)).json();
  const page = tabs.find((tab) => tab.type === 'page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((open, fail) => { socket.onopen = open; socket.onerror = fail; });

  let id = 0;
  const pending = new Map();
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (call) {
      pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
      return;
    }
    const waiter = waiting.get(message.method);
    if (waiter) {
      waiting.delete(message.method);
      waiter(message.params);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const once = (method) => new Promise((waiter) => waiting.set(method, waiter));
  await send('Page.enable');
  return { send, once, close: () => socket.close() };
}

const files = process.argv.length > 2 ? process.argv.slice(2) : ALL;
const chrome = findChrome();
const port = 9600 + Math.floor(Math.random() * 300);
const browser = connect(chrome, port);

try {
  const { send, once, close } = await session(port);
  for (const file of files) {
    const source = resolve(ROOT, file);
    const { width, height } = sizeOf(source);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const loaded = once('Page.loadEventFired');
    await send('Page.navigate', { url: pathToFileURL(source).href });
    await loaded;
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    const out = source.replace(/\.svg$/, '.png');
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`wrote ${file.replace(/\.svg$/, '.png')} (${width}x${height})`);
  }
  close();
} finally {
  browser.kill('SIGKILL');
}
