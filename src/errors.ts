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
  // The body parser: too big, or not readable
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: status === 413 ? 'That is too big to send' : 'Bad request' });
    return;
  }
  console.error(error);
  res.status(500).json({ error: 'Something went wrong on the server' });
}
