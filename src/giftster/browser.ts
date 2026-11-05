// Giftster sits behind Cloudflare, which blocks Node's own HTTP client (TLS fingerprint), so
// every request is made from inside a headless Chrome page on www.giftster.com, driven over
// the DevTools protocol. Chrome is launched per call with a throwaway profile.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Headless Chrome's default user agent ("HeadlessChrome") is blocked; a normal one is not.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const ORIGIN = 'https://www.giftster.com';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Calls run one at a time so two chats never launch two browsers at once. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` inside a giftster.com page and return its result. `fn` and `helpers` are serialized
 * with toString(), so they may only call each other (no closures); args and result must be JSON-safe.
 */
export function inGiftster<A extends unknown[], R>(helpers: Function[], fn: (...args: A) => Promise<R>, ...args: A): Promise<R> {
  const run = queue.then(() => runInPage(helpers, fn, args));
  queue = run.catch(() => {});
  return run;
}

async function runInPage<R>(helpers: Function[], fn: (...args: any[]) => Promise<R>, args: unknown[]): Promise<R> {
  const profile = mkdtempSync(join(tmpdir(), 'giftster-chrome-'));
  const proc = spawn(
    CHROME,
    ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, '--remote-debugging-port=0', `--user-agent=${UA}`, '--disable-blink-features=AutomationControlled', 'about:blank'],
    { stdio: 'ignore' },
  );
  let ws: WebSocket | undefined;
  try {
    // Chrome writes the port it picked to DevToolsActivePort in the profile.
    let port = '';
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100);
      try {
        port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      } catch {}
    }
    if (!port) throw new Error('Giftster: headless Chrome did not start');
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('Giftster: no Chrome page');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws!.addEventListener('open', resolve, { once: true });
      ws!.addEventListener('error', reject, { once: true });
    });
    let id = 0;
    const pending = new Map<number, (m: any) => void>();
    const events: ((m: any) => void)[] = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id) pending.get(m.id)?.(m);
      else events.forEach((f) => f(m));
    });
    const send = (method: string, params = {}) =>
      new Promise<any>((resolve) => {
        pending.set(++id, resolve);
        ws!.send(JSON.stringify({ id, method, params }));
      });

    await send('Page.enable');
    const loaded = new Promise((r) => events.push((m) => m.method === 'Page.loadEventFired' && r(null)));
    // A tiny same-origin page, so fetch() calls carry giftster.com cookies and pass Cloudflare.
    await send('Page.navigate', { url: `${ORIGIN}/robots.txt` });
    await Promise.race([loaded, sleep(20_000)]);

    const m = await send('Runtime.evaluate', {
      expression: `${helpers.join('\n')}\n(${fn.toString()})(...${JSON.stringify(args)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (m.result?.exceptionDetails) {
      const d = m.result.exceptionDetails;
      // description is "Error: message\n    at ..."; keep just the message.
      throw new Error(String(d.exception?.description ?? d.text).split('\n')[0].replace(/^Error: /, ''));
    }
    return m.result.result.value as R;
  } finally {
    ws?.close();
    proc.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}
