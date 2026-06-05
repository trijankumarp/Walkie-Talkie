# Walkie Talkie (M-OS)

Team walkie-talkie PWA with **Firebase login** (email + Google).

| Link | URL |
|------|-----|
| **Live app** | https://walkie-talkie-kappa.vercel.app |
| **GitHub** | https://github.com/trijankumarp/Walkie-Talkie |
| **Firebase** | `walkietalkie-mos` |

---

## Folder

```
C:\Users\trija\Desktop\Work\VS\Walkie-Talkie
```

---

## Run locally

```powershell
cd "C:\Users\trija\Desktop\Work\VS\Walkie-Talkie"
npm run build
npm start
```

Open: http://localhost:8080/

---

## Firebase (one-time)

1. [Firebase Console](https://console.firebase.google.com/) → **walkie talkie** (`walkietalkie-mos`)
2. **Authentication** → enable **Email/Password** + **Google**
3. **Authorized domains** → add:
   - `localhost`
   - `walkie-talkie-kappa.vercel.app`

Web app config is in `firebase-config.deploy.js` (used for Vercel build).

---

## Vercel deploy

Repo is connected to GitHub. Each push to `main` redeploys.

**Optional** env vars (override deploy config): copy from `vercel.env.import` → Vercel **Settings → Environment Variables → Import .env**

Build uses `firebase-config.deploy.js` if env vars are not set.

---

## Files

| File | Purpose |
|------|---------|
| `walkie.html` | UI |
| `auth.js` | Firebase 12 modular (CDN) |
| `app.js` | Login + walkie logic |
| `firebase-config.js` | Local overrides (gitignored) |
| `firebase-config.deploy.js` | Production Firebase config |
| `vercel.json` | Vercel build settings |

---

## Stack

- Static HTML / JS (no React)
- Firebase Auth v12 (`import` from gstatic CDN)
- `npm install firebase` (optional; CDN used in browser)
- Vercel static hosting