/*
 * Loads the residency-network route in headless Chrome and reports every console
 * message, so the React DOM "unknown event handler property" warning can be seen
 * rather than assumed.
 *
 *     node scripts/network-web-console.mjs [url]
 *
 * Speaks the Chrome DevTools Protocol over its WebSocket, so no browser
 * automation package is needed. The page is given time to settle and to fetch
 * its data before the log is read, because the warning this checks for is
 * emitted during render.
 */

import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] ?? 'http://localhost:8082/program/network';
const PORT = 9333;
const settleMs = Number(process.argv[3] ?? 12000);

const profile = mkdtempSync(join(tmpdir(), 'medres-chrome-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=420,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function target() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await response.json();
      const page = list.find((entry) => entry.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is not listening yet.
    }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    // Node 20 has no global WebSocket, so the handshake is done by hand: a plain
    // HTTP upgrade, then the RFC 6455 frame codec below. The protocol is
    // line-oriented and this client only sends short JSON, so a minimal codec is
    // enough and keeps the project free of a browser-automation dependency.
    const { hostname, port, pathname, search } = new URL(wsUrl);
    const key = Buffer.from(String(Math.random()).slice(2) + Date.now()).toString('base64');
    const request = httpRequest({
      hostname,
      port,
      path: `${pathname}${search}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    request.on('upgrade', (response, socket) => {
      if (response.headers['sec-websocket-accept'] === undefined) {
        reject(new Error('WebSocket upgrade refused'));
        return;
      }
      socket.setNoDelay(true);

      const pending = new Map();
      const listeners = [];
      let nextId = 1;
      let buffer = Buffer.alloc(0);

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const frame = readFrame(buffer);
          if (!frame) break;
          buffer = frame.rest;
          if (frame.opcode === 0x1) {
            const message = JSON.parse(frame.payload);
            if (message.id && pending.has(message.id)) {
              const { res, rej } = pending.get(message.id);
              pending.delete(message.id);
              message.error
                ? rej(new Error(JSON.stringify(message.error)))
                : res(message.result);
            } else {
              listeners.forEach((fn) => fn(message));
            }
          } else if (frame.opcode === 0x8) {
            socket.end();
          }
        }
      });

      resolve({
        send(method, params = {}) {
          const id = nextId++;
          socket.write(writeFrame(JSON.stringify({ id, method, params })));
          return new Promise((res, rej) => pending.set(id, { res, rej }));
        },
        on(fn) {
          listeners.push(fn);
        },
        close: () => socket.end(),
      });
    });

    request.on('error', reject);
    request.end();
  });
}

/** Pull one complete frame off the front of the buffer, or null if incomplete. */
function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) === 0x80;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return null;
  const payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
  return { opcode, payload: payload.toString('utf8'), rest: buffer.subarray(offset + maskLength + length) };
}

/** Client frames must be masked. */
function writeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = Buffer.from([0, 1, 2, 3]);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x81;
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

const messages = [];

try {
  const ws = await connect(await target());
  ws.on((message) => {
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(' ');
      messages.push({ level: message.params.type, text });
    }
    if (message.method === 'Runtime.exceptionThrown') {
      messages.push({
        level: 'exception',
        text:
          message.params.exceptionDetails?.exception?.description ??
          message.params.exceptionDetails?.text ??
          'unknown exception',
      });
    }
    if (message.method === 'Log.entryAdded') {
      messages.push({ level: message.params.entry.level, text: message.params.entry.text });
    }
  });

  await ws.send('Runtime.enable');
  await ws.send('Log.enable');
  await ws.send('Page.enable');
  await ws.send('Page.navigate', { url });
  await sleep(settleMs);

  /**
   * Click an element by its accessible name.
   *
   * The app ships no test ids, so the accessibility labels are the stable
   * contract to drive it by — the same contract a screen reader uses.
   */
  async function clickByLabel(fragment, attempts = 1, gapMs = 1000) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await ws.send('Runtime.evaluate', {
        expression: `(() => {
          const nodes = Array.from(document.querySelectorAll('[aria-label]'));
          const match = nodes.find((n) => (n.getAttribute('aria-label') || '').includes(${JSON.stringify(fragment)}));
          if (!match) return 'NOT_FOUND';
          match.click();
          return 'CLICKED';
        })()`,
        returnByValue: true,
      });
      if (result.result?.value === 'CLICKED') return 'CLICKED';
      if (attempt < attempts - 1) await sleep(gapMs);
    }
    return 'NOT_FOUND';
  }

  /**
   * Click a navigation link by the route it points at.
   *
   * The session lives in React state, so a fresh navigation would drop it and
   * bounce back to sign-in. Following the in-app link keeps the same document
   * (and therefore the same session) alive.
   */
  async function clickByHref(fragment) {
    const result = await ws.send('Runtime.evaluate', {
      expression: `(() => {
        const nodes = Array.from(document.querySelectorAll('a[href]'));
        const match = nodes.find((n) => (n.getAttribute('href') || '').includes(${JSON.stringify(fragment)}));
        if (!match) return 'NOT_FOUND';
        const rect = match.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          // A zero-sized link is the router's own hidden anchor; route directly.
        }
        match.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        match.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        match.click();
        return 'CLICKED';
      })()`,
      returnByValue: true,
    });
    return result.result?.value;
  }

  const steps = [];
  steps.push(['role: Coordinator', await clickByLabel('Coordinator', 8, 1000)]);
  await sleep(1000);
  steps.push(['open a programme', await clickByLabel('Open ', 8, 1000)]);
  await sleep(5000);

  // The Network tab, then the route itself.
  steps.push(['tab: Network', await clickByLabel('Network')]);
  if (steps[steps.length - 1][1] !== 'CLICKED') {
    const tabClick = await ws.send('Runtime.evaluate', {
      expression: `(() => {
        const all = Array.from(document.querySelectorAll('button,[role="tab"],[role="button"],a'));
        const tab = all.find((n) => (n.textContent || '').trim() === 'Network');
        if (!tab) return 'NO_TAB';
        const r = tab.getBoundingClientRect();
        return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), tag: tab.tagName, role: tab.getAttribute('role') });
      })()`,
      returnByValue: true,
    });
    steps.push(['Network tab element', tabClick.result?.value]);
    steps.push(['tab: Network (href)', await clickByHref('/network')]);
  }
  await sleep(5000);

  // If the tab bar link did not switch the pane, ask the router directly.
  const landedNow = await ws.send('Runtime.evaluate', {
    expression: 'document.body ? document.body.innerText.slice(0, 400) : ""',
    returnByValue: true,
  });
  if (!/Connections map/i.test(landedNow.result?.value ?? '')) {
    const hrefs = await ws.send('Runtime.evaluate', {
      expression: `JSON.stringify(Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')))`,
      returnByValue: true,
    });
    steps.push(['hrefs', hrefs.result?.value]);
  }

  // A control: does clicking *another* tab swap the pane? If reports does not
  // either, the harness click technique is at fault, not the Network screen.
  const control = await ws.send('Runtime.evaluate', {
    expression: `(() => {
      const a = Array.from(document.querySelectorAll('a[href]')).find((n) => n.getAttribute('href') === '/program/reports');
      if (!a) return 'NO_LINK';
      a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      a.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      a.click();
      return 'CLICKED';
    })()`,
    returnByValue: true,
  });
  steps.push(['control: Reports', control.result?.value]);
  await sleep(4000);
  const controlBody = await ws.send('Runtime.evaluate', {
    expression: 'document.body.innerText.slice(0, 200)',
    returnByValue: true,
  });
  console.log(`--- control pane after Reports click: ${JSON.stringify((controlBody.result?.value ?? '').slice(0, 140))}`);

  const path = await ws.send('Runtime.evaluate', {
    expression: 'location.pathname',
    returnByValue: true,
  });
  console.log(`--- navigation: ${steps.map(([n, r]) => `${n}=${r}`).join(', ')}`);
  console.log(`--- landed on: ${path.result?.value}`);

  // Confirm the route actually rendered rather than showing an error page.
  const probe = await ws.send('Runtime.evaluate', {
    expression: `document.body ? document.body.innerText.slice(0, 400) : ''`,
    returnByValue: true,
  });
  const body = probe.result?.value ?? '';

  console.log(`--- URL: ${url}`);
  console.log(`--- body text (first 400 chars) ---`);
  console.log(body || '(empty)');
  console.log(`--- rendered the map? ${/Connections map/i.test(body)}`);

  // What actually rendered: the diagram is the one `<svg>` on the screen, and
  // the hit layer beneath it is the flat list of labelled buttons.
  const dom = await ws.send('Runtime.evaluate', {
    expression: `(() => {
      const svgs = Array.from(document.querySelectorAll('svg'));
      const biggest = svgs.map((s) => ({ children: s.children.length, w: s.getBoundingClientRect().width }))
        .sort((a, b) => b.children - a.children)[0] || null;
      const buttons = Array.from(document.querySelectorAll('[role="button"],[aria-label]'));
      return JSON.stringify({
        svgCount: svgs.length,
        biggest,
        labelled: buttons.map((b) => b.getAttribute('aria-label')).filter(Boolean).slice(0, 12),
      });
    })()`,
    returnByValue: true,
  });
  console.log(`--- dom: ${dom.result?.value}`);

  const suspect = messages.filter((m) => /onResponder|responder|Unknown event handler/i.test(m.text));
  console.log(`\n--- total console messages: ${messages.length}`);
  console.log(`--- responder-related: ${suspect.length}`);
  suspect.forEach((m) => console.log(`  [${m.level}] ${m.text}`));

  const errors = messages.filter((m) => m.level === 'error' || m.level === 'exception');
  console.log(`--- errors/exceptions: ${errors.length}`);
  errors.slice(0, 15).forEach((m) => console.log(`  [${m.level}] ${m.text.slice(0, 300)}`));

  ws.close();
  if (suspect.length > 0) process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
