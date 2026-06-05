const CHANNELS_KEY = "walkie_channels_v1";

let isLoggedIn = false;
let isMuted = false;
let isTalking = false;
let currentChannel = null;
let channels = [];
let bleDevice = null;
let loggedInUser = null;

function loadChannels() {
  try {
    const raw = localStorage.getItem(CHANNELS_KEY);
    channels = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(channels)) channels = [];
  } catch {
    channels = [];
  }
}

function saveChannels() {
  localStorage.setItem(CHANNELS_KEY, JSON.stringify(channels));
}

function getActiveChannel() {
  return channels.find((c) => c.id === currentChannel) || null;
}

function getActiveChannelName() {
  const ch = getActiveChannel();
  return ch ? ch.name : null;
}

function updatePttHint() {
  const hint = document.getElementById("pttHint");
  if (!hint) return;
  const name = getActiveChannelName();
  hint.textContent = name
    ? `Channel: ${name} — hold orb to talk`
    : "Create or select a channel first";
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function clearFieldErrors() {
  document.querySelectorAll("input.input-error").forEach((el) => el.classList.remove("input-error"));
}

function setFieldError(...inputIds) {
  inputIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add("input-error");
  });
}

function setAuthError(msg, fieldIds = []) {
  clearFieldErrors();
  if (fieldIds.length) setFieldError(...fieldIds);
  const el = document.getElementById("authError");
  if (!el) return;
  if (msg && msg.includes("Authentication is not enabled")) {
    el.innerHTML =
      msg +
      '<br><a href="https://console.firebase.google.com/project/walkietalkie-mos/authentication" target="_blank" rel="noopener" style="color:#2563eb;margin-top:8px;display:inline-block;">Open Firebase Authentication →</a>';
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
  setAuthError("", []);
  const isLogin = tab === "login";
  document.getElementById("tabLogin").classList.toggle("active", isLogin);
  document.getElementById("tabSignup").classList.toggle("active", !isLogin);
  document.getElementById("panelLogin").classList.toggle("active", isLogin);
  document.getElementById("panelSignup").classList.toggle("active", !isLogin);
}

function refreshStatusBar() {
  if (!loggedInUser || !isLoggedIn) return;
  const ch = getActiveChannelName();
  const chLine = ch
    ? `<br><span class="accent" style="font-size:13px;">Channel: ${ch}</span>`
    : "";
  document.getElementById("status").innerHTML = `Logged in as <strong>${loggedInUser.name}</strong><br><span style="font-size:13px;color:#888">${loggedInUser.email}</span>${chLine}`;
}

function enterApp(user) {
  isLoggedIn = true;
  loggedInUser = user;
  loadChannels();
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("mainUI").style.display = "block";
  refreshStatusBar();
  renderChannels();
  updatePttHint();
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
  if (!email) return setAuthError("Please enter Gmail or email address.", ["signupEmail"]);
  if (!isValidEmail(email))
    return setAuthError("Wrong email format. Use you@gmail.com", ["signupEmail"]);
  if (password.length < 6) return setAuthError("Password must be at least 6 characters.", ["signupPassword"]);
  if (password !== confirm)
    return setAuthError("Passwords do not match.", ["signupPassword", "signupConfirm"]);

  setAuthLoading(true);
  setAuthError("", []);
  try {
    await window.mosAuth.signupEmail(name, email, password);
    alert("Account created successfully!");
    showAuthTab("login");
    document.getElementById("loginEmail").value = email;
  } catch (err) {
    const msg = window.mosAuth.mapError(err);
    const fields =
      msg.includes("email") || err?.code?.includes("email") ? ["signupEmail"] : [];
    setAuthError(msg, fields);
  } finally {
    setAuthLoading(false);
  }
}

async function login() {
  if (!requireFirebase()) return;
  const email = document.getElementById("loginEmail").value.trim().toLowerCase();
  const password = document.getElementById("loginPassword").value;

  if (!email) return setAuthError("Please enter Gmail or email address.", ["loginEmail"]);
  if (!isValidEmail(email))
    return setAuthError("Wrong email ID. Check and try again.", ["loginEmail"]);
  if (!password) return setAuthError("Please enter your password.", ["loginPassword"]);

  setAuthLoading(true);
  setAuthError("", []);
  try {
    const user = await window.mosAuth.loginEmail(email, password);
    enterApp({
      name: user.displayName || user.email.split("@")[0],
      email: user.email
    });
  } catch (err) {
    const msg = window.mosAuth.mapError(err);
    const fields = ["loginEmail", "loginPassword"];
    if (
      err?.code === "auth/user-not-found" ||
      err?.code === "auth/invalid-email" ||
      err?.code === "auth/invalid-credential"
    ) {
      setFieldError("loginEmail");
    }
    setAuthError(msg, fields);
  } finally {
    setAuthLoading(false);
  }
}

async function loginWithGoogle() {
  if (!requireFirebase()) return;
  setAuthLoading(true);
  setAuthError("", []);
  try {
    const user = await window.mosAuth.loginGoogle();
    enterApp({
      name: user.displayName || user.email.split("@")[0],
      email: user.email
    });
  } catch (err) {
    setAuthError(window.mosAuth.mapError(err), []);
  } finally {
    setAuthLoading(false);
  }
}

async function signupWithGoogle() {
  return loginWithGoogle();
}

function renderChannels() {
  const container = document.getElementById("channelList");
  container.innerHTML = "";

  if (channels.length === 0) {
    container.innerHTML =
      '<div class="channel-empty">No channels yet.<br>Create your first channel above.</div>';
    currentChannel = null;
    updatePttHint();
    return;
  }

  if (!currentChannel || !channels.some((c) => c.id === currentChannel)) {
    currentChannel = channels[0].id;
  }

  channels.forEach((ch) => {
    const div = document.createElement("div");
    div.className = "channel-item" + (ch.id === currentChannel ? " active" : "");

    div.innerHTML = `
      <span class="channel-name">${ch.name}</span>
      <button class="delete-btn" onclick="deleteChannel(${ch.id}); event.stopImmediatePropagation();">Delete</button>
    `;

    div.onclick = (e) => {
      if (e.target.classList.contains("delete-btn")) return;
      currentChannel = ch.id;
      renderChannels();
      refreshStatusBar();
      updatePttHint();
    };

    container.appendChild(div);
  });
  updatePttHint();
}

function deleteChannel(id) {
  if (!confirm("Delete this channel?")) return;
  channels = channels.filter((ch) => ch.id !== id);
  if (currentChannel === id) {
    currentChannel = channels.length ? channels[0].id : null;
  }
  saveChannels();
  renderChannels();
}

function addNewChannel() {
  const input = document.getElementById("newChannelName");
  const name = input.value.trim();
  if (!name) {
    alert("Please enter a channel name.");
    return;
  }
  const newId = channels.length ? Math.max(...channels.map((c) => c.id)) + 1 : 1;
  channels.push({ id: newId, name });
  currentChannel = newId;
  input.value = "";
  saveChannels();
  renderChannels();
}

function setBluetoothUi(connected, deviceName) {
  const disconnectBtn = document.getElementById("btnBtDisconnect");
  const conn = document.getElementById("connStatus");
  if (connected) {
    if (disconnectBtn) disconnectBtn.style.display = "block";
    if (conn) {
      conn.innerHTML = `Bluetooth connected: <strong>${deviceName}</strong>`;
      conn.style.color = "#2563eb";
    }
  } else {
    if (disconnectBtn) disconnectBtn.style.display = "none";
    bleDevice = null;
  }
}

async function disconnectBluetooth() {
  try {
    if (bleDevice?.gatt?.connected) {
      bleDevice.gatt.disconnect();
    }
  } catch {
    /* ignore */
  }
  bleDevice = null;
  setBluetoothUi(false);
  document.getElementById("btList").innerHTML =
    '<div class="item">Bluetooth disconnected. Tap Scan & Connect to pair again.</div>';
  document.getElementById("connStatus").innerHTML = "No connection";
  document.getElementById("connStatus").style.color = "";
}

async function scanBluetooth() {
  const list = document.getElementById("btList");
  list.innerHTML = '<div class="item">Opening Bluetooth device picker...</div>';

  try {
    if (!navigator.bluetooth) {
      list.innerHTML = `
        <div class="item warn">Bluetooth not supported here.</div>
        <div class="item">Use <strong>Chrome</strong>, <strong>Edge</strong>, or <strong>Windows app</strong> (npm run windows).</div>
      `;
      return;
    }

    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: ["battery_service", "device_information"]
    });

    bleDevice = device;
    device.addEventListener("gattserverdisconnected", () => {
      setBluetoothUi(false);
      list.innerHTML = '<div class="item warn">Bluetooth device disconnected.</div>';
    });

    list.innerHTML = `<div class="item">Connecting to ${device.name || "device"}...</div>`;

    if (device.gatt) {
      await device.gatt.connect();
    }

    const name = device.name || "Bluetooth device";
    list.innerHTML = `
      <div class="item ok">Connected: <strong>${name}</strong></div>
      <div class="item ok">Device is paired. Use the same channel for team talk.</div>
    `;
    setBluetoothUi(true, name);
  } catch (err) {
    if (err?.name === "NotFoundError") {
      list.innerHTML = '<div class="item">No device selected.</div>';
    } else {
      list.innerHTML = `<div class="item warn">${err.message || "Bluetooth failed. Allow Bluetooth and try again."}</div>`;
    }
  }
}

function getNetworkHint() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return "Network: WiFi or mobile data";
  const types = { wifi: "WiFi", cellular: "Mobile data", ethernet: "Ethernet", none: "Offline" };
  const t = types[conn.type] || conn.type || "Unknown";
  return `Network: ${t}${conn.effectiveType ? ` (${conn.effectiveType})` : ""}`;
}

async function scanWiFi() {
  const list = document.getElementById("wifiList");
  const channelName = getActiveChannelName() || "(no channel — create one)";

  if (window.windowsAPI?.scanWifiNetworks) {
    list.innerHTML = '<div class="item">Scanning WiFi (Windows)...</div>';
    try {
      const result = await window.windowsAPI.scanWifiNetworks();
      if (result.ok && result.networks.length) {
        const connected = result.connected
          ? `<div class="item ok">Connected: <strong>${result.connected}</strong></div>`
          : "";
        const items = result.networks.map((n) => `<div class="item ok">${n}</div>`).join("");
        list.innerHTML = `${connected}${items}<div class="item ok">Channel: ${channelName}</div>`;
        document.getElementById("connStatus").innerHTML = result.connected
          ? `WiFi: ${result.connected}`
          : `Found ${result.networks.length} networks`;
        document.getElementById("connStatus").style.color = "#2563eb";
        return;
      }
      list.innerHTML = `<div class="item warn">${result.message || "No networks found."}</div>`;
      return;
    } catch (err) {
      list.innerHTML = `<div class="item warn">${err.message}</div>`;
      return;
    }
  }

  list.innerHTML = `
    <div class="item ok">${getNetworkHint()}</div>
    <div class="item ok">Put all devices on the <strong>same WiFi</strong>.</div>
    <div class="item ok">Use the same channel: <strong>${channelName}</strong></div>
    <div class="item warn">For WiFi list scan use the Windows desktop app.</div>
  `;
  document.getElementById("connStatus").innerHTML = "Team WiFi mode";
  document.getElementById("connStatus").style.color = "#2563eb";
}

function toggleMute() {
  isMuted = !isMuted;
  const btn = document.getElementById("muteBtn");
  const icon = document.getElementById("muteIcon");
  const label = document.getElementById("muteLabel");
  if (btn) btn.classList.toggle("muted", isMuted);
  if (icon) icon.textContent = isMuted ? "🔇" : "🔊";
  if (label) label.textContent = isMuted ? "Muted" : "Mute";
  if (isMuted && isTalking) stopTalk();
}

function setPttVisual(talking) {
  const orb = document.getElementById("pttBtn");
  const label = document.getElementById("pttLabel");
  const icon = document.getElementById("pttIcon");
  if (!orb) return;
  orb.classList.toggle("talking", talking);
  if (label) label.textContent = talking ? "Listening…" : "Hold to talk";
  if (icon) icon.textContent = talking ? "🔊" : "🎙";
}

function startTalk(e) {
  if (e?.cancelable) e.preventDefault();
  if (isMuted) return;
  if (!getActiveChannelName()) {
    alert("Create or select a channel first.");
    return;
  }
  isTalking = true;
  setPttVisual(true);
  const ch = getActiveChannelName();
  document.getElementById("status").innerHTML = `<span class="accent">Transmitting on <strong>${ch}</strong></span>`;
}

function stopTalk(e) {
  if (e?.cancelable) e.preventDefault();
  if (!isTalking) return;
  isTalking = false;
  setPttVisual(false);
  refreshStatusBar();
}

async function logout() {
  isLoggedIn = false;
  stopTalk();
  await disconnectBluetooth();
  try {
    await window.mosAuth.logout();
  } catch {
    /* ignore */
  }
  document.getElementById("mainUI").style.display = "none";
  document.getElementById("loginScreen").style.display = "block";
  showAuthTab("login");
  setAuthError("", []);
}

function boot() {
  loadChannels();
  if (!window.mosAuth?.isConfigured()) {
    setAuthError("Add Firebase keys in firebase-config.js to enable real login.");
  }
  if (window.windowsAPI?.isDesktop) {
    const status = document.getElementById("status");
    if (status && !isLoggedIn) status.innerHTML = "Windows app · Ready";
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === " " && isLoggedIn && !isMuted) {
      e.preventDefault();
      startTalk();
    }
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === " " && isLoggedIn) stopTalk();
  });
}

Object.assign(window, {
  showAuthTab,
  login,
  loginWithGoogle,
  signupWithGoogle,
  signup,
  scanBluetooth,
  disconnectBluetooth,
  scanWiFi,
  toggleMute,
  startTalk,
  stopTalk,
  logout,
  addNewChannel,
  deleteChannel
});

if (window.mosAuth) boot();
else window.addEventListener("mosAuthReady", boot, { once: true });