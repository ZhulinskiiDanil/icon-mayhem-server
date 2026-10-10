import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { adminOnly, sessionAuth } from './auth.js';
import { config } from './config.js';
import { db } from './db.js';
import { HttpError } from './errors.js';

export const iconRouter = Router();

// ! --- Custom icons --- !
// The icons players made with More Icons, so the others in their Globed level see them too.
// An icon is fetched by its hash only, the one its owner showed in a level: there is no list

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Which sprite of the icon a frame is: "" the main one, "2" the second color, "3" the UFO dome,
// "glow", "extra"; robots and spiders "01".."04" for their parts, with the same endings
const roleSchema = z.string().regex(/^(|2|3|glow|extra|0[1-4](_2|_glow|_extra)?)$/, 'unknown frame role');
const coordinate = z.number().finite().min(-8192).max(8192);

const frameSchema = z.object({
  role: roleSchema,
  x: coordinate,
  y: coordinate,
  w: coordinate,
  h: coordinate,
  rotated: z.boolean(),
  ox: coordinate,
  oy: coordinate,
  sw: coordinate,
  sh: coordinate,
});

const uploadBody = z.object({
  type: z.enum(['cube', 'ship', 'ball', 'ufo', 'wave', 'robot', 'spider', 'swing', 'jetpack']),
  quality: z.union([z.literal(1), z.literal(2), z.literal(4)]),
  png: z.string().min(16).max(2 * 1024 * 1024),
  frames: z.array(frameSchema).min(1).max(80),
});

const hashParam = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/, 'not an icon hash') });

iconRouter.post('/icons', sessionAuth(true), async (req, res) => {
  const body = uploadBody.parse(req.body);
  const png = Buffer.from(body.png, 'base64');
  if (png.length > config.maxIconBytes) throw new HttpError(413, `An icon is ${Math.round(config.maxIconBytes / 1024)} KB at most`);
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    throw new HttpError(400, 'The icon is not a PNG');

  // The same picture with the same frames is the same icon, whoever sends it
  const frames = JSON.stringify(body.frames);
  const hash = crypto.createHash('sha256').update(png).update(frames).digest('hex');
  const user = req.user!;

  const { rowCount } = await db().query('UPDATE icons SET used_at = now() WHERE hash = $1', [hash]);
  if (!rowCount) {
    await db().query(
      `INSERT INTO icons (hash, account_id, type, quality, png, frames, bytes) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [hash, user.accountId, body.type, body.quality, png.toString('base64'), frames, png.length],
    );
    // Past the limit, the icons this account used the longest ago go
    const { rows } = await db().query<{ hash: string }>(
      'SELECT hash FROM icons WHERE account_id = $1 ORDER BY used_at DESC, created_at DESC',
      [user.accountId],
    );
    // An icon a look of the gallery is shown on stays
    for (const old of rows.slice(config.maxIconsPerAccount)) {
      const { rows: used } = await db().query("SELECT 1 FROM looks WHERE icon->>'custom' = $1 LIMIT 1", [old.hash]);
      if (!used.length) await db().query('DELETE FROM icons WHERE hash = $1', [old.hash]);
    }
  }
  res.status(rowCount ? 200 : 201).json({ hash });
});

iconRouter.get('/icons/:hash', async (req, res) => {
  const { hash } = hashParam.parse(req.params);
  const { rows } = await db().query<{ type: string; quality: number; png: string; frames: unknown; hidden: boolean }>(
    'SELECT type, quality, png, frames, hidden FROM icons WHERE hash = $1',
    [hash],
  );
  const icon = rows[0];
  if (!icon || icon.hidden) throw new HttpError(404, 'This icon is gone');
  // An icon never changes under its hash
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.json({ type: icon.type, quality: icon.quality, png: icon.png, frames: icon.frames });
});

iconRouter.post('/icons/:hash/report', sessionAuth(true), async (req, res) => {
  const { hash } = hashParam.parse(req.params);
  const { rows } = await db().query<{ account_id: number }>('SELECT account_id FROM icons WHERE hash = $1', [hash]);
  const icon = rows[0];
  if (!icon) throw new HttpError(404, 'This icon is gone');
  if (icon.account_id === req.user!.accountId) throw new HttpError(400, 'That one is yours');
  const { rowCount } = await db().query('INSERT INTO icon_reports (hash, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
    hash,
    req.user!.accountId,
  ]);
  if (rowCount) {
    await db().query('UPDATE icons SET reports = reports + 1, hidden = (reports + 1 >= $2) OR hidden WHERE hash = $1', [hash, config.reportHide]);
  }
  res.json({ reported: true });
});

iconRouter.post('/admin/icons/:hash/:action', sessionAuth(false), adminOnly, async (req, res) => {
  const { hash } = hashParam.parse(req.params);
  const action = z.enum(['hide', 'unhide', 'delete']).parse(req.params.action);
  if (action === 'delete') await db().query('DELETE FROM icons WHERE hash = $1', [hash]);
  else if (action === 'hide') await db().query('UPDATE icons SET hidden = true WHERE hash = $1', [hash]);
  else {
    await db().query('UPDATE icons SET hidden = false, reports = 0 WHERE hash = $1', [hash]);
    await db().query('DELETE FROM icon_reports WHERE hash = $1', [hash]);
  }
  res.json({ hash, action });
});
