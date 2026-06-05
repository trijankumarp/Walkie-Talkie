# M-OS Walkie-Talkie

Offline-friendly team walkie PWA with **real Firebase login** (email + Google).

**Firebase project:** `projectm-chinna` (Walkie-Talkie web app)

---

## 1. Firebase setup

1. [Firebase Console](https://console.firebase.google.com/) → project **projectm-chinna**
2. **Build → Authentication** → enable **Email/Password** + **Google**
3. **Project settings → Your apps → Web** (`</>`) → register app → copy `firebaseConfig`
4. Local dev:
   ```powershell
   copy firebase-config.example.js firebase-config.js
   ```
   Paste `apiKey`, `messagingSenderId`, `appId` from console.
5. **Authentication → Settings → Authorized domains** → add:
   - `localhost`
   - `projectm-chinna.firebaseapp.com` (usually auto)
   - Your **Vercel** domain, e.g. `mos-walkie.vercel.app`
   - `*.vercel.app` is not allowed — add each deployment URL you use

---

## 2. GitHub

```powershell
cd "C:\Users\trija\Desktop\Work\VS\Walkie-Talkie"
gh auth login
gh repo create Walkie-Talkie --public --source=. --remote=origin --push
```

If repo already exists:

```powershell
git remote add origin https://github.com/trijankumarp/Walkie-Talkie.git
git push -u origin main
```

`firebase-config.js` and `.env` are **not** pushed (secrets stay local / in Vercel).

---

## 3. Vercel (deploy from GitHub)

1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. **Import** your GitHub repo `Walkie-Talkie`
3. Framework: **Other** (static site)
4. **Environment Variables** (from Firebase web app config):

   | Name | Example |
   |------|---------|
   | `FIREBASE_API_KEY` | from Firebase console |
   | `FIREBASE_AUTH_DOMAIN` | `projectm-chinna.firebaseapp.com` |
   | `FIREBASE_PROJECT_ID` | `projectm-chinna` |
   | `FIREBASE_STORAGE_BUCKET` | `projectm-chinna.firebasestorage.app` |
   | `FIREBASE_MESSAGING_SENDER_ID` | `430423708331` |
   | `FIREBASE_MESSAGING_SENDER_ID` | from Firebase console |
   | `FIREBASE_APP_ID` | from Firebase console |

5. **Deploy** → open `https://your-project.vercel.app`
6. Copy that URL → Firebase **Authorized domains** → add it
7. Every git push to `main` auto-redeploys on Vercel

---

## Run locally

```powershell
copy firebase-config.example.js firebase-config.js
# paste keys, then:
python -m http.server 8080
```

Open: http://localhost:8080/

---

## Project structure

| File | Purpose |
|------|---------|
| `walkie.html` | Main app |
| `auth.js` | Firebase login |
| `vercel.json` | Vercel build + routing |
| `scripts/generate-firebase-config.js` | Builds config from env on Vercel |
| `.env.example` | Env var template |