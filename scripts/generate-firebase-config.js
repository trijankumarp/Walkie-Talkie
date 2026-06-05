const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outFile = path.join(root, "firebase-config.js");
const deployFile = path.join(root, "firebase-config.deploy.js");

const config = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || "walkietalkie-mos.firebaseapp.com",
  projectId: process.env.FIREBASE_PROJECT_ID || "walkietalkie-mos",
  storageBucket:
    process.env.FIREBASE_STORAGE_BUCKET || "walkietalkie-mos.firebasestorage.app",
  messagingSenderId:
    process.env.FIREBASE_MESSAGING_SENDER_ID || "905289525416",
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || "G-H97RRNDT3E"
};

const missing = ["apiKey", "appId"].filter((k) => !config[k]);

if (!missing.length) {
  writeConfig(config, "env vars");
  process.exit(0);
}

if (fs.existsSync(deployFile)) {
  fs.copyFileSync(deployFile, outFile);
  console.log("Generated firebase-config.js from firebase-config.deploy.js");
  process.exit(0);
}

if (fs.existsSync(outFile) && !process.env.VERCEL) {
  console.log("Build skipped: using existing firebase-config.js (local).");
  process.exit(0);
}

console.error(
  "Missing Firebase config.\n",
  "Set Vercel env: FIREBASE_API_KEY, FIREBASE_APP_ID\n",
  "Or add firebase-config.deploy.js / firebase-config.js locally."
);
process.exit(process.env.VERCEL ? 1 : 0);

function writeConfig(cfg, source) {
  const cleaned = Object.fromEntries(
    Object.entries(cfg).filter(([, v]) => v != null && v !== "")
  );
  const content =
    `// Auto-generated from ${source}\n` +
    `window.FIREBASE_CONFIG = ${JSON.stringify(cleaned, null, 2)};\n`;
  fs.writeFileSync(outFile, content);
  console.log("Generated firebase-config.js for project:", cleaned.projectId);
}