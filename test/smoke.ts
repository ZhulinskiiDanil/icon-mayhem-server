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

  // ! --- The author's icon --- !
  const authorIcon = { cube: 41, color1: '#ffffff', color2: '#ff80c0', glow: true, glowColor: '#00ffff', custom: 'a'.repeat(64) };
  const withIcon = await call('POST', '/v1/looks', { name: 'On my icon', look: { ears: 'Fox' }, icon: authorIcon }, fans[1]);
  check('publish with the icon of the author', withIcon.status === 201 && withIcon.json.icon?.cube === 41 && withIcon.json.icon?.custom === 'a'.repeat(64), withIcon.json);
  const listedIcon = await call('GET', '/v1/looks?sort=new');
  check('the gallery gives the icon of the author', listedIcon.json.looks?.find((look: any) => look.name === 'On my icon')?.icon?.glowColor === '#00ffff', listedIcon.json);
  const noIcon = await call('POST', '/v1/looks', { name: 'No icon', look: { ears: 'Cat' } }, fans[1]);
  check('an icon is optional', noIcon.status === 201 && noIcon.json.icon === null, noIcon.json);
  const badIcon = await call('POST', '/v1/looks', { name: 'Bad icon', look: { ears: 'Cat' }, icon: { ...authorIcon, color1: 'red' } }, fans[1]);
  check('a bad icon is refused', badIcon.status === 400, badIcon);

  // ! --- Following --- !
  check('following needs a login', (await call('POST', '/v1/follows/2')).status === 401);
  check('no following yourself', (await call('POST', '/v1/follows/2', undefined, yor)).status === 400);
  await call('POST', '/v1/looks', { name: 'Yor again', look: { ears: 'Cat' } }, yor);
  const followed = await call('POST', '/v1/follows/2', undefined, fans[2]);
  check('follow an author', followed.status === 200 && followed.json.following === true && followed.json.followers === 1, followed);
  const feed = await call('GET', '/v1/looks?sort=following', undefined, fans[2]);
  check('the following list has their looks only', feed.json.looks?.length > 0 && feed.json.looks.every((look: any) => look.author.accountId === 2 && look.author.following === true), feed.json);
  check('the following list needs a login', (await call('GET', '/v1/looks?sort=following')).status === 401);
  const meFollowing = await call('GET', '/v1/me', undefined, fans[2]);
  check('me counts who I follow', meFollowing.json.following === 1, meFollowing.json);
  const unfollowed = await call('DELETE', '/v1/follows/2', undefined, fans[2]);
  check('unfollow', unfollowed.json.following === false && unfollowed.json.followers === 0, unfollowed);
  const emptyFeed = await call('GET', '/v1/looks?sort=following', undefined, fans[2]);
  check('nothing followed, nothing listed', emptyFeed.json.looks?.length === 0, emptyFeed.json);

  // ! --- Worn looks --- !
  const worn = { bangs: true, 'bangs-style': 'Clumps', 'custom-color': '#2b2929', density: 40 };
  check('wearing a look needs a login', (await call('POST', '/v1/worn', { look: worn })).status === 401);
  const wornUp = await call('POST', '/v1/worn', { look: worn }, yor);
  check('upload a worn look', wornUp.status === 201 && /^[0-9a-f]{64}$/.test(wornUp.json.hash), wornUp);
  const reordered = Object.fromEntries(Object.entries(worn).reverse());
  const wornAgain = await call('POST', '/v1/worn', { look: reordered }, fans[0]);
  check('the same look in another order is the same hash', wornAgain.status === 200 && wornAgain.json.hash === wornUp.json.hash, wornAgain);
  const wornGot = await call('GET', `/v1/worn/${wornUp.json.hash}`);
  check('fetch a worn look by its hash', wornGot.status === 200 && wornGot.json.look?.['bangs-style'] === 'Clumps' && wornGot.json.look?.density === 40, wornGot.json);
  check('an unknown worn look is gone', (await call('GET', `/v1/worn/${'0'.repeat(64)}`)).status === 404);
  check('no list of worn looks', (await call('GET', '/v1/worn')).status === 404);
  const wornBad = await call('POST', '/v1/worn', { look: { 'Not Valid': 1 } }, yor);
  check('a bad worn look is refused', wornBad.status === 400, wornBad);
  const wornHuge = await call('POST', '/v1/worn', { look: Object.fromEntries(Array.from({ length: 390 }, (_, i) => [`k-${i}`, 'x'.repeat(60)])) }, yor);
  check('a huge worn look is refused', wornHuge.status === 400, wornHuge);

  // ! --- Custom icons --- !
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]).toString('base64');
  const frame = (role: string) => ({ role, x: 0, y: 0, w: 30, h: 30, rotated: false, ox: 0, oy: 0, sw: 30, sh: 30 });
  const icon = { type: 'cube', quality: 4, png, frames: [frame(''), frame('2'), frame('glow')] };

  check('uploading an icon needs a login', (await call('POST', '/v1/icons', icon)).status === 401);
  const uploaded = await call('POST', '/v1/icons', icon, yor);
  check('upload an icon', uploaded.status === 201 && /^[0-9a-f]{64}$/.test(uploaded.json.hash), uploaded);
  const again = await call('POST', '/v1/icons', icon, yor);
  check('the same icon is stored once', again.status === 200 && again.json.hash === uploaded.json.hash, again);
  const fetched = await call('GET', `/v1/icons/${uploaded.json.hash}`);
  check('fetch an icon by its hash', fetched.status === 200 && fetched.json.png === png && fetched.json.frames?.length === 3, fetched.json);
  check('no list of icons', (await call('GET', '/v1/icons')).status === 404);

  const notPng = await call('POST', '/v1/icons', { ...icon, png: Buffer.alloc(64, 1).toString('base64') }, yor);
  check('not a PNG is refused', notPng.status === 400, notPng);
  const badRole = await call('POST', '/v1/icons', { ...icon, frames: [frame('../evil')] }, yor);
  check('an unknown frame role is refused', badRole.status === 400, badRole);
  const huge = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1100 * 1024, 1)]).toString('base64');
  const tooBig = await call('POST', '/v1/icons', { ...icon, png: huge }, yor);
  check('a huge icon is refused', tooBig.status === 413, tooBig);

  check('no reporting your own icon', (await call('POST', `/v1/icons/${uploaded.json.hash}/report`, {}, yor)).status === 400);
  for (const fan of fans) await call('POST', `/v1/icons/${uploaded.json.hash}/report`, {}, fan);
  check('a reported icon hides', (await call('GET', `/v1/icons/${uploaded.json.hash}`)).status === 404);
  const iconReports = await call('GET', '/v1/admin/reports', undefined, admin);
  check('moderators see reported icons', iconReports.json.icons?.[0]?.hash === uploaded.json.hash, iconReports.json);
  await call('POST', `/v1/admin/icons/${uploaded.json.hash}/unhide`, undefined, admin);
  check('unhidden by a moderator', (await call('GET', `/v1/icons/${uploaded.json.hash}`)).status === 200);
  await call('POST', `/v1/admin/icons/${uploaded.json.hash}/delete`, undefined, admin);
  check('deleted by a moderator', (await call('GET', `/v1/icons/${uploaded.json.hash}`)).status === 404);
} finally {
  server.close();
}

console.log(failures ? `${failures} failed` : 'All passed');
process.exit(failures ? 1 : 0);
