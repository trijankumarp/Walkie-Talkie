import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-analytics.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  updateEmail,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
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
  "auth/network-request-failed": "Network error. Check your connection.",
  "auth/requires-recent-login": "Please logout and login again, then try this change.",
  "auth/invalid-password": "Current password is wrong.",
  "auth/configuration-not-found":
    "Firebase Authentication is not enabled. Open Firebase Console → walkietalkie-mos → Build → Authentication → Get started, then enable Email/Password and Google."
};

let auth = null;

function isConfigured() {
  const c = window.FIREBASE_CONFIG;
  return (
    c &&
    c.apiKey &&
    c.appId &&
    !String(c.apiKey).includes("YOUR_") &&
    !String(c.appId).includes("YOUR_")
  );
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

async function reauthWithPassword(password) {
  const user = auth?.currentUser;
  if (!user?.email) throw new Error("No signed-in user.");
  const cred = EmailAuthProvider.credential(user.email, password);
  await reauthenticateWithCredential(user, cred);
}

async function updateDisplayName(name) {
  if (!auth?.currentUser) throw new Error("Not signed in.");
  await updateProfile(auth.currentUser, { displayName: name });
}

async function changeEmail(newEmail, currentPassword) {
  if (!auth?.currentUser) throw new Error("Not signed in.");
  await reauthWithPassword(currentPassword);
  await updateEmail(auth.currentUser, newEmail);
}

async function changePassword(currentPassword, newPassword) {
  if (!auth?.currentUser) throw new Error("Not signed in.");
  await reauthWithPassword(currentPassword);
  await updatePassword(auth.currentUser, newPassword);
}

init();

window.mosAuth = {
  isConfigured,
  mapError,
  loginEmail,
  signupEmail,
  loginGoogle,
  logout,
  getCurrentUser,
  updateDisplayName,
  changeEmail,
  changePassword
};

window.dispatchEvent(new Event("mosAuthReady"));