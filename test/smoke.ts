// Goes through every endpoint against an in-memory Postgres (pg-mem), logins taken on trust
process.env.AUTH_DEV = '1';
process.env.ADMIN_KEY = 'smoke-admin-key';
process.env.ADMIN_ACCOUNT_IDS = '1';
process.env.REPORT_HIDE = '3';

import type { AddressInfo } from 'node:net';

const { newDb } = await import('pg-mem');
const { usePool, initDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');

const memory = newDb();
const { Pool } = memory.adapters.createPg();
usePool(new Pool());
await initDb();

const server = createApp().listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let failures = 0;
function check(what: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${ok ? '' : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

async function call(method: string, path: string, body?: unknown, session?: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session ? { authorization: `Bearer ${session}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

async function login(accountId: number, username: string) {
  const res = await call('POST', '/v1/auth/login', { accountId, username, token: 'dev' });
  check(`login ${username}`, res.status === 200 && typeof res.json.session === 'string', res);
  return res.json.session as string;
}

try {
  check('health', (await call('GET', '/health')).json.ok === true);

  const admin = await login(1, 'Mod');
  const yor = await login(2, 'Yor');
  const fans = [await login(3, 'Fan1'), await login(4, 'Fan2'), await login(5, 'Fan3')];

  const me = await call('GET', '/v1/me', undefined, admin);
  check('admin account is admin', me.json.admin === true, me);

  check('publishing needs a login', (await call('POST', '/v1/looks', { name: 'x', look: {} })).status === 401);
  const bad = await call('POST', '/v1/looks', { name: 'Bad', look: { 'Not Valid': 1 } }, yor);
  check('a bad look is refused', bad.status === 400, bad);
  const big = await call('POST', '/v1/looks', { name: 'Big', look: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k-${i}`, 'x'.repeat(40)])) }, yor);
  check('a huge look is refused', big.status === 400, big);

  const published = await call('POST', '/v1/looks', { name: 'Yor Forger', look: { bangs: true, 'bangs-style': 'Clumps', blush: true, 'earrings': 'Pendulum' } }, yor);
  check('publish', published.status === 201 && published.json.name === 'Yor Forger' && published.json.mine === true, published);
  const id = published.json.id as number;
  await call('POST', '/v1/looks', { name: 'Second', look: { halo: true } }, fans[0]);

  const newest = await call('GET', '/v1/looks?sort=new');
  check('newest first', newest.json.looks?.[0]?.name === 'Second' && newest.json.looks.length === 2, newest.json);

  const liked = await call('POST', `/v1/looks/${id}/like`, undefined, fans[1]);
  check('like', liked.json.likes === 1 && liked.json.liked === true, liked);
  const twice = await call('POST', `/v1/looks/${id}/like`, undefined, fans[1]);
  check('a like counts once', twice.json.likes === 1, twice);

  const top = await call('GET', '/v1/looks?sort=top', undefined, fans[1]);
  check('top: most liked first, liked by me', top.json.looks?.[0]?.id === id && top.json.looks[0].liked === true, top.json);

  const search = await call('GET', '/v1/looks?sort=new&q=forg');
  check('search by name', search.json.looks?.length === 1 && search.json.looks[0].id === id, search.json);
  const byAuthor = await call('GET', '/v1/looks?sort=new&q=fan1');
  check('search by author', byAuthor.json.looks?.length === 1 && byAuthor.json.looks[0].name === 'Second', byAuthor.json);

  const unliked = await call('DELETE', `/v1/looks/${id}/like`, undefined, fans[1]);
  check('unlike', unliked.json.likes === 0 && unliked.json.liked === false, unliked);

  check('no reporting your own look', (await call('POST', `/v1/looks/${id}/report`, {}, yor)).status === 400);
  for (const fan of fans) await call('POST', `/v1/looks/${id}/report`, { reason: 'test' }, fan);
  const afterReports = await call('GET', '/v1/looks?sort=new');
  check('hidden after enough reports', afterReports.json.looks?.every((look: any) => look.id !== id), afterReports.json);
  const mine = await call('GET', '/v1/looks?sort=mine', undefined, yor);
  check('the author still sees it, hidden', mine.json.looks?.[0]?.id === id && mine.json.looks[0].hidden === true, mine.json);

  const reports = await call('GET', '/v1/admin/reports', undefined, undefined, { 'x-admin-key': 'smoke-admin-key' });
  check('moderators see reports', reports.json.looks?.[0]?.id === id, reports.json);
  check('others don\'t', (await call('GET', '/v1/admin/reports', undefined, fans[0])).status === 403);
  await call('POST', `/v1/admin/looks/${id}/unhide`, undefined, admin);
  const back = await call('GET', `/v1/looks/${id}`);
  check('unhidden by a moderator', back.status === 200 && back.json.hidden === false, back);

  check('only the author deletes', (await call('DELETE', `/v1/looks/${id}`, undefined, fans[0])).status === 403);
  check('the author deletes', (await call('DELETE', `/v1/looks/${id}`, undefined, yor)).status === 200);
  check('gone', (await call('GET', `/v1/looks/${id}`)).status === 404);

  for (let i = 0; i < 10; i++) await call('POST', '/v1/looks', { name: `Look ${i}`, look: { ahoge: i } }, fans[2]);
  const limited = await call('POST', '/v1/looks', { name: 'One more', look: {} }, fans[2]);
  check('ten a day at most', limited.status === 429, limited);

  const paged = await call('GET', '/v1/looks?sort=new&limit=4&page=1');
  check('pages', paged.json.looks?.length === 4 && paged.json.hasMore === true, paged.json);
} finally {
  server.close();
}

console.log(failures ? `${failures} failed` : 'All passed');
process.exit(failures ? 1 : 0);
