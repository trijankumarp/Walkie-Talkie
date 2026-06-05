const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outFile = path.join(root, "firebase-config.js");

const config = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || "projectm-chinna.firebaseapp.com",
  projectId: process.env.FIREBASE_PROJECT_ID || "projectm-chinna",
  storageBucket:
    process.env.FIREBASE_STORAGE_BUCKET || "projectm-chinna.firebasestorage.app",
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

const missing = ["apiKey", "messagingSenderId", "appId"].filter((k) => !config[k]);

if (missing.length) {
  const localFile = outFile;
  if (fs.existsSync(localFile) && !process.env.VERCEL) {
    console.log("Build skipped: using existing firebase-config.js (local dev).");
    process.exit(0);
  }
  console.error(
    "Missing Firebase env vars:",
    missing.join(", "),
    "\nSet them in Vercel → Settings → Environment Variables, or copy firebase-config.example.js locally."
  );
  process.exit(process.env.VERCEL ? 1 : 0);
}

const content =
  "// Auto-generated at build — do not edit on Vercel.\n" +
  `window.FIREBASE_CONFIG = ${JSON.stringify(config, null, 2)};\n`;

fs.writeFileSync(outFile, content);
console.log("Generated firebase-config.js for project:", config.projectId);