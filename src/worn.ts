import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from './auth.js';
import { config } from './config.js';
import { db } from './db.js';
import { HttpError } from './errors.js';
import { lookSchemaOf } from './routes.js';

export const wornRouter = Router();

// ! --- Worn looks --- !
// The look a player wears in a level. Globed carries only its hash to the others in the level,
// they fetch the look here: no size limit of Globed events, one small message per change.
// Like icons, a look is found by its hash only: there is no list

const MAX_WORN_BYTES = 16384;
const uploadBody = z.object({ look: lookSchemaOf(MAX_WORN_BYTES) });
const hashParam = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/, 'not a look hash') });

// The same settings in any order are the same look
function canonical(look: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(look).sort().map((key) => [key, look[key]])));
}

wornRouter.post('/worn', sessionAuth(true), async (req, res) => {
  const { look } = uploadBody.parse(req.body);
  const text = canonical(look);
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const user = req.user!;

  const { rowCount } = await db().query('UPDATE worn_looks SET used_at = now() WHERE hash = $1', [hash]);
  if (!rowCount) {
    await db().query('INSERT INTO worn_looks (hash, account_id, look) VALUES ($1, $2, $3)', [hash, user.accountId, text]);
    // Past the limit, the looks this account wore the longest ago go
    const { rows } = await db().query<{ hash: string }>(
      'SELECT hash FROM worn_looks WHERE account_id = $1 ORDER BY used_at DESC, created_at DESC',
      [user.accountId],
    );
    for (const old of rows.slice(config.maxWornPerAccount)) await db().query('DELETE FROM worn_looks WHERE hash = $1', [old.hash]);
  }
  res.status(rowCount ? 200 : 201).json({ hash });
});

wornRouter.get('/worn/:hash', async (req, res) => {
  const { hash } = hashParam.parse(req.params);
  const { rows } = await db().query<{ look: unknown }>('SELECT look FROM worn_looks WHERE hash = $1', [hash]);
  const worn = rows[0];
  if (!worn) throw new HttpError(404, 'This look is gone');
  // A look never changes under its hash
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.json({ look: typeof worn.look === 'string' ? JSON.parse(worn.look) : worn.look });
});
