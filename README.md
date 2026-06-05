# M-OS Walkie Talkie

Offline-friendly team walkie PWA with **real Firebase login** (email + Google).

## Setup Firebase (required for login)

1. Go to [Firebase Console](https://console.firebase.google.com/) → **Create project** (or use existing).
2. **Build → Authentication → Get started**
   - Enable **Email/Password**
   - Enable **Google** (add support email when asked)
3. **Project settings → Your apps → Web** (`</>`) → Register app → copy config.
4. In this folder:
   ```bash
   copy firebase-config.example.js firebase-config.js
   ```
   Paste your real keys into `firebase-config.js`.
5. **Authentication → Settings → Authorized domains** — add:
   - `localhost`
   - Your GitHub Pages domain (e.g. `trijankumarp.github.io`) if you deploy there.

## Run locally

```bash
python -m http.server 8080
```

Open: http://localhost:8080/walkie.html

## Push to GitHub

```bash
git init
git add .
git commit -m "M-OS Walkie with Firebase auth"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/Walkie.git
git push -u origin main
```

`firebase-config.js` is gitignored — never commit API keys.

## GitHub Pages (optional)

Repo → **Settings → Pages** → Source: `main` branch → folder `/ (root)` → Save.

Use URL: `https://YOUR_USERNAME.github.io/Walkie/walkie.html`

Add that domain in Firebase **Authorized domains**.