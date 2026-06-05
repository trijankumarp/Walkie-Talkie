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
  sendEmailVerification,
  verifyBeforeUpdateEmail,
  reauthenticateWithCredential,
  EmailAuthProvider,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  PhoneAuthProvider,
  linkWithCredential,
  signInWithPopup,
  GoogleAuthProvider,
  signOut
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

const OTP_PENDING_KEY = "walkie_otp_pending_v1";
let recaptchaVerifier = null;
let phoneConfirmationResult = null;

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
  "auth/invalid-verification-code": "Wrong verification code. Try again.",
  "auth/code-expired": "Code expired. Send a new code.",
  "auth/invalid-phone-number": "Invalid phone number for selected country.",
  "auth/captcha-check-failed": "Captcha failed. Refresh and try again.",
  "auth/account-exists-with-different-credential": "This phone is linked to another account.",
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

async function signupEmail(firstName, lastName, email, password) {
  if (!auth) throw new Error("Firebase not configured.");
  const displayName = `${firstName} ${lastName}`.trim();
  const result = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(result.user, { displayName });
  try {
    await sendEmailVerification(result.user);
  } catch {
    /* optional */
  }
  return result.user;
}

async function sendUserEmailVerification() {
  if (!auth?.currentUser) throw new Error("Not signed in.");
  await sendEmailVerification(auth.currentUser);
}

function isEmailVerified() {
  return !!auth?.currentUser?.emailVerified;
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

function storePendingOtp(type, target, otp) {
  const uid = auth?.currentUser?.uid || "anon";
  sessionStorage.setItem(
    OTP_PENDING_KEY,
    JSON.stringify({
      uid,
      type,
      target,
      otp,
      exp: Date.now() + 10 * 60 * 1000
    })
  );
}

function readPendingOtp() {
  try {
    const raw = sessionStorage.getItem(OTP_PENDING_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.exp < Date.now()) {
      sessionStorage.removeItem(OTP_PENDING_KEY);
      return null;
    }
    const uid = auth?.currentUser?.uid;
    if (uid && data.uid !== uid) return null;
    return data;
  } catch {
    return null;
  }
}

function clearPendingOtp() {
  sessionStorage.removeItem(OTP_PENDING_KEY);
}

function verifyStoredOtp(code, type, target) {
  const pending = readPendingOtp();
  if (!pending || pending.type !== type) return false;
  if (pending.target !== target) return false;
  if (String(code).trim() !== pending.otp) return false;
  clearPendingOtp();
  return true;
}

/** Reauth + 6-digit code (demo: returned for UI; production needs email/SMS backend). */
async function requestEmailChangeOtp(newEmail, currentPassword) {
  if (!auth?.currentUser) throw new Error("Not signed in.");
  await reauthWithPassword(currentPassword);
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  storePendingOtp("email", newEmail, otp);
  try {
    await verifyBeforeUpdateEmail(auth.currentUser, newEmail);
  } catch {
    /* still allow OTP step if verify-before-update not enabled */
  }
  return { otp, email: newEmail };
}

async function confirmEmailChangeOtp(newEmail, otpCode, currentPassword) {
  if (!auth?.currentUser) throw new Error("Not signed in.");
  if (!verifyStoredOtp(otpCode, "email", newEmail)) {
    throw Object.assign(new Error("Invalid or expired verification code."), {
      code: "auth/invalid-verification-code"
    });
  }
  await reauthWithPassword(currentPassword);
  await updateEmail(auth.currentUser, newEmail);
}

function getRecaptchaVerifier() {
  const el = document.getElementById("recaptcha-container");
  if (!el) throw new Error("reCAPTCHA container missing.");
  if (!recaptchaVerifier) {
    recaptchaVerifier = new RecaptchaVerifier(auth, el, { size: "invisible" });
  }
  return recaptchaVerifier;
}

async function sendPhoneOtp(e164Phone) {
  if (!auth?.currentUser) throw new Error("Not signed in.");
  phoneConfirmationResult = await signInWithPhoneNumber(
    auth,
    e164Phone,
    getRecaptchaVerifier()
  );
}

async function confirmPhoneOtp(otpCode, e164Phone) {
  if (!auth?.currentUser) throw new Error("Not signed in.");
  if (phoneConfirmationResult) {
    const cred = PhoneAuthProvider.credential(
      phoneConfirmationResult.verificationId,
      String(otpCode).trim()
    );
    try {
      await linkWithCredential(auth.currentUser, cred);
    } catch (err) {
      if (err?.code !== "auth/provider-already-linked") throw err;
    }
    phoneConfirmationResult = null;
    return;
  }
  if (!verifyStoredOtp(otpCode, "phone", e164Phone)) {
    throw Object.assign(new Error("Invalid or expired verification code."), {
      code: "auth/invalid-verification-code"
    });
  }
}

/** Fallback when Phone Auth is off in Firebase Console. */
async function requestPhoneChangeOtp(e164Phone, currentPassword) {
  if (!auth?.currentUser) throw new Error("Not signed in.");
  await reauthWithPassword(currentPassword);
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  storePendingOtp("phone", e164Phone, otp);
  return { otp, phone: e164Phone };
}

init();

window.mosAuth = {
  isConfigured,
  mapError,
  loginEmail,
  signupEmail,
  sendUserEmailVerification,
  isEmailVerified,
  loginGoogle,
  logout,
  getCurrentUser,
  reauthWithPassword,
  updateDisplayName,
  changeEmail,
  changePassword,
  requestEmailChangeOtp,
  confirmEmailChangeOtp,
  sendPhoneOtp,
  confirmPhoneOtp,
  requestPhoneChangeOtp
};

window.dispatchEvent(new Event("mosAuthReady"));