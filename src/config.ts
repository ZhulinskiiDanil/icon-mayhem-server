// Everything the server is set up with comes from the environment (Railway variables)

function int(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function ids(name: string): Set<number> {
  return new Set(
    (process.env[name] ?? '')
      .split(',')
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((id) => Number.isFinite(id) && id > 0),
  );
}

export const config = {
  port: int('PORT', 3000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  // Railway's internal Postgres needs no TLS; a public URL from elsewhere may
  databaseSsl: process.env.DATABASE_SSL === '1',
  // Argon checks that a player owns the Geometry Dash account they say (https://github.com/GlobedGD/argon)
  argonUrl: (process.env.ARGON_URL ?? 'https://argon.globed.dev').replace(/\/$/, ''),
  // Local testing only: logins are taken on trust. Never set it on the real server
  authDev: process.env.AUTH_DEV === '1',
  // Moderators: their accounts can hide and delete any look; the key works without an account
  adminAccounts: ids('ADMIN_ACCOUNT_IDS'),
  adminKey: process.env.ADMIN_KEY ?? '',
  sessionDays: int('SESSION_DAYS', 30),
  // A look with this many reports hides itself until a moderator looks at it
  reportHide: int('REPORT_HIDE', 5),
  maxLooksPerAccount: int('MAX_LOOKS_PER_ACCOUNT', 30),
  maxLooksPerDay: int('MAX_LOOKS_PER_DAY', 10),
};
