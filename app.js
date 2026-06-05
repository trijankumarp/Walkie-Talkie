let isLoggedIn = false;
let isMuted = false;
let currentChannel = 1;
let channels = [
  { id: 1, name: "Channel 1 - Team A" },
  { id: 2, name: "Channel 2 - Workers" },
  { id: 3, name: "Channel 3 - SOS" }
];

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function setAuthError(msg) {
  const el = document.getElementById("authError");
  if (!el) return;
  if (msg && msg.includes("Authentication is not enabled")) {
    el.innerHTML =
      msg +
      '<br><a href="https://console.firebase.google.com/project/walkietalkie-mos/authentication" target="_blank" rel="noopener" style="color:#00cc66;margin-top:8px;display:inline-block;">Open Firebase Authentication →</a>';
  } else {
    el.textContent = msg || "";
  }
}

function setAuthLoading(loading) {
  ["btnLogin", "btnSignup", "btnGoogle", "btnGoogleSignup"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = loading;
  });
}

function requireFirebase() {
  if (!window.mosAuth?.isConfigured()) {
    setAuthError(
      "Firebase not set up. Copy firebase-config.example.js → firebase-config.js and add your keys."
    );
    return false;
  }
  return true;
}

function showAuthTab(tab) {
  setAuthError("");
  const isLogin = tab === "login";
  document.getElementById("tabLogin").classList.toggle("active", isLogin);
  document.getElementById("tabSignup").classList.toggle("active", !isLogin);
  document.getElementById("panelLogin").classList.toggle("active", isLogin);
  document.getElementById("panelSignup").classList.toggle("active", !isLogin);
}

function enterApp(user) {
  isLoggedIn = true;
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("mainUI").style.display = "block";
  document.getElementById("status").innerHTML = `Logged in as <strong>${user.name}</strong><br><span style="font-size:13px;color:#888">${user.email}</span>`;
  renderChannels();
}

window.onFirebaseUser = function (firebaseUser) {
  if (!firebaseUser || isLoggedIn) return;
  enterApp({
    name: firebaseUser.displayName || firebaseUser.email.split("@")[0],
    email: firebaseUser.email
  });
};

async function signup() {
  if (!requireFirebase()) return;
  const name = document.getElementById("signupName").value.trim();
  const email = document.getElementById("signupEmail").value.trim().toLowerCase();
  const password = document.getElementById("signupPassword").value;
  const confirm = document.getElementById("signupConfirm").value;

  if (!name) return setAuthError("Please enter your full name.");
  if (!email) return setAuthError("Please enter Gmail or email address.");
  if (!isValidEmail(email)) return setAuthError("Enter a valid email (e.g. you@gmail.com).");
  if (password.length < 6) return setAuthError("Password must be at least 6 characters.");
  if (password !== confirm) return setAuthError("Passwords do not match.");

  setAuthLoading(true);
  setAuthError("");
  try {
    await window.mosAuth.signupEmail(name, email, password);
    alert("Account created successfully!");
    showAuthTab("login");
    document.getElementById("loginEmail").value = email;
  } catch (err) {
    setAuthError(window.mosAuth.mapError(err));
  } finally {
    setAuthLoading(false);
  }
}

async function login() {
  if (!requireFirebase()) return;
  const email = document.getElementById("loginEmail").value.trim().toLowerCase();
  const password = document.getElementById("loginPassword").value;

  if (!email) return setAuthError("Please enter Gmail or email address.");
  if (!isValidEmail(email)) return setAuthError("Enter a valid email address.");
  if (!password) return setAuthError("Please enter your password.");

  setAuthLoading(true);
  setAuthError("");
  try {
    const user = await window.mosAuth.loginEmail(email, password);
    enterApp({
      name: user.displayName || user.email.split("@")[0],
      email: user.email
    });
  } catch (err) {
    setAuthError(window.mosAuth.mapError(err));
  } finally {
    setAuthLoading(false);
  }
}

async function loginWithGoogle() {
  if (!requireFirebase()) return;
  setAuthLoading(true);
  setAuthError("");
  try {
    const user = await window.mosAuth.loginGoogle();
    enterApp({
      name: user.displayName || user.email.split("@")[0],
      email: user.email
    });
  } catch (err) {
    setAuthError(window.mosAuth.mapError(err));
  } finally {
    setAuthLoading(false);
  }
}

/** Google sign-up uses same Firebase flow (creates account if new). */
async function signupWithGoogle() {
  return loginWithGoogle();
}

function renderChannels() {
  const container = document.getElementById("channelList");
  container.innerHTML = "";
  channels.forEach((ch) => {
    const div = document.createElement("div");
    div.className = "channel-item";

    div.innerHTML = `
      <span class="channel-name">${ch.name}</span>
      <button class="delete-btn" onclick="deleteChannel(${ch.id}); event.stopImmediatePropagation();">Delete</button>
    `;

    div.onclick = (e) => {
      if (e.target.classList.contains("delete-btn")) return;
      currentChannel = ch.id;
      document.getElementById("status").innerHTML = `Active: <strong>${ch.name}</strong>`;
    };

    container.appendChild(div);
  });
}

function deleteChannel(id) {
  if (confirm("Delete this channel?")) {
    channels = channels.filter((ch) => ch.id !== id);
    if (currentChannel === id && channels.length > 0) {
      currentChannel = channels[0].id;
    }
    renderChannels();
  }
}

function addNewChannel() {
  const input = document.getElementById("newChannelName");
  const name = input.value.trim();
  if (!name) {
    alert("Please enter channel name!");
    return;
  }
  const newId = Math.max(0, ...channels.map((c) => c.id)) + 1;
  channels.push({ id: newId, name: name });
  input.value = "";
  renderChannels();
}

async function scanBluetooth() {
  const list = document.getElementById("btList");
  list.innerHTML = "Scanning for Bluetooth devices...";

  try {
    if (!navigator.bluetooth) {
      list.innerHTML = `
        <div class="item warn">Bluetooth scan not available in this browser.</div>
        <div class="item">Use <strong>Chrome on Android</strong> for Bluetooth pairing.</div>
        <div class="item">Or use <strong>Same WiFi — Team Connect</strong> (button 2).</div>
      `;
      return;
    }

    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: ["battery_service"]
    });

    list.innerHTML = `<div class="item">✅ Connected: ${device.name || "Unknown Device"}</div>`;
    document.getElementById("connStatus").innerHTML = `Bluetooth Connected: ${device.name || "Device"}`;
    document.getElementById("connStatus").style.color = "#00ff88";
  } catch {
    list.innerHTML = "Scan failed or permission denied.";
  }
}

function getNetworkHint() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return "Network: WiFi or mobile data (type hidden by browser)";
  const types = { wifi: "WiFi", cellular: "Mobile data", ethernet: "Ethernet", none: "Offline" };
  const t = types[conn.type] || conn.type || "Unknown";
  return `Network type: ${t}${conn.effectiveType ? ` (${conn.effectiveType})` : ""}`;
}

function scanWiFi() {
  const list = document.getElementById("wifiList");
  const activeCh = channels.find((c) => c.id === currentChannel);
  const channelName = activeCh ? activeCh.name : "Channel 1 - Team A";

  list.innerHTML = `
    <div class="info-banner">
      <strong style="color:#00ff88;">Not broken</strong> — Chrome/Safari block WiFi device scan in web apps.
      Real walkie apps (native) can scan; browser apps cannot.
    </div>
    <div class="item ok">${getNetworkHint()}</div>
    <div class="item ok"><strong>Step 1:</strong> All phones connect to the <strong>same WiFi</strong> (or mobile hotspot).</div>
    <div class="item ok"><strong>Step 2:</strong> Everyone picks the <strong>same channel</strong> below: <span style="color:#00ff88">${channelName}</span></div>
    <div class="item ok"><strong>Step 3:</strong> Press PTT to talk (demo UI — voice needs native app or WebRTC upgrade).</div>
    <div class="item warn"><strong>Bluetooth:</strong> Use button 1 on <strong>Chrome Android</strong> to pair nearby devices.</div>
  `;

  document.getElementById("connStatus").innerHTML =
    `Team mode: Same WiFi + channel «${channelName}»`;
  document.getElementById("connStatus").style.color = "#00ff88";
}

function confirmTeamNetwork() {
  scanWiFi();
}

function toggleMute() {
  isMuted = !isMuted;
  const el = document.getElementById("muteStatus");
  el.innerHTML = isMuted ? "🔇 Muted" : "🔊 Unmuted";
  el.style.color = isMuted ? "#ff4444" : "#ffcc00";
}

function startTalk() {
  if (isMuted) return;
  document.getElementById("pttBtn").style.background =
    "linear-gradient(145deg, #00cc66, #009955)";
  const activeCh = channels.find((c) => c.id === currentChannel);
  document.getElementById("status").innerHTML = `📢 TRANSMITTING → ${activeCh ? activeCh.name : "Channel"}`;
}

function stopTalk() {
  document.getElementById("pttBtn").style.background =
    "linear-gradient(145deg, #cc0000, #990000)";
  document.getElementById("status").innerHTML = "Listening on active channel...";
}

async function logout() {
  isLoggedIn = false;
  try {
    await window.mosAuth.logout();
  } catch {
    /* ignore */
  }
  document.getElementById("mainUI").style.display = "none";
  document.getElementById("loginScreen").style.display = "block";
  showAuthTab("login");
  setAuthError("");
}

function boot() {
  if (!window.mosAuth?.isConfigured()) {
    setAuthError("Add Firebase keys in firebase-config.js to enable real login.");
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === " " && isLoggedIn && !isMuted) startTalk();
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === " ") stopTalk();
  });
}

Object.assign(window, {
  showAuthTab,
  login,
  loginWithGoogle,
  signupWithGoogle,
  signup,
  scanBluetooth,
  scanWiFi,
  confirmTeamNetwork,
  toggleMute,
  startTalk,
  stopTalk,
  logout,
  addNewChannel,
  deleteChannel
});

if (window.mosAuth) boot();
else window.addEventListener("mosAuthReady", boot, { once: true });