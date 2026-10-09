import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

// An error the player should read: the mod shows `error` as it is.
// `code` tells the mod what to do about it ("session": log in again, "argon": get a new token)
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const where = issue?.path.join('.') ?? '';
    res.status(400).json({ error: `Invalid ${where || 'request'}: ${issue?.message ?? 'bad value'}` });
    return;
  }
  if (error instanceof SyntaxError) {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }
  console.error(error);
  res.status(500).json({ error: 'Something went wrong on the server' });
}
