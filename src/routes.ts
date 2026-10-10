import { Router, type Request } from 'express';
import { z } from 'zod';
import { adminOnly, login, sessionAuth } from './auth.js';
import { config } from './config.js';
import { db } from './db.js';
import { HttpError } from './errors.js';

export const router = Router();

// ! --- Looks --- !
// A look is the settings of the mod that differ from the defaults: a flat JSON object of setting
// keys and plain values, exactly what the mod sends to other players on Globed

const MAX_LOOK_BYTES = 8192;

const lookValue = z.union([z.string().max(64), z.number().finite(), z.boolean()]);
// Also for the looks worn in levels (worn.ts), which may be a bit bigger
export function lookSchemaOf(maxBytes: number) {
  return z
    .record(z.string().regex(/^[a-z0-9-]{1,48}$/, 'setting keys are lowercase words with dashes'), lookValue)
    .refine((look) => Object.keys(look).length <= 400, 'too many settings')
    .refine((look) => JSON.stringify(look).length <= maxBytes, `a look is ${maxBytes} bytes at most`);
}
const lookSchema = lookSchemaOf(MAX_LOOK_BYTES);

// The icon the look was made on: everybody sees the look on it in the gallery
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a color is #rrggbb');
export const authorIconSchema = z.object({
  cube: z.number().int().min(1).max(5000),
  color1: hexColor,
  color2: hexColor,
  glow: z.boolean(),
  glowColor: hexColor,
  // Their custom icon (Custom icons: More Icons or a texture pack), by its hash
  custom: z.string().regex(/^[0-9a-f]{64}$/, 'not an icon hash').nullable().optional(),
});

const publishBody = z.object({
  name: z.string().trim().min(1).max(32),
  look: lookSchema,
  icon: authorIconSchema.optional(),
});

const listQuery = z.object({
  sort: z.enum(['top', 'new', 'mine', 'following']).default('top'),
  q: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(0).max(1000).default(0),
  limit: z.coerce.number().int().min(1).max(30).default(8),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

interface LookRow {
  id: number;
  account_id: number;
  username: string;
  name: string;
  look: Record<string, unknown>;
  icon?: unknown;
  likes: number;
  reports: number;
  hidden: boolean;
  created_at: Date | string;
  liked?: boolean | null;
  following?: boolean | null;
}

function present(row: LookRow, req: Request) {
  return {
    id: row.id,
    name: row.name,
    author: { accountId: row.account_id, username: row.username, following: Boolean(row.following) },
    likes: row.likes,
    liked: Boolean(row.liked),
    mine: req.user?.accountId === row.account_id,
    hidden: row.hidden,
    createdAt: new Date(row.created_at).toISOString(),
    look: row.look,
    icon: row.icon ?? null,
  };
}

async function findLook(id: number, req: Request): Promise<LookRow> {
  const { rows } = await db().query<LookRow>(
    `SELECT l.*, (lk.account_id IS NOT NULL) AS liked, (f.follower IS NOT NULL) AS following
     FROM looks l
     LEFT JOIN likes lk ON lk.look_id = l.id AND lk.account_id = $2
     LEFT JOIN follows f ON f.author = l.account_id AND f.follower = $2
     WHERE l.id = $1`,
    [id, req.user?.accountId ?? 0],
  );
  const row = rows[0];
  // Hidden looks are only there for their author and moderators
  if (!row || (row.hidden && req.user?.accountId !== row.account_id && !req.user?.admin)) throw new HttpError(404, 'This look is gone');
  return row;
}

router.post('/auth/login', async (req, res) => {
  const { session, user } = await login(req.body);
  res.json({ session, ...user });
});

router.get('/me', sessionAuth(true), async (req, res) => {
  const { rows } = await db().query<{ count: string }>('SELECT count(*) AS count FROM follows WHERE follower = $1', [req.user!.accountId]);
  res.json({ ...req.user, following: Number(rows[0]?.count ?? 0) });
});

// ! --- Following --- !
// Follow an author: their new looks show in the "following" list

const accountParam = z.object({ accountId: z.coerce.number().int().positive() });

async function setFollowing(req: Request, on: boolean) {
  const { accountId } = accountParam.parse(req.params);
  const user = req.user!;
  if (accountId === user.accountId) throw new HttpError(400, "That's you");
  if (on) await db().query('INSERT INTO follows (follower, author) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.accountId, accountId]);
  else await db().query('DELETE FROM follows WHERE follower = $1 AND author = $2', [user.accountId, accountId]);
  const { rows } = await db().query<{ count: string }>('SELECT count(*) AS count FROM follows WHERE author = $1', [accountId]);
  return { following: on, followers: Number(rows[0]?.count ?? 0) };
}

router.post('/follows/:accountId', sessionAuth(true), async (req, res) => {
  res.json(await setFollowing(req, true));
});

router.delete('/follows/:accountId', sessionAuth(true), async (req, res) => {
  res.json(await setFollowing(req, false));
});

router.get('/looks', sessionAuth(false), async (req, res) => {
  const query = listQuery.parse(req.query);
  if (query.sort === 'mine' && !req.user) throw new HttpError(401, 'Log in to see your looks', 'session');
  if (query.sort === 'following' && !req.user) throw new HttpError(401, 'Log in to see the authors you follow', 'session');

  const params: unknown[] = [req.user?.accountId ?? 0];
  const where: string[] = [];
  if (query.sort === 'mine') where.push('l.account_id = $1');
  else where.push('l.hidden = false');
  if (query.sort === 'following') where.push('l.account_id IN (SELECT author FROM follows WHERE follower = $1)');
  if (query.q) {
    params.push(`%${query.q.toLowerCase()}%`);
    where.push(`(lower(l.name) LIKE $${params.length} OR lower(l.username) LIKE $${params.length})`);
  }
  const order = query.sort === 'top' ? 'l.likes DESC, l.id DESC' : 'l.id DESC';
  params.push(query.limit + 1, query.page * query.limit);

  const { rows } = await db().query<LookRow>(
    `SELECT l.*, (lk.account_id IS NOT NULL) AS liked, (f.follower IS NOT NULL) AS following
     FROM looks l
     LEFT JOIN likes lk ON lk.look_id = l.id AND lk.account_id = $1
     LEFT JOIN follows f ON f.author = l.account_id AND f.follower = $1
     WHERE ${where.join(' AND ')}
     ORDER BY ${order}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({
    looks: rows.slice(0, query.limit).map((row) => present(row, req)),
    hasMore: rows.length > query.limit,
  });
});

router.get('/looks/:id', sessionAuth(false), async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json(present(await findLook(id, req), req));
});

router.post('/looks', sessionAuth(true), async (req, res) => {
  const body = publishBody.parse(req.body);
  const user = req.user!;

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { rows: all } = await db().query<{ count: string }>('SELECT count(*) AS count FROM looks WHERE account_id = $1', [user.accountId]);
  const { rows: recent } = await db().query<{ count: string }>(
    'SELECT count(*) AS count FROM looks WHERE account_id = $1 AND created_at > $2',
    [user.accountId, dayAgo],
  );
  const total = Number(all[0]?.count ?? 0);
  const today = Number(recent[0]?.count ?? 0);
  if (total >= config.maxLooksPerAccount)
    throw new HttpError(429, `You have ${config.maxLooksPerAccount} looks in the gallery: delete one to share a new one`);
  if (today >= config.maxLooksPerDay) throw new HttpError(429, `That's ${config.maxLooksPerDay} looks today, share more tomorrow`);

  const { rows } = await db().query<LookRow>(
    `INSERT INTO looks (account_id, username, name, look, icon) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [user.accountId, user.username, body.name, JSON.stringify(body.look), body.icon ? JSON.stringify(body.icon) : null],
  );
  res.status(201).json(present(rows[0]!, req));
});

router.delete('/looks/:id', sessionAuth(true), async (req, res) => {
  const { id } = idParam.parse(req.params);
  const row = await findLook(id, req);
  if (row.account_id !== req.user!.accountId && !req.user!.admin) throw new HttpError(403, 'Only its author can delete a look');
  await db().query('DELETE FROM looks WHERE id = $1', [id]);
  res.json({ deleted: id });
});

// ! --- Likes and reports --- !

async function likeCount(id: number): Promise<number> {
  const { rows } = await db().query<{ likes: number }>('SELECT likes FROM looks WHERE id = $1', [id]);
  return rows[0]?.likes ?? 0;
}

router.post('/looks/:id/like', sessionAuth(true), async (req, res) => {
  const { id } = idParam.parse(req.params);
  await findLook(id, req);
  const { rowCount } = await db().query('INSERT INTO likes (look_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
    id,
    req.user!.accountId,
  ]);
  if (rowCount) await db().query('UPDATE looks SET likes = likes + 1 WHERE id = $1', [id]);
  res.json({ likes: await likeCount(id), liked: true });
});

router.delete('/looks/:id/like', sessionAuth(true), async (req, res) => {
  const { id } = idParam.parse(req.params);
  await findLook(id, req);
  const { rowCount } = await db().query('DELETE FROM likes WHERE look_id = $1 AND account_id = $2', [id, req.user!.accountId]);
  if (rowCount) await db().query('UPDATE looks SET likes = likes - 1 WHERE id = $1 AND likes > 0', [id]);
  res.json({ likes: await likeCount(id), liked: false });
});

const reportBody = z.object({ reason: z.string().trim().max(100).default('') });

router.post('/looks/:id/report', sessionAuth(true), async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { reason } = reportBody.parse(req.body ?? {});
  const row = await findLook(id, req);
  if (row.account_id === req.user!.accountId) throw new HttpError(400, 'You can delete your own look instead');
  const { rowCount } = await db().query(
    'INSERT INTO reports (look_id, account_id, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [id, req.user!.accountId, reason],
  );
  if (rowCount) {
    // Enough reports hide it until a moderator looks
    await db().query('UPDATE looks SET reports = reports + 1, hidden = (reports + 1 >= $2) OR hidden WHERE id = $1', [id, config.reportHide]);
  }
  res.json({ reported: true });
});

// ! --- Moderation --- !

router.get('/admin/reports', sessionAuth(false), adminOnly, async (_req, res) => {
  const { rows } = await db().query(
    `SELECT l.id, l.name, l.username, l.account_id, l.reports, l.hidden, l.created_at
     FROM looks l WHERE l.reports > 0 ORDER BY l.reports DESC, l.id DESC LIMIT 100`,
  );
  const { rows: icons } = await db().query(
    `SELECT hash, account_id, type, reports, hidden, created_at FROM icons WHERE reports > 0 ORDER BY reports DESC LIMIT 100`,
  );
  res.json({ looks: rows, icons });
});

router.post('/admin/looks/:id/:action', sessionAuth(false), adminOnly, async (req, res) => {
  const { id } = idParam.parse(req.params);
  const action = z.enum(['hide', 'unhide', 'delete']).parse(req.params.action);
  if (action === 'delete') await db().query('DELETE FROM looks WHERE id = $1', [id]);
  else if (action === 'hide') await db().query('UPDATE looks SET hidden = true WHERE id = $1', [id]);
  else {
    // Unhidden looks start over with their reports
    await db().query('UPDATE looks SET hidden = false, reports = 0 WHERE id = $1', [id]);
    await db().query('DELETE FROM reports WHERE look_id = $1', [id]);
  }
  res.json({ id, action });
});
