# Deploy to Railway

This app is a Node.js server (`npm start` → `node server/index.js`) plus PostgreSQL. On boot it creates the tables it needs, including the `pgcrypto` extension. Railway can build it from this repository with no extra build step.

You need:

- A [Railway](https://railway.com) account
- This repository on GitHub
- Two values the app reads from the environment: `DATABASE_URL` and `SESSION_SECRET`

Railway sets `PORT` itself. The server already listens on that port.

## 1. Push this repository to GitHub

Railway deploys from GitHub. This project is already at [github.com/KhanhLanHuynh/todo](https://github.com/KhanhLanHuynh/todo). After later changes:

```bash
git push origin main
```

## 2. Create a Railway project from the repo

1. Open [railway.com/new](https://railway.com/new).
2. Choose **Deploy from GitHub repo**.
3. If asked, install the Railway GitHub app and grant it access to this repository.
4. Select the repository. Railway creates a service and starts a build from the repo root.

Railway detects Node from `package.json` and runs `npm start`. Leave the start command as `npm start` unless you changed the script. Node 18 or newer is required (`engines` in `package.json`).

## 3. Add PostgreSQL

1. In the same project, choose **New** → **Database** → **PostgreSQL**.
2. Wait until the database service is online.

Keep the web service and Postgres in one project so the app can use Railway's private network.

## 4. Set variables on the web service

Open the **web service** (the one built from GitHub), then **Variables**. Add:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `SESSION_SECRET` | A long random string, at least 32 characters (j8#9Xq2!mP$7vL*w5R&t3N%y6B@h4Kp2W9z8Q) |
| `NODE_ENV` | `production` |
| `PGSSLMODE` | `disable` |

`Postgres` in `${{Postgres.DATABASE_URL}}` must match the database service name shown in the project. If you renamed it, use that name.

What each variable does:

- **`DATABASE_URL`** is required. Referencing the Postgres service injects the private connection string. Do not paste a password into the repo.
- **`SESSION_SECRET`** signs the login cookie. The process exits on startup if it is missing. Generate one locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and paste the result into Railway only.
- **`NODE_ENV=production`** marks the session cookie `Secure`. Railway serves the public URL over HTTPS, so the browser will store the cookie. Without this, sign-in can succeed and then look logged out.
- **`PGSSLMODE=disable`** turns TLS off for the database connection. The private hostname (`*.railway.internal`) does not speak TLS. The app turns TLS on for every host that is not localhost, so this variable is required for the private URL. Do not set it when you are pointing `DATABASE_URL` at the public proxy URL (`DATABASE_PUBLIC_URL`); that proxy requires TLS, and the app enables it on its own.

Do not set `PORT`. Railway injects it.

After saving variables, Railway redeploys. The boot log should include `Daily Task Tracker listening on` and the port Railway assigned. A missing `DATABASE_URL` or `SESSION_SECRET` fails the deploy before the server listens. A TLS mismatch against Postgres fails with a connection error in the same log.

## 5. Open the app

1. On the web service, open **Settings** → **Networking**.
2. Choose **Generate Domain**.
3. Open the `https://…up.railway.app` URL.

Register an account on that URL. Tasks and flows are stored in the Railway Postgres database, not in the browser.

## 6. Confirm it stayed up

- **Deploy logs** show the listen line and no `DATABASE_URL is required` or `SESSION_SECRET is required` error.
- **Postgres → Data** shows `users`, `tasks`, `flows`, and `flow_occurrences` after the first successful boot. The server creates them itself. There is no separate migration command.
- Sign in, add a task, refresh the page, and confirm the task is still there.

## Custom domain

In **Settings** → **Networking**, add your domain and set the DNS records Railway shows. Leave `NODE_ENV=production` so the cookie stays `Secure` on HTTPS.

## Updating

Push to the branch Railway watches (usually `main`). Railway builds and redeploys. Existing rows stay in Postgres across deploys. Deleting the Postgres service deletes the data.

## Local check before you push

```bash
npm install
```

Copy `.env.example` to `.env`, point `DATABASE_URL` at a local Postgres database, and set `SESSION_SECRET`. Leave `PGSSLMODE` unset for localhost. Then:

```bash
npm start
```

Open `http://localhost:3000`. The same variables, with the Railway values from the table above, are what the hosted service needs.
