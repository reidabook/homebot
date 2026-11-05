// Unofficial Giftster client. No public API exists; this uses the endpoints of Giftster's own
// browser extension (token login, add-item form) and of its website (item delete).
// The page functions below run inside Chrome (see browser.ts), so each is self-contained.
import { inGiftster } from './browser.ts';

export interface GiftsterList {
  id: string;
  name: string;
}

export interface AddedItem {
  list: string;
  title: string;
  price: string;
  link: string;
}

/** Log in like the extension and open its add-item form for `url`; returns the form and auth. */
async function openForm(email: string, password: string, url: string) {
  const r = await fetch('/extension/xauth/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Extension-Version': '4.0.0' },
    body: JSON.stringify({ username: email, password }),
  });
  const auth = await r.json().catch(() => ({}));
  if (!auth.token) throw new Error(`Giftster login failed for ${email}: ${auth.error ?? r.status}`);
  const token: string = auth.token;

  const start = new FormData();
  start.append('X-Token', token);
  start.append('extensionVersion', '4.0.0');
  start.append('fetchUrl', url);
  start.append('metadataStatus', 'unavailable');
  const shell = await (await fetch('/extension/add/', { method: 'POST', body: start })).text();
  const csrf = shell.match(/name="csrfmiddlewaretoken" value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('Giftster: add page had no CSRF token');

  const headers = { 'HX-Request': 'true', 'X-CSRFToken': csrf, 'X-Token': token, 'X-Extension-Version': '4.0.0' };
  // Giftster fetches the product page server-side here, filling in price and image.
  const html = await (
    await fetch('/extension/item/htmx/form/', {
      method: 'POST',
      headers,
      body: new URLSearchParams({ fetchUrl: url, metadata: '', metadataStatus: 'unavailable', csrfmiddlewaretoken: csrf }),
    })
  ).text();
  const form = new DOMParser().parseFromString(html, 'text/html');
  if (!form.querySelector('#id_list')) throw new Error('Giftster: add form did not load (login rejected?)');
  const lists = [...form.querySelectorAll('#id_list option')].map((o) => ({ id: (o as HTMLOptionElement).value, name: o.textContent!.trim() }));
  return { form, lists, headers };
}

async function pageLists(email: string, password: string): Promise<GiftsterList[]> {
  return (await openForm(email, password, 'https://www.giftster.com/')).lists;
}

async function pageAdd(email: string, password: string, item: { url: string; title: string; list: string; note: string }): Promise<AddedItem> {
  const { form, lists, headers } = await openForm(email, password, item.url);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const list = lists.find((l) => l.id === item.list) ?? lists.find((l) => norm(l.name) === norm(item.list));
  if (!list) throw new Error(`No Giftster list "${item.list}". This account's lists: ${lists.map((l) => l.name).join('; ')}`);

  const val = (name: string) => (form.querySelector(`[name="${name}"]`) as HTMLInputElement | null)?.value ?? '';
  const body = new URLSearchParams({
    csrfmiddlewaretoken: val('csrfmiddlewaretoken') || headers['X-CSRFToken'],
    link: item.url,
    title: item.title || val('title'),
    price: val('price'),
    quantity: '1',
    rank: '0',
    description: item.note,
    list: list.id,
    image_url: val('image_url'),
  });
  const res = await (await fetch('/extension/item/htmx/form/submit/', { method: 'POST', headers, body })).text();
  if (!res.includes('Item added')) {
    const errors = [...new DOMParser().parseFromString(res, 'text/html').querySelectorAll('.errorlist li')].map((e) => e.textContent).join('; ');
    throw new Error(`Giftster did not save the item${errors ? `: ${errors}` : ''}`);
  }
  return { list: list.name, title: body.get('title')!, price: body.get('price')!, link: item.url };
}

async function pageRemove(email: string, password: string, listName: string, title: string): Promise<{ list: string; title: string }> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Deleting is only on the website, which uses a normal session login.
  const login = await (await fetch('/account/login/')).text();
  const c0 = login.match(/name="csrfmiddlewaretoken" value="([^"]+)"/)?.[1];
  if (!c0) throw new Error('Giftster: login page had no CSRF token');
  await fetch('/account/login/', { method: 'POST', body: new URLSearchParams({ csrfmiddlewaretoken: c0, username: email, password }) });
  // The extension login (for list names) must come after the website login, or the latter fails.
  const { lists } = await openForm(email, password, 'https://www.giftster.com/');
  const list = lists.find((l) => l.id === listName) ?? lists.find((l) => norm(l.name) === norm(listName));
  if (!list) throw new Error(`No Giftster list "${listName}". This account's lists: ${lists.map((l) => l.name).join('; ')}`);

  const page = await (await fetch(`/list/${list.id}/`)).text();
  const csrf = page.match(/csrftoken":\s*"([^"]+)"/)?.[1];
  const raw = page.match(/window\.listItemsJson = JSON\.parse\("(.*?)"\)/)?.[1];
  if (!csrf || raw === undefined) throw new Error('Giftster: could not open the list page (login failed?)');
  const items: { id: number; title: string }[] = JSON.parse(JSON.parse(`"${raw}"`));
  const hit = items.find((i) => norm(i.title) === norm(title)) ?? items.find((i) => norm(i.title).includes(norm(title)));
  if (!hit) throw new Error(`No item like "${title}" on that list. Items: ${items.map((i) => i.title).join('; ')}`);

  const r = await fetch('/list/item/json/', {
    method: 'POST',
    headers: { 'X-CSRFTOKEN': csrf, 'X-Requested-With': 'XMLHttpRequest' },
    body: new URLSearchParams({ item: String(hit.id), delete: 'true' }),
  });
  const out = await r.json().catch(() => ({}));
  if (out.status !== 'success') throw new Error(`Giftster did not delete the item (${r.status})`);
  return { list: list.name, title: hit.title };
}

export class GiftsterClient {
  private email: string;
  private password: string;
  constructor(email: string, password: string) {
    this.email = email;
    this.password = password;
  }

  lists() {
    return inGiftster([openForm], pageLists, this.email, this.password);
  }

  /** `list` is a list name (case-insensitive) or id. Price and image come from Giftster's own fetch of the URL. */
  addItem(item: { url: string; title: string; list: string; note?: string }) {
    return inGiftster([openForm], pageAdd, this.email, this.password, { ...item, note: item.note ?? '' });
  }

  /** Deletes the item whose title matches from the named list. */
  removeItem(list: string, title: string) {
    return inGiftster([openForm], pageRemove, this.email, this.password, list, title);
  }
}

/** GIFTSTER_<NAME>=email:password in .env, keyed by lowercase name (matching ALLOWED_HANDLES names). */
export function giftsterFromEnv(): Record<string, GiftsterClient> {
  const out: Record<string, GiftsterClient> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const m = key.match(/^GIFTSTER_(.+)$/);
    const i = value?.indexOf(':') ?? -1;
    if (m && value && i > 0) out[m[1].toLowerCase()] = new GiftsterClient(value.slice(0, i), value.slice(i + 1));
  }
  return out;
}
