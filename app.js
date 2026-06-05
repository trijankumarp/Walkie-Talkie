const CHANNELS_KEY = "walkie_channels_v1";
const THEME_KEY = "walkie_theme_v1";
const BT_DEVICES_KEY = "walkie_bt_devices_v1";
const WIFI_SEL_KEY = "walkie_wifi_selected_v1";
const PROFILE_MOBILE_KEY = "walkie_profile_mobile_v1";
const FRIENDS_KEY = "walkie_friends_v1";

let isLoggedIn = false;
let wifiConnectedName = null;
let selectedWifiName = null;
let isTalking = false;
let currentChannel = null;
let channels = [];
let bleDevice = null;
let loggedInUser = null;
let btPanelOpen = false;
let wifiPanelOpen = false;
let profilePanelOpen = false;
let friendPanelOpen = false;
let teamPanelOpen = false;
let friends = [];
let selectedBtId = null;
let savedBtDevices = [];

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
    ? `Hold the button to talk on ${name}`
    : "Open menu (top left) to select or create a team";
}

function openMenu() {
  document.getElementById("menuOverlay")?.classList.add("open");
  document.getElementById("sideMenu")?.classList.add("open");
}

function closeMenu() {
  document.getElementById("menuOverlay")?.classList.remove("open");
  document.getElementById("sideMenu")?.classList.remove("open");
}

function loadBtDevices() {
  try {
    const raw = localStorage.getItem(BT_DEVICES_KEY);
    savedBtDevices = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(savedBtDevices)) savedBtDevices = [];
  } catch {
    savedBtDevices = [];
  }
}

function saveBtDevices() {
  localStorage.setItem(BT_DEVICES_KEY, JSON.stringify(savedBtDevices));
}

function loadSelectedWifi() {
  selectedWifiName = localStorage.getItem(WIFI_SEL_KEY) || null;
}

function setBluetoothMenuOpen(open) {
  btPanelOpen = open;
  document.getElementById("btnBluetoothMenu")?.classList.toggle("selected", open);
  document.getElementById("btPanel")?.classList.toggle("open", open);
}

function setWifiMenuOpen(open) {
  wifiPanelOpen = open;
  document.getElementById("btnWifiMenu")?.classList.toggle("selected", open);
  document.getElementById("wifiPanel")?.classList.toggle("open", open);
}

function toggleBluetoothMenu(forceOpen) {
  const next = forceOpen === true ? true : forceOpen === false ? false : !btPanelOpen;
  if (next) {
    setBluetoothMenuOpen(true);
    setWifiMenuOpen(false);
    renderBluetoothList();
  } else {
    setBluetoothMenuOpen(false);
  }
}

function toggleWifiMenu(forceOpen) {
  const next = forceOpen === true ? true : forceOpen === false ? false : !wifiPanelOpen;
  if (next) {
    setWifiMenuOpen(true);
    setBluetoothMenuOpen(false);
    refreshWifiList();
  } else {
    setWifiMenuOpen(false);
  }
}

function toggleTeamPanel() {
  teamPanelOpen = !teamPanelOpen;
  document.getElementById("btnTeamAction")?.classList.toggle("selected", teamPanelOpen);
  document.getElementById("teamPanel")?.classList.toggle("open", teamPanelOpen);
  if (teamPanelOpen) renderChannels();
}

function toggleFriendPanel() {
  friendPanelOpen = !friendPanelOpen;
  document.getElementById("btnFriendAction")?.classList.toggle("selected", friendPanelOpen);
  document.getElementById("friendPanel")?.classList.toggle("open", friendPanelOpen);
  if (friendPanelOpen) renderFriends();
}

function toggleProfilePanel() {
  profilePanelOpen = !profilePanelOpen;
  document.getElementById("btnProfileAction")?.classList.toggle("selected", profilePanelOpen);
  document.getElementById("profilePanel")?.classList.toggle("open", profilePanelOpen);
  if (profilePanelOpen) fillProfileForm();
}

function loadFriends() {
  try {
    const raw = localStorage.getItem(FRIENDS_KEY);
    friends = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(friends)) friends = [];
  } catch {
    friends = [];
  }
}

function saveFriends() {
  localStorage.setItem(FRIENDS_KEY, JSON.stringify(friends));
}

function setFriendMsg(msg, isError) {
  const el = document.getElementById("friendMsg");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "profile-msg" + (msg ? (isError ? " err" : " ok") : "");
}

function renderFriends() {
  const container = document.getElementById("friendList");
  if (!container) return;
  if (!friends.length) {
    container.innerHTML =
      '<div class="channel-empty">No friends yet.<br>Add email or name above.</div>';
    return;
  }
  container.innerHTML = "";
  friends.forEach((f, index) => {
    const div = document.createElement("div");
    div.className = "channel-item";
    div.innerHTML = `
      <span class="channel-name">${escapeHtml(f.label)}</span>
      <button type="button" class="delete-btn" title="Remove friend" onclick="removeFriend(${index}); event.stopPropagation();">🗑</button>
    `;
    container.appendChild(div);
  });
}

function addFriend() {
  const input = document.getElementById("newFriendInput");
  const val = input?.value.trim();
  if (!val) return setFriendMsg("Enter friend email or name.", true);
  if (friends.some((f) => f.label.toLowerCase() === val.toLowerCase())) {
    return setFriendMsg("Friend already in list.", true);
  }
  friends.push({ label: val });
  input.value = "";
  saveFriends();
  renderFriends();
  setFriendMsg("Friend added.");
}

function removeFriend(index) {
  friends.splice(index, 1);
  saveFriends();
  renderFriends();
  setFriendMsg("Friend removed.");
}

function setProfileMsg(msg, isError) {
  const el = document.getElementById("profileMsg");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "profile-msg" + (msg ? (isError ? " err" : " ok") : "");
}

function fillProfileForm() {
  if (!loggedInUser) return;
  const name = document.getElementById("profileName");
  const email = document.getElementById("profileEmail");
  const mobile = document.getElementById("profileMobile");
  if (name) name.value = loggedInUser.name || "";
  if (email) email.value = loggedInUser.email || "";
  if (mobile) {
    const uid = loggedInUser.uid || loggedInUser.email;
    mobile.value = localStorage.getItem(`${PROFILE_MOBILE_KEY}_${uid}`) || "";
  }
}

function getProfileUid() {
  return loggedInUser?.uid || window.mosAuth?.getCurrentUser()?.uid || loggedInUser?.email;
}

function updateBtChip(connected, name) {
  const chip = document.getElementById("btChip");
  if (!chip) return;
  if (connected && name) {
    const short = name.length > 14 ? name.slice(0, 12) + "…" : name;
    chip.textContent = `Bluetooth: ${short}`;
    chip.classList.add("on");
  } else {
    chip.textContent = "Bluetooth: Off";
    chip.classList.remove("on");
  }
}

function updateWifiChip(connected, name) {
  const chip = document.getElementById("wifiChip");
  if (!chip) return;
  if (connected && name) {
    const short = name.length > 14 ? name.slice(0, 12) + "…" : name;
    chip.textContent = `WiFi: ${short}`;
    chip.classList.add("on");
  } else {
    chip.textContent = "WiFi: Off";
    chip.classList.remove("on");
  }
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
  const text = (msg || "").trim();
  if (!text) {
    el.innerHTML = "";
    el.classList.remove("show");
    return;
  }
  el.classList.add("show");
  if (text.includes("Authentication is not enabled")) {
    el.innerHTML =
      text +
      '<br><a href="https://console.firebase.google.com/project/walkietalkie-mos/authentication" target="_blank" rel="noopener" style="color:var(--text);margin-top:8px;display:inline-block;">Open Firebase Authentication →</a>';
  } else {
    el.textContent = text;
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

function applyTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem(THEME_KEY, t);
  const meta = document.getElementById("metaThemeColor");
  if (meta) meta.content = t === "dark" ? "#1a1a1a" : "#f5f5f5";
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  applyTheme(saved === "light" ? "light" : "dark");
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(current === "dark" ? "light" : "dark");
}

function setBtStatus(connected, name) {
  const el = document.getElementById("btStatus");
  if (el) {
    if (connected && name) {
      el.textContent = `Connected — ${name}`;
      el.className = "conn-line connected";
    } else {
      el.textContent = "Not connected — tap a device below";
      el.className = "conn-line disconnected";
    }
  }
  updateBtChip(connected, name);
}

function setWifiStatus(connected, name) {
  const el = document.getElementById("wifiStatus");
  if (el) {
    if (connected && name) {
      el.textContent = `Selected — ${name}`;
      el.className = "conn-line connected";
    } else {
      el.textContent = "Not selected — tap a network below";
      el.className = "conn-line disconnected";
    }
  }
  updateWifiChip(connected, name);
}

function refreshStatusBar() {
  if (!loggedInUser || !isLoggedIn) return;
  const el = document.getElementById("statusMain");
  if (!el) return;
  const ch = getActiveChannelName();
  el.innerHTML = ch
    ? `${loggedInUser.name} · <span class="accent">${ch}</span>`
    : `${loggedInUser.name} · <span style="color:var(--text-faint)">Select a team in menu</span>`;
}

function enterApp(user) {
  isLoggedIn = true;
  loggedInUser = {
    uid: user.uid,
    name: user.name || user.displayName || (user.email || "").split("@")[0],
    email: user.email
  };
  loadChannels();
  loadFriends();
  loadBtDevices();
  loadSelectedWifi();
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("mainUI").style.display = "block";
  refreshStatusBar();
  renderChannels();
  updatePttHint();
  if (selectedWifiName) setWifiStatus(true, selectedWifiName);
  renderBluetoothList();
}

window.onFirebaseUser = function (firebaseUser) {
  if (!firebaseUser || isLoggedIn) return;
  enterApp({
    uid: firebaseUser.uid,
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
      uid: user.uid,
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
      uid: user.uid,
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
      '<div class="channel-empty">No teams yet.<br>Create one above.</div>';
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
      <button type="button" class="delete-btn" title="Delete channel" aria-label="Delete channel" onclick="deleteChannel(${ch.id}); event.stopImmediatePropagation();">🗑</button>
    `;

    div.onclick = (e) => {
      if (e.target.classList.contains("delete-btn")) return;
      currentChannel = ch.id;
      renderChannels();
      refreshStatusBar();
      updatePttHint();
      closeMenu();
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

function setBluetoothUi(connected, deviceName, deviceId) {
  if (connected && deviceId) selectedBtId = deviceId;
  if (!connected) {
    selectedBtId = null;
    bleDevice = null;
  }
  setBtStatus(connected, deviceName);
  renderBluetoothList();
}

async function disconnectBluetooth() {
  try {
    if (bleDevice?.gatt?.connected) bleDevice.gatt.disconnect();
  } catch {
    /* ignore */
  }
  bleDevice = null;
  selectedBtId = null;
  setBluetoothUi(false);
}

function renderBluetoothList() {
  const list = document.getElementById("btList");
  if (!list) return;

  if (!navigator.bluetooth) {
    list.innerHTML =
      '<div class="pick-item warn">Bluetooth needs Chrome, Edge, or Windows app.</div>';
    return;
  }

  let html = `<div class="pick-item add-row" data-bt-add="1">+ Add Bluetooth device</div>`;

  savedBtDevices.forEach((d) => {
    const active = selectedBtId === d.id && bleDevice ? " active" : "";
    const conn = selectedBtId === d.id && bleDevice ? " · connected" : "";
    html += `<div class="pick-item${active}" data-bt-id="1">${escapeHtml(d.name)}${conn}</div>`;
  });

  if (!savedBtDevices.length) {
    html += '<div class="pick-item warn">No devices yet. Tap + Add above.</div>';
  }

  list.innerHTML = html;

  list.querySelector("[data-bt-add]")?.addEventListener("click", () => addBluetoothDevice());
  const rows = list.querySelectorAll("[data-bt-id]");
  savedBtDevices.forEach((d, i) => {
    const el = rows[i];
    if (!el) return;
    el.addEventListener("click", () => {
      if (selectedBtId === d.id && bleDevice) disconnectBluetooth();
      else connectBluetoothDevice(d.id);
    });
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

async function addBluetoothDevice() {
  const list = document.getElementById("btList");
  if (!navigator.bluetooth) return;

  try {
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: ["battery_service", "device_information"]
    });
    const id = device.id || device.name || `bt-${Date.now()}`;
    const name = device.name || "Bluetooth device";
    if (!savedBtDevices.some((d) => d.id === id)) {
      savedBtDevices.push({ id, name });
      saveBtDevices();
    }
    await connectBluetoothDevice(id, device);
  } catch (err) {
    if (err?.name !== "NotFoundError" && list) {
      const warn = document.createElement("div");
      warn.className = "pick-item warn";
      warn.textContent = err.message || "Could not add device.";
      list.appendChild(warn);
    }
  }
}

async function connectBluetoothDevice(deviceId, knownDevice) {
  const saved = savedBtDevices.find((d) => d.id === deviceId);
  if (!saved && !knownDevice) return;

  const list = document.getElementById("btList");
  if (list) {
    const loading = document.createElement("div");
    loading.className = "pick-item warn";
    loading.id = "btLoading";
    loading.textContent = "Connecting…";
    list.appendChild(loading);
  }

  try {
    let device = knownDevice;
    if (!device) {
      if (!navigator.bluetooth) throw new Error("Bluetooth not supported");
      const filters = saved.name ? [{ name: saved.name }] : [];
      device = await navigator.bluetooth.requestDevice({
        filters: filters.length ? filters : undefined,
        acceptAllDevices: !filters.length,
        optionalServices: ["battery_service", "device_information"]
      });
    }

    bleDevice = device;
    device.addEventListener("gattserverdisconnected", () => {
      setBluetoothUi(false);
    });

    if (device.gatt) await device.gatt.connect();

    const name = device.name || saved?.name || "Bluetooth device";
    const id = device.id || deviceId;
    if (!savedBtDevices.some((d) => d.id === id)) {
      savedBtDevices.push({ id, name });
      saveBtDevices();
    }
    document.getElementById("btLoading")?.remove();
    setBluetoothUi(true, name, id);
  } catch (err) {
    document.getElementById("btLoading")?.remove();
    if (err?.name !== "NotFoundError") {
      setBtStatus(false);
      alert(err.message || "Bluetooth connection failed.");
    }
    renderBluetoothList();
  }
}

function getNetworkHint() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return "Network: WiFi or mobile data";
  const types = { wifi: "WiFi", cellular: "Mobile data", ethernet: "Ethernet", none: "Offline" };
  const t = types[conn.type] || conn.type || "Unknown";
  return `Network: ${t}${conn.effectiveType ? ` (${conn.effectiveType})` : ""}`;
}

function selectWifiNetwork(name) {
  if (selectedWifiName === name) {
    selectedWifiName = null;
    localStorage.removeItem(WIFI_SEL_KEY);
    setWifiStatus(false);
  } else {
    selectedWifiName = name;
    localStorage.setItem(WIFI_SEL_KEY, name);
    wifiConnectedName = name;
    setWifiStatus(true, name);
  }
  renderWifiList(lastWifiScanNetworks, lastWifiConnected);
}

let lastWifiScanNetworks = [];
let lastWifiConnected = "";

function renderWifiList(networks, connectedSsid) {
  const list = document.getElementById("wifiList");
  if (!list) return;

  if (!networks.length) {
    list.innerHTML =
      '<div class="pick-item warn">No networks found. Use Windows app for full scan, or join WiFi in phone settings.</div>';
    return;
  }

  let html = "";
  if (connectedSsid) {
    const active = selectedWifiName === connectedSsid ? " active" : "";
    html += `<div class="pick-item${active}" data-wifi="${escapeHtml(connectedSsid)}">${escapeHtml(connectedSsid)} (connected)</div>`;
  }

  networks.forEach((n) => {
    if (n === connectedSsid) return;
    const active = selectedWifiName === n ? " active" : "";
    html += `<div class="pick-item${active}" data-wifi="${escapeHtml(n)}">${escapeHtml(n)}</div>`;
  });

  list.innerHTML = html;
  list.querySelectorAll("[data-wifi]").forEach((el) => {
    el.addEventListener("click", () => selectWifiNetwork(el.getAttribute("data-wifi")));
  });
}

async function refreshWifiList() {
  const list = document.getElementById("wifiList");
  if (!list) return;
  list.innerHTML = '<div class="pick-item warn">Scanning…</div>';

  const channelName = getActiveChannelName() || "your team";

  if (window.windowsAPI?.scanWifiNetworks) {
    try {
      const result = await window.windowsAPI.scanWifiNetworks();
      if (result.ok && result.networks.length) {
        lastWifiScanNetworks = result.networks;
        lastWifiConnected = result.connected || "";
        renderWifiList(result.networks, result.connected);
        if (result.connected && !selectedWifiName) {
          selectWifiNetwork(result.connected);
        }
        return;
      }
      list.innerHTML = `<div class="pick-item warn">${result.message || "No networks found."}</div>`;
      return;
    } catch (err) {
      list.innerHTML = `<div class="pick-item warn">${escapeHtml(err.message)}</div>`;
      return;
    }
  }

  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const onWifi = conn?.type === "wifi";
  const hint = getNetworkHint();
  lastWifiScanNetworks = onWifi ? ["Current WiFi (browser)"] : [];
  lastWifiConnected = onWifi ? "Current WiFi (browser)" : "";

  list.innerHTML = `
    <div class="pick-item warn">${escapeHtml(hint)}</div>
    <div class="pick-item${selectedWifiName === "team-wifi" ? " active" : ""}" data-wifi="team-wifi">Same WiFi as team (tap to select)</div>
    <div class="pick-item warn">Team channel: ${escapeHtml(channelName)}. Full list: Windows app.</div>
  `;
  list.querySelectorAll("[data-wifi]").forEach((el) => {
    el.addEventListener("click", () => selectWifiNetwork(el.getAttribute("data-wifi")));
  });
}

async function saveProfileName() {
  const name = document.getElementById("profileName")?.value.trim();
  if (!name) return setProfileMsg("Enter your name.", true);
  try {
    await window.mosAuth.updateDisplayName(name);
    loggedInUser.name = name;
    refreshStatusBar();
    setProfileMsg("Name updated.");
  } catch (err) {
    setProfileMsg(window.mosAuth.mapError(err), true);
  }
}

async function saveProfileEmail() {
  const email = document.getElementById("profileEmail")?.value.trim().toLowerCase();
  const pass = document.getElementById("profileCurrentPass")?.value;
  if (!email || !isValidEmail(email)) return setProfileMsg("Enter a valid email.", true);
  if (!pass) return setProfileMsg("Enter current password to change email.", true);
  try {
    await window.mosAuth.changeEmail(email, pass);
    loggedInUser.email = email;
    refreshStatusBar();
    setProfileMsg("Email updated.");
  } catch (err) {
    setProfileMsg(window.mosAuth.mapError(err), true);
  }
}

async function saveProfileMobile() {
  const mobile = document.getElementById("profileMobile")?.value.trim();
  const uid = getProfileUid();
  if (!mobile) return setProfileMsg("Enter mobile number.", true);
  localStorage.setItem(`${PROFILE_MOBILE_KEY}_${uid}`, mobile);
  setProfileMsg("Mobile number saved.");
}

async function saveProfilePassword() {
  const cur = document.getElementById("profileCurrentPass")?.value;
  const neu = document.getElementById("profileNewPass")?.value;
  if (!cur) return setProfileMsg("Enter current password.", true);
  if (!neu || neu.length < 6) return setProfileMsg("New password min 6 characters.", true);
  try {
    await window.mosAuth.changePassword(cur, neu);
    document.getElementById("profileCurrentPass").value = "";
    document.getElementById("profileNewPass").value = "";
    setProfileMsg("Password changed.");
  } catch (err) {
    setProfileMsg(window.mosAuth.mapError(err), true);
  }
}

function setPttVisual(talking) {
  const orb = document.getElementById("pttBtn");
  const label = document.getElementById("pttLabel");
  if (!orb) return;
  orb.classList.toggle("talking", talking);
  if (label) label.textContent = talking ? "Transmitting…" : "Hold to talk";
}

function startTalk(e) {
  if (e?.cancelable) e.preventDefault();
  if (!getActiveChannelName()) {
    openMenu();
    return;
  }
  isTalking = true;
  setPttVisual(true);
  const ch = getActiveChannelName();
  const el = document.getElementById("statusMain");
  if (el) el.innerHTML = `<span class="accent">Live · ${ch}</span>`;
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
  closeMenu();
  setBluetoothMenuOpen(false);
  setWifiMenuOpen(false);
  profilePanelOpen = false;
  friendPanelOpen = false;
  teamPanelOpen = false;
  ["btnProfileAction", "btnFriendAction", "btnBluetoothMenu", "btnWifiMenu", "btnTeamAction"].forEach((id) => {
    document.getElementById(id)?.classList.remove("selected");
  });
  ["profilePanel", "friendPanel", "teamPanel"].forEach((id) => {
    document.getElementById(id)?.classList.remove("open");
  });
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
  initTheme();
  loadChannels();
  loadFriends();
  loadBtDevices();
  loadSelectedWifi();
  setBtStatus(false);
  setWifiStatus(false);
  if (!window.mosAuth?.isConfigured()) {
    setAuthError("Add Firebase keys in firebase-config.js to enable real login.");
  }
  if (window.windowsAPI?.isDesktop && !isLoggedIn) {
    const brand = document.querySelector(".login-brand");
    if (brand) brand.textContent = "Walkie Talkie · Windows";
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === " " && isLoggedIn) {
      e.preventDefault();
      startTalk();
    }
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === " " && isLoggedIn) stopTalk();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
}

Object.assign(window, {
  toggleTheme,
  openMenu,
  closeMenu,
  toggleBluetoothMenu,
  toggleWifiMenu,
  toggleTeamPanel,
  toggleFriendPanel,
  toggleProfilePanel,
  addFriend,
  removeFriend,
  refreshWifiList,
  saveProfileName,
  saveProfileEmail,
  saveProfileMobile,
  saveProfilePassword,
  showAuthTab,
  login,
  loginWithGoogle,
  signupWithGoogle,
  signup,
  disconnectBluetooth,
  startTalk,
  stopTalk,
  logout,
  addNewChannel,
  deleteChannel
});

if (window.mosAuth) boot();
else window.addEventListener("mosAuthReady", boot, { once: true });