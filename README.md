# Icon Mayhem gallery server

The community gallery of looks for [Icon Mayhem](https://github.com/ZhulinskiiDanil/icon-mayhem), a Geode mod for Geometry Dash: players share their looks, browse and wear others', like them and report what doesn't belong; on Globed they see each other's custom icons.

Express + TypeScript + Postgres. Accounts are Geometry Dash accounts, checked with [Argon](https://github.com/GlobedGD/argon) (no passwords ever reach this server).

## Deploy on Railway

1. New Project → Deploy from GitHub repo → this repo.
2. In the project: **New → Database → PostgreSQL**. Then in the service's Variables add a reference to the database's `DATABASE_URL`.
3. Variables of the service:
   - `ADMIN_ACCOUNT_IDS`: your GD account id (moderators can hide and delete any look from the game)
   - `ADMIN_KEY`: a long random string, for the admin endpoints without an account
4. Settings → Networking → **Generate Domain**. That URL goes into the mod.

Railway runs `npm install`, `npm run build` and `npm start`; the tables are created on the first start.

## Run locally

```sh
npm install
cp .env.example .env   # set DATABASE_URL
npm run dev
npm run smoke          # every endpoint against an in-memory database, no Postgres needed
```

## API

All under `/v1`, JSON in and out. Errors are `{ "error": "text for the player", "code": "session" | "argon" | undefined }`.
Writes need `Authorization: Bearer <session>`.

| | |
|---|---|
| `POST /auth/login` | `{ accountId, userId?, username, token }` with an Argon token → `{ session, accountId, username, admin }`. One Argon check per login, sessions last 30 days |
| `GET /me` | the logged in account |
| `GET /looks?sort=top\|new\|mine&q=&page=&limit=` | `{ looks, hasMore }`; `mine` needs a session and shows your hidden looks too |
| `GET /looks/:id` | one look |
| `POST /looks` | `{ name, look }`: a name up to 32 characters, the look a flat object of setting keys and plain values (8 KB at most). 10 a day, 30 per account |
| `DELETE /looks/:id` | its author or a moderator |
| `POST /looks/:id/like`, `DELETE /looks/:id/like` | → `{ likes, liked }` |
| `POST /looks/:id/report` | `{ reason? }`; 5 reports hide a look until a moderator unhides it |
| `POST /icons` | a custom icon from More Icons: `{ type, quality, png (base64), frames }` → `{ hash }`. PNG only, 1 MB at most, the same icon is stored once, 100 per account (the oldest unused go) |
| `GET /icons/:hash` | one icon by its hash; there is no list, a hash is only known to players who were shown it on Globed |
| `POST /icons/:hash/report` | 5 reports hide an icon |
| `POST /admin/icons/:hash/hide\|unhide\|delete` | moderators |
| `GET /admin/reports` | moderators (admin account or `X-Admin-Key`): reported looks and icons |
| `POST /admin/looks/:id/hide\|unhide\|delete` | moderators |
| `GET /health` | `{ ok: true }` |

A look object is what the mod sends to other players on Globed: only the settings that differ from the defaults.

## License

MIT
