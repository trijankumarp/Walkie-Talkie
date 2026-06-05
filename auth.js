window.mosAuth = (function () {
  let auth = null;

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

  function isConfigured() {
    const c = window.FIREBASE_CONFIG;
    return c && c.apiKey && !String(c.apiKey).includes("YOUR_");
  }

  function mapError(err) {
    return ERROR_MAP[err?.code] || err?.message || "Authentication failed.";
  }

  function init() {
    if (!isConfigured()) return false;
    if (!firebase.apps.length) {
      firebase.initializeApp(window.FIREBASE_CONFIG);
    }
    auth = firebase.auth();
    auth.onAuthStateChanged((user) => {
      if (user && typeof window.onFirebaseUser === "function") {
        window.onFirebaseUser(user);
      }
    });
    return true;
  }

  async function loginEmail(email, password) {
    if (!auth) throw new Error("Firebase not configured.");
    const result = await auth.signInWithEmailAndPassword(email, password);
    return result.user;
  }

  async function signupEmail(name, email, password) {
    if (!auth) throw new Error("Firebase not configured.");
    const result = await auth.createUserWithEmailAndPassword(email, password);
    await result.user.updateProfile({ displayName: name });
    return result.user;
  }

  async function loginGoogle() {
    if (!auth) throw new Error("Firebase not configured.");
    const provider = new firebase.auth.GoogleAuthProvider();
    const result = await auth.signInWithPopup(provider);
    return result.user;
  }

  async function logout() {
    if (auth) await auth.signOut();
  }

  function getCurrentUser() {
    return auth ? auth.currentUser : null;
  }

  init();

  return {
    isConfigured,
    mapError,
    loginEmail,
    signupEmail,
    loginGoogle,
    logout,
    getCurrentUser
  };
})();