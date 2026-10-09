import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { db } from './db.js';
import { HttpError } from './errors.js';

// Logging in: the mod gets an Argon token for the player's Geometry Dash account, we check it with
// Argon once and give back our own session, so the next requests don't cost an Argon check
// (Argon allows 750 checks an hour)

export interface User {
  accountId: number;
  username: string;
  admin: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export const loginBody = z.object({
  accountId: z.number().int().positive(),
  userId: z.number().int().positive().optional(),
  username: z.string().trim().min(1).max(20),
  token: z.string().min(1).max(512),
});

interface ArgonStrong {
  valid?: boolean;
  valid_weak?: boolean;
  cause?: string;
  username?: string;
}

// The real username of the account, or an error when the token doesn't prove it
async function checkWithArgon(body: z.infer<typeof loginBody>): Promise<string> {
  if (config.authDev) return body.username;

  const query = new URLSearchParams({
    account_id: String(body.accountId),
    username: body.username,
    authtoken: body.token,
  });
  if (body.userId) query.set('user_id', String(body.userId));

  let response: globalThis.Response;
  try {
    response = await fetch(`${config.argonUrl}/v1/validation/check-strong?${query}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(502, 'The account check (Argon) did not answer, try again later');
  }
  if (response.status === 429) throw new HttpError(503, 'Too many logins right now, try again in a few minutes');
  if (response.status !== 200) throw new HttpError(502, `The account check (Argon) failed (${response.status})`);

  const result = (await response.json()) as ArgonStrong;
  // A wrong username in the game's settings only weakens the check: the account id is what counts
  if (!result.valid_weak) throw new HttpError(401, `The account check failed: ${result.cause ?? 'invalid token'}`, 'argon');
  return result.username ?? body.username;
}

export async function login(input: unknown): Promise<{ session: string; user: User }> {
  const body = loginBody.parse(input);
  const username = await checkWithArgon(body);

  const session = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + config.sessionDays * 24 * 60 * 60 * 1000);
  await db().query('INSERT INTO sessions (token, account_id, username, expires_at) VALUES ($1, $2, $3, $4)', [
    session,
    body.accountId,
    username,
    expires.toISOString(),
  ]);
  // Old sessions of the same account go after a while
  await db().query('DELETE FROM sessions WHERE expires_at < now()');
  return { session, user: { accountId: body.accountId, username, admin: config.adminAccounts.has(body.accountId) } };
}

// Reads "Authorization: Bearer <session>". `required`: no session, no entry
export function sessionAuth(required: boolean) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token) {
      const { rows } = await db().query<{ account_id: number; username: string }>(
        'SELECT account_id, username FROM sessions WHERE token = $1 AND expires_at > now()',
        [token],
      );
      const row = rows[0];
      if (row) req.user = { accountId: row.account_id, username: row.username, admin: config.adminAccounts.has(row.account_id) };
    }
    if (required && !req.user) throw new HttpError(401, 'Log in first', 'session');
    next();
  };
}

// Moderators: an admin account, or the admin key
export function adminOnly(req: Request, _res: Response, next: NextFunction): void {
  const key = req.get('x-admin-key') ?? '';
  const keyOk = config.adminKey.length > 0 && key.length === config.adminKey.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(config.adminKey));
  if (!keyOk && !req.user?.admin) throw new HttpError(403, 'Moderators only');
  next();
}
