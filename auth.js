import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-analytics.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  signInWithPopup,
  GoogleAuthProvider,
  signOut
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

const ERROR_MAP = {
  "auth/email-already-in-use": "This email is already registered. Please login.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/user-not-found": "No account found. Please Sign Up first.",
  "auth/wrong-password": "Wrong password. Try again.",
  "auth/invalid-credential": "Wrong email or password.",
  "auth/weak-password": "Password must be at least 6 characters.",
  "auth/too-many-requests": "Too many attempts. Wait and try again.",
  "auth/popup-closed-by-user": "Google sign-in was cancelled.",
  "auth/popup-blocked": "Popup blocked. Allow popups for this site.",
  "auth/operation-not-allowed": "This sign-in method is disabled in Firebase Console.",
  "auth/network-request-failed": "Network error. Check your connection."
};

let auth = null;

function isConfigured() {
  const c = window.FIREBASE_CONFIG;
  return c && c.apiKey && !String(c.apiKey).includes("YOUR_");
}

function mapError(err) {
  return ERROR_MAP[err?.code] || err?.message || "Authentication failed.";
}

function init() {
  if (!isConfigured()) return false;

  const app = initializeApp(window.FIREBASE_CONFIG);
  auth = getAuth(app);

  if (window.FIREBASE_CONFIG.measurementId) {
    try {
      getAnalytics(app);
    } catch {
      /* analytics optional (localhost, blocked cookies, etc.) */
    }
  }

  onAuthStateChanged(auth, (user) => {
    if (user && typeof window.onFirebaseUser === "function") {
      window.onFirebaseUser(user);
    }
  });

  return true;
}

async function loginEmail(email, password) {
  if (!auth) throw new Error("Firebase not configured.");
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

async function signupEmail(name, email, password) {
  if (!auth) throw new Error("Firebase not configured.");
  const result = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(result.user, { displayName: name });
  return result.user;
}

async function loginGoogle() {
  if (!auth) throw new Error("Firebase not configured.");
  const result = await signInWithPopup(auth, new GoogleAuthProvider());
  return result.user;
}

async function logout() {
  if (auth) await signOut(auth);
}

function getCurrentUser() {
  return auth?.currentUser ?? null;
}

init();

window.mosAuth = {
  isConfigured,
  mapError,
  loginEmail,
  signupEmail,
  loginGoogle,
  logout,
  getCurrentUser
};

window.dispatchEvent(new Event("mosAuthReady"));