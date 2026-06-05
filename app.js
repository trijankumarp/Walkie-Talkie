import {
  collection,
  query,
  where,
  getDocs,
  setDoc,
  doc,
  serverTimestamp,
  limit
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { ref, set, onValue, off } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js";

const CHANNELS_KEY = "walkie_channels_v1";
const PUBLIC_CHANNELS_COLLECTION = "publicChannels";
const CHANNEL_STALE_MS = 5 * 60 * 1000;
const THEME_KEY = "walkie_theme_v1";
const BT_DEVICES_KEY = "walkie_bt_devices_v1";
const WIFI_SEL_KEY = "walkie_wifi_selected_v1";
const PROFILE_MOBILE_KEY = "walkie_profile_mobile_v1";
const PROFILE_NAMES_KEY = "walkie_profile_names_v1";
const PROFILE_AVATAR_KEY = "walkie_avatar_v1";
const PROFILE_COUNTRY_KEY = "walkie_country_v1";
const PROFILE_EXTRA_KEY = "walkie_profile_extra_v1";
const PASSWORD_CHANGED_KEY = "walkie_password_changed_v1";
const BIOMETRIC_KEY = "walkie_biometric_v1";
const FRIENDS_KEY = "walkie_friends_v1";

const GENDER_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "other", label: "Other" },
  { value: "prefer_not", label: "Prefer not to say" }
];

const LANGUAGE_OPTIONS = [
  "English",
  "Hindi",
  "Telugu",
  "Tamil",
  "Kannada",
  "Malayalam",
  "Bengali",
  "Marathi",
  "Gujarati",
  "Punjabi",
  "Urdu"
];

let settingsEditorKey = null;

const COUNTRY_CODES = [
  { code: "+91", label: "IN +91", country: "India" },
  { code: "+1", label: "US +1", country: "United States" },
  { code: "+44", label: "UK +44", country: "United Kingdom" },
  { code: "+971", label: "AE +971", country: "UAE" },
  { code: "+61", label: "AU +61", country: "Australia" },
  { code: "+65", label: "SG +65", country: "Singapore" },
  { code: "+81", label: "JP +81", country: "Japan" },
  { code: "+86", label: "CN +86", country: "China" },
  { code: "+49", label: "DE +49", country: "Germany" },
  { code: "+33", label: "FR +33", country: "France" },
  { code: "+92", label: "PK +92", country: "Pakistan" },
  { code: "+880", label: "BD +880", country: "Bangladesh" },
  { code: "+94", label: "LK +94", country: "Sri Lanka" },
  { code: "+977", label: "NP +977", country: "Nepal" }
];

const AVATAR_EMOJIS = ["😀", "🎙", "📻", "🔊", "👤", "🦊", "🐻", "🐼", "🦁", "🐯", "🐸", "🐵", "🐶", "🐱", "🌟", "⚡", "🔥", "💎", "🎯", "🚀", "🎧", "📡", "🛡", "✨"];

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
let settingsPanelOpen = false;
let friendPanelOpen = false;
let channelPanelOpen = false;
let friends = [];
let selectedBtId = null;
let savedBtDevices = [];
let nearbyChannels = [];
let nearbyLoading = false;
let nearbySearchError = "";
let nearbyRefreshTimer = null;
let channelHeartbeatTimer = null;
let channelSyncBackend = null;
let nearbyRtdbRef = null;
let channelShareOk = false;

function generateChannelId() {
  return `CH-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function generateChannelFrequency() {
  const base = 462.5625;
  const step = 0.0125;
  const slot = Math.floor(Math.random() * 14);
  return (base + slot * step).toFixed(4);
}

function normalizeChannelRecord(ch) {
  return {
    id: ch.id,
    name: (ch.name || "Channel").trim(),
    channelId: ch.channelId || generateChannelId(),
    frequency: String(ch.frequency || ch.freq || generateChannelFrequency())
  };
}

function migrateChannels() {
  let changed = false;
  channels = channels.map((ch) => {
    const next = normalizeChannelRecord(ch);
    if (next.channelId !== ch.channelId || next.frequency !== ch.frequency) changed = true;
    return next;
  });
  if (changed) saveChannels();
}

function loadChannels() {
  try {
    const raw = localStorage.getItem(CHANNELS_KEY);
    channels = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(channels)) channels = [];
  } catch {
    channels = [];
  }
  migrateChannels();
}

function getChannelMetaLine(ch) {
  if (!ch) return "";
  const freq = ch.frequency ? `${ch.frequency} MHz` : "";
  const uid = ch.channelId || "";
  if (freq && uid) return `${freq} · ${uid}`;
  return freq || uid;
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

function getActiveChannelTalkLabel() {
  const ch = getActiveChannel();
  if (!ch) return null;
  const meta = getChannelMetaLine(ch);
  return meta ? `${ch.name} · ${meta}` : ch.name;
}

function updatePttHint() {
  const hint = document.getElementById("pttHint");
  if (!hint) return;
  const label = getActiveChannelTalkLabel();
  hint.textContent = label
    ? `Hold to talk on ${label}`
    : "Open menu (top left) to select or create a channel";
}

function openMenu() {
  document.getElementById("menuOverlay")?.classList.add("open");
  document.getElementById("sideMenu")?.classList.add("open");
  if (isLoggedIn) updateMenuAvatar();
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
    if (!selectedWifiName) ensureWifiForDiscovery();
    refreshWifiList();
  } else {
    setWifiMenuOpen(false);
  }
}

function toggleChannelPanel() {
  channelPanelOpen = !channelPanelOpen;
  document.getElementById("btnChannelAction")?.classList.toggle("selected", channelPanelOpen);
  document.getElementById("channelPanel")?.classList.toggle("open", channelPanelOpen);
  if (channelPanelOpen) {
    renderChannels();
    refreshNearbyChannels();
    requestAnimationFrame(() => document.getElementById("channelSearch")?.focus());
  }
}

function toggleTeamPanel() {
  toggleChannelPanel();
}

function toggleFriendPanel() {
  friendPanelOpen = !friendPanelOpen;
  document.getElementById("btnFriendAction")?.classList.toggle("selected", friendPanelOpen);
  document.getElementById("friendPanel")?.classList.toggle("open", friendPanelOpen);
  if (friendPanelOpen) renderFriends();
}

function toggleSettingsPanel() {
  settingsPanelOpen = !settingsPanelOpen;
  document.getElementById("btnSettingsAction")?.classList.toggle("selected", settingsPanelOpen);
  document.getElementById("settingsPanel")?.classList.toggle("open", settingsPanelOpen);
  if (settingsPanelOpen) {
    closeSettingsEditor();
    renderSettingsList();
  }
}

function loadProfileExtra(uid) {
  if (!uid) return {};
  try {
    const raw = localStorage.getItem(`${PROFILE_EXTRA_KEY}_${uid}`);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveProfileExtra(uid, patch) {
  if (!uid) return;
  const cur = loadProfileExtra(uid);
  localStorage.setItem(`${PROFILE_EXTRA_KEY}_${uid}`, JSON.stringify({ ...cur, ...patch }));
  renderSettingsList();
}

function formatPasswordChanged(iso) {
  if (!iso) return "Change password";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "Change password";
    return `Last changed ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  } catch {
    return "Change password";
  }
}

function getMobileDisplay(uid) {
  const raw = localStorage.getItem(`${PROFILE_MOBILE_KEY}_${uid}`);
  let parsed = { country: "+91", number: "", verified: false };
  try {
    if (raw?.startsWith("{")) parsed = { ...parsed, ...JSON.parse(raw) };
    else if (raw) parsed.number = raw;
  } catch {
    if (raw) parsed.number = raw;
  }
  const savedCountry = localStorage.getItem(`${PROFILE_COUNTRY_KEY}_${uid}`);
  if (savedCountry) parsed.country = savedCountry;
  if (!parsed.number) return null;
  return `${parsed.country} ${parsed.number}`;
}

function renderSettingsList() {
  if (!loggedInUser) return;
  const uid = getProfileUid();
  const extra = loadProfileExtra(uid);
  const names = loadUserNames(uid);
  let firstName = names.firstName;
  let lastName = names.lastName;
  if (!firstName && !lastName && loggedInUser.name) {
    const parsed = parseNameParts(loggedInUser.name);
    firstName = parsed.firstName;
    lastName = parsed.lastName;
  }
  const fullName =
    `${(firstName || "").trim()} ${(lastName || "").trim()}`.trim().replace(/\s+/g, " ") ||
    loggedInUser.name ||
    "Not set";

  syncAllProfileAvatars();

  const setVal = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text || "Not set";
  };

  setVal("settingsNameValue", fullName === "Not set" ? "Not set" : fullName);

  const genderOpt = GENDER_OPTIONS.find((g) => g.value === (extra.gender || ""));
  setVal("settingsGenderValue", genderOpt?.label || "Not set");

  const emailEl = document.getElementById("settingsEmailValue");
  if (emailEl) {
    const email = loggedInUser.email || "—";
    const verified =
      loggedInUser.emailVerified ?? window.mosAuth?.isEmailVerified?.() ?? false;
    emailEl.innerHTML = verified
      ? `${escapeHtml(email)} <span class="verified-inline">✓</span>`
      : escapeHtml(email);
  }

  const phone = getMobileDisplay(uid);
  setVal("settingsPhoneValue", phone || "Not set");

  setVal(
    "settingsBirthdayValue",
    extra.birthday
      ? new Date(extra.birthday + "T12:00:00").toLocaleDateString(undefined, {
          month: "long",
          day: "numeric",
          year: "numeric"
        })
      : "Not set"
  );

  setVal("settingsLanguageValue", extra.language || "English");

  const userId = getUserId(uid) || suggestUserIdFromEmail(loggedInUser.email);
  setVal("settingsUserIdValue", userId ? `@${userId}` : "Not set");

  const pwdChanged = localStorage.getItem(`${PASSWORD_CHANGED_KEY}_${uid}`);
  setVal("settingsPasswordValue", formatPasswordChanged(pwdChanged));

  const permEl = document.getElementById("settingsPermValue");
  if (permEl) permEl.textContent = "Tap to manage";

  const bioOn = localStorage.getItem(`${BIOMETRIC_KEY}_${uid}`) === "1";
  setVal("settingsBioValue", bioOn ? "On" : "Off");
}

function normalizeNameFields(firstName, lastName) {
  const collapse = (s) => (s || "").trim().replace(/\s+/g, " ");
  return {
    firstName: collapse(firstName),
    lastName: collapse(lastName)
  };
}

function validateFirstName(firstName) {
  if (!(firstName || "").trim()) return "Please enter first name.";
  return null;
}

function normalizeUserId(raw) {
  return (raw || "").trim().toLowerCase().replace(/\s+/g, "");
}

function validateUserId(userId) {
  const id = normalizeUserId(userId);
  if (!id) return "Please enter user ID.";
  if (!/^[a-z0-9._]{3,24}$/.test(id)) {
    return "User ID: 3–24 characters, letters, numbers, . or _ only.";
  }
  return null;
}

function getUserId(uid) {
  return loadProfileExtra(uid).userId || "";
}

function suggestUserIdFromEmail(email) {
  const local = (email || "").split("@")[0] || "";
  return normalizeUserId(local.replace(/[^a-z0-9._]/gi, "")).slice(0, 24);
}

function isSpaceKey(e) {
  return e.key === " " || e.code === "Space" || e.key === "Spacebar";
}

function getSettingsExpandEl(key) {
  let expand = document.getElementById(`settingsExpand-${key}`);
  if (expand) return expand;
  const row = document.querySelector(`.settings-row[data-settings-key="${key}"]`);
  if (!row) return null;
  expand = document.createElement("div");
  expand.className = "settings-row-expand";
  expand.id = `settingsExpand-${key}`;
  expand.setAttribute("aria-hidden", "true");
  row.insertAdjacentElement("afterend", expand);
  return expand;
}

function closeAllSettingsExpands() {
  settingsEditorKey = null;
  document.querySelectorAll(".settings-row-expand.open").forEach((el) => {
    el.classList.remove("open");
    el.innerHTML = "";
    el.setAttribute("aria-hidden", "true");
  });
  document.querySelectorAll(".settings-row.expanded").forEach((r) => r.classList.remove("expanded"));
  const grid = document.getElementById("emojiGrid");
  const panel = document.getElementById("settingsPanel");
  if (grid && panel && !panel.contains(grid)) {
    panel.appendChild(grid);
    grid.style.display = "none";
  }
}

function closeSettingsEditor() {
  closeAllSettingsExpands();
}

function toggleSettingsEditor(key) {
  const expand = getSettingsExpandEl(key);
  if (!expand) return;
  const row = document.querySelector(`.settings-row[data-settings-key="${key}"]`);
  const wasOpen = expand.classList.contains("open");
  closeAllSettingsExpands();
  if (wasOpen) return;

  settingsEditorKey = key;
  expand.innerHTML = buildSettingsEditorHtml(key);
  expand.classList.add("open");
  expand.setAttribute("aria-hidden", "false");
  row?.classList.add("expanded");

  fillProfileForm();
  if (key === "delete") setupDeleteAccountEditor();
  if (key === "permissions") renderAppPermissions();
  if (key === "photo") {
    const grid = document.getElementById("emojiGrid");
    const mount = document.getElementById("emojiGridMount");
    if (grid && mount) {
      mount.appendChild(grid);
      grid.style.display = "none";
    }
    syncAllProfileAvatars();
  }
  requestAnimationFrame(() => {
    expand.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function buildSettingsEditorHtml(key) {
  const uid = getProfileUid();
  const extra = loadProfileExtra(uid);
  const genderOpts = GENDER_OPTIONS.map(
    (g) =>
      `<option value="${g.value}"${extra.gender === g.value ? " selected" : ""}>${g.label}</option>`
  ).join("");
  const langOpts = LANGUAGE_OPTIONS.map(
    (l) => `<option${(extra.language || "English") === l ? " selected" : ""}>${l}</option>`
  ).join("");

  const editors = {
    photo: `
      <div class="profile-avatar-row" style="justify-content:center;margin-bottom:16px;">
        <div class="profile-avatar profile-avatar--lg" id="settingsAvatarPreview">?</div>
      </div>
      <div class="action-grid" style="grid-template-columns:repeat(3,1fr);">
        <button type="button" class="action-btn" onclick="pickAvatarGallery()">
          <span class="action-circle"><svg viewBox="0 0 24 24" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg></span>
          Gallery
        </button>
        <button type="button" class="action-btn" onclick="pickAvatarCamera()">
          <span class="action-circle"><svg viewBox="0 0 24 24" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></span>
          Camera
        </button>
        <button type="button" class="action-btn" onclick="toggleEmojiPicker()">
          <span class="action-circle"><svg viewBox="0 0 24 24" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/></svg></span>
          Emoji
        </button>
      </div>
      <p class="profile-hint">Choose a photo, take one, or pick an emoji.</p>
      <div id="emojiGridMount"></div>`,
    userid: `
      <label class="profile-label">User ID</label>
      <input type="text" id="profileUserId" class="profile-input" placeholder="e.g. trijan_kumar" autocomplete="username" autocapitalize="off" value="${escapeHtml(extra.userId || "")}">
      <p class="profile-hint">3–24 characters: letters, numbers, dot, underscore. Shown as @userid.</p>
      <button type="button" class="btn btn-sm" onclick="saveProfileUserId()">Save</button>`,
    name: `
      <div class="name-edit-panel">
        <label class="profile-label">First name</label>
        <input type="text" id="profileFirstName" class="profile-input" placeholder="First name (e.g. Trijan Kumar)" autocomplete="given-name">
        <label class="profile-label">Last name</label>
        <input type="text" id="profileLastName" class="profile-input" placeholder="Last name (e.g. Puvvada)" autocomplete="family-name">
        <div class="name-visibility">
          <p class="name-visibility-title">Who can see your name</p>
          <p class="name-visibility-text">Anyone you connect with on Walkie Talkie can see this name.</p>
        </div>
        <div class="name-edit-actions">
          <button type="button" class="btn-text" onclick="cancelNameEdit()">Cancel</button>
          <button type="button" class="btn btn-sm name-save-btn" onclick="saveProfileName()">Save</button>
        </div>
      </div>`,
    gender: `
      <label class="profile-label">Gender</label>
      <select id="profileGender" class="profile-input">${genderOpts}</select>
      <button type="button" class="btn btn-sm" onclick="saveProfileGender()">Save</button>`,
    email: `
      <p class="profile-hint">Current: <strong id="profileEmailDisplay">—</strong>
        <span id="emailVerifiedBadge" class="verified-badge" title="Verification">✓</span>
      </p>
      <button type="button" class="btn btn-sm btn-outline" id="btnResendVerify" onclick="resendEmailVerification()" style="margin-bottom:10px;">Resend verification email</button>
      <label class="profile-label">New email</label>
      <input type="email" id="profileEmail" class="profile-input" placeholder="new@email.com" autocomplete="email">
      <label class="profile-label">Current password</label>
      <input type="password" id="profileCurrentPass" class="profile-input" placeholder="Required to change email" autocomplete="current-password">
      <button type="button" class="btn btn-sm" onclick="sendEmailChangeOtp()">Send code to new email</button>
      <div id="emailOtpBox" class="otp-box">
        <label class="profile-label">6-digit code</label>
        <input type="text" id="profileEmailOtp" class="profile-input" inputmode="numeric" maxlength="6" placeholder="000000">
        <button type="button" class="btn btn-sm" onclick="confirmEmailChange()">Verify &amp; update email</button>
      </div>`,
    phone: `
      <label class="profile-label">Country</label>
      <select id="profileCountry" class="profile-input"></select>
      <label class="profile-label">Mobile number</label>
      <input type="tel" id="profileMobile" class="profile-input" placeholder="Phone number" inputmode="tel" autocomplete="tel">
      <label class="profile-label">Current password</label>
      <input type="password" id="profileCurrentPass" class="profile-input" placeholder="Required to change phone" autocomplete="current-password">
      <button type="button" class="btn btn-sm" onclick="sendMobileChangeOtp()">Send OTP</button>
      <div id="mobileOtpBox" class="otp-box">
        <label class="profile-label">6-digit OTP</label>
        <input type="text" id="profileMobileOtp" class="profile-input" inputmode="numeric" maxlength="6" placeholder="000000">
        <button type="button" class="btn btn-sm" onclick="confirmMobileChange()">Verify &amp; save phone</button>
      </div>`,
    birthday: `
      <label class="profile-label">Birthday</label>
      <input type="date" id="profileBirthday" class="profile-input" value="${extra.birthday || ""}">
      <button type="button" class="btn btn-sm" onclick="saveProfileBirthday()">Save</button>`,
    language: `
      <label class="profile-label">Language</label>
      <select id="profileLanguage" class="profile-input">${langOpts}</select>
      <button type="button" class="btn btn-sm" onclick="saveProfileLanguage()">Save</button>`,
    password: `
      <p class="profile-hint">${escapeHtml(formatPasswordChanged(localStorage.getItem(`${PASSWORD_CHANGED_KEY}_${uid}`)))}</p>
      <label class="profile-label">Current password</label>
      <input type="password" id="profileCurrentPass" class="profile-input" autocomplete="current-password">
      <label class="profile-label">New password</label>
      <input type="password" id="profileNewPass" class="profile-input" autocomplete="new-password" minlength="6">
      <button type="button" class="btn btn-sm" onclick="saveProfilePassword()">Change password</button>`,
    permissions: `<div class="perm-list" id="permissionsList"></div>
      <button type="button" class="btn btn-sm btn-outline" onclick="refreshAppPermissions()">Refresh status</button>`,
    biometric: `
      <label class="profile-check">
        <input type="checkbox" id="profileBiometric" onchange="onBiometricToggle(this.checked)">
        Use fingerprint / face on this device
      </label>
      <button type="button" class="btn btn-sm" onclick="setupBiometric()">Set up biometric</button>`,
    delete: `
      <p class="delete-account-warn">This permanently deletes your account and profile. This cannot be undone.</p>
      <div id="deleteAccountPassWrap">
        <label class="profile-label">Password</label>
        <input type="password" id="deleteAccountPass" class="profile-input" placeholder="Enter password to confirm" autocomplete="current-password">
      </div>
      <p class="profile-hint" id="deleteAccountGoogleHint" style="display:none;">You will confirm with Google in the next step.</p>
      <div class="name-edit-actions">
        <button type="button" class="btn-text" onclick="closeSettingsEditor()">Cancel</button>
        <button type="button" class="btn btn-sm btn-danger" onclick="confirmDeleteAccount()">Delete account</button>
      </div>`
  };
  return editors[key] || "<p class=\"profile-hint\">Not available.</p>";
}

function pickAvatarGallery() {
  document.getElementById("avatarGalleryInput")?.click();
}

function pickAvatarCamera() {
  document.getElementById("avatarCameraInput")?.click();
}

function toggleEmojiPicker() {
  const grid = document.getElementById("emojiGrid");
  if (!grid) return;
  const show = grid.style.display !== "grid";
  grid.style.display = show ? "grid" : "none";
  if (show) grid.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function saveProfileGender() {
  const val = document.getElementById("profileGender")?.value || "";
  saveProfileExtra(getProfileUid(), { gender: val });
  setProfileMsg("Gender saved.");
  closeSettingsEditor();
}

function saveProfileBirthday() {
  const val = document.getElementById("profileBirthday")?.value || "";
  saveProfileExtra(getProfileUid(), { birthday: val });
  setProfileMsg(val ? "Birthday saved." : "Birthday cleared.");
  closeSettingsEditor();
}

function saveProfileLanguage() {
  const val = document.getElementById("profileLanguage")?.value || "English";
  saveProfileExtra(getProfileUid(), { language: val });
  setProfileMsg("Language saved.");
  closeSettingsEditor();
}

function saveProfileUserId() {
  const raw = document.getElementById("profileUserId")?.value || "";
  const userId = normalizeUserId(raw);
  const err = validateUserId(userId);
  if (err) return setProfileMsg(err, true);
  saveProfileExtra(getProfileUid(), { userId });
  setProfileMsg("User ID saved.");
  closeSettingsEditor();
}

function getInitials(name) {
  if (!name) return "?";
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function getStoredAvatar() {
  const uid = getProfileUid();
  if (!uid) return null;
  return localStorage.getItem(`${PROFILE_AVATAR_KEY}_${uid}`);
}

function applyAvatarToElement(el, avatar, name) {
  if (!el) return;
  el.style.backgroundImage = "";
  el.classList.remove("emoji", "has-photo");
  if (avatar?.startsWith("emoji:")) {
    el.textContent = avatar.slice(6);
    el.classList.add("emoji");
  } else if (avatar?.startsWith("data:image")) {
    el.style.backgroundImage = `url(${avatar})`;
    el.textContent = "";
    el.classList.add("has-photo");
  } else {
    el.textContent = getInitials(name);
  }
}

function syncAllProfileAvatars() {
  const av = getStoredAvatar();
  const name = getFullName(loggedInUser) || "User";
  ["menuAvatar", "settingsListAvatar", "settingsAvatarPreview"].forEach((id) => {
    applyAvatarToElement(document.getElementById(id), av, name);
  });
}

function updateMenuAvatar() {
  syncAllProfileAvatars();
  const nameEl = document.getElementById("menuUserName");
  if (nameEl) nameEl.textContent = getFullName(loggedInUser) || "User";
}

function saveAvatar(data) {
  const uid = getProfileUid();
  if (!uid) return;
  localStorage.setItem(`${PROFILE_AVATAR_KEY}_${uid}`, data);
  updateMenuAvatar();
  renderSettingsList();
}

function resizeImageFile(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    img.src = url;
  });
}

function initAvatarPickers() {
  const grid = document.getElementById("emojiGrid");
  if (grid && !grid.childElementCount) {
    AVATAR_EMOJIS.forEach((em) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "emoji-pick";
      b.textContent = em;
      b.onclick = () => {
        saveAvatar(`emoji:${em}`);
        setProfileMsg("Profile picture updated.");
      };
      grid.appendChild(b);
    });
  }

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await resizeImageFile(file, 256, 0.82);
      saveAvatar(dataUrl);
      setProfileMsg("Photo saved.");
    } catch {
      setProfileMsg("Could not load image.", true);
    }
  };

  document.getElementById("avatarGalleryInput")?.addEventListener("change", onFile);
  document.getElementById("avatarCameraInput")?.addEventListener("change", onFile);
}

function fillCountrySelect(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel || sel.options.length) return;
  COUNTRY_CODES.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.code;
    opt.textContent = c.label;
    opt.title = c.country;
    sel.appendChild(opt);
  });
}

function initCountrySelect() {
  fillCountrySelect("profileCountry");
  fillCountrySelect("signupCountry");
}

function initSignupFields() {
  const genderSel = document.getElementById("signupGender");
  if (genderSel && !genderSel.options.length) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select gender";
    genderSel.appendChild(placeholder);
    GENDER_OPTIONS.filter((g) => g.value).forEach((g) => {
      const opt = document.createElement("option");
      opt.value = g.value;
      opt.textContent = g.label;
      genderSel.appendChild(opt);
    });
  }
}

function saveUserNames(uid, firstName, lastName) {
  localStorage.setItem(
    `${PROFILE_NAMES_KEY}_${uid}`,
    JSON.stringify({ firstName, lastName, accountType: "individual" })
  );
}

function loadUserNames(uid) {
  try {
    const raw = localStorage.getItem(`${PROFILE_NAMES_KEY}_${uid}`);
    if (raw) {
      const data = JSON.parse(raw);
      return {
        firstName: data.firstName || "",
        lastName: data.lastName || "",
        accountType: data.accountType || "individual"
      };
    }
  } catch {
    /* ignore */
  }
  return { firstName: "", lastName: "", accountType: "individual" };
}

function parseNameParts(displayName) {
  const parts = (displayName || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function getFullName(user) {
  if (!user) return "";
  const names = loadUserNames(user.uid);
  const full = `${names.firstName} ${names.lastName}`.trim();
  if (full) return full;
  return user.name || "";
}

function saveMobileProfile(uid, country, number, verified = false) {
  localStorage.setItem(
    `${PROFILE_MOBILE_KEY}_${uid}`,
    JSON.stringify({ country, number, verified })
  );
  localStorage.setItem(`${PROFILE_COUNTRY_KEY}_${uid}`, country);
}

function updateEmailVerifiedBadge() {
  const badge = document.getElementById("emailVerifiedBadge");
  const display = document.getElementById("profileEmailDisplay");
  const resendBtn = document.getElementById("btnResendVerify");
  if (display && loggedInUser?.email) display.textContent = loggedInUser.email;
  const verified =
    loggedInUser?.emailVerified ?? window.mosAuth?.isEmailVerified?.() ?? false;
  if (loggedInUser) loggedInUser.emailVerified = verified;
  if (!badge) return;
  if (verified) {
    badge.classList.remove("no");
    badge.title = "Email verified";
    if (resendBtn) resendBtn.style.display = "none";
  } else {
    badge.classList.add("no");
    badge.title = "Email not verified — check inbox";
    if (resendBtn) resendBtn.style.display = "block";
  }
}

async function resendEmailVerification() {
  try {
    await window.mosAuth.sendUserEmailVerification();
    setProfileMsg("Verification email sent. Check inbox.");
  } catch (err) {
    setProfileMsg(window.mosAuth.mapError(err), true);
  }
}

const APP_PERMISSIONS = [
  { id: "mic", label: "Microphone", key: "microphone", forPTT: true },
  { id: "cam", label: "Camera", key: "camera" },
  { id: "notif", label: "Notifications", key: "notifications" },
  { id: "bt", label: "Bluetooth", key: "bluetooth" }
];

async function queryPermissionState(key) {
  if (key === "notifications") {
    return Notification.permission || "default";
  }
  if (!navigator.permissions?.query) {
    if (key === "bluetooth") return navigator.bluetooth ? "prompt" : "unsupported";
    return "unsupported";
  }
  try {
    const status = await navigator.permissions.query({ name: key });
    return status.state;
  } catch {
    if (key === "bluetooth") return navigator.bluetooth ? "prompt" : "unsupported";
    return "unsupported";
  }
}

async function requestAppPermission(key) {
  if (key === "notifications") {
    if (!("Notification" in window)) return "unsupported";
    return await Notification.requestPermission();
  }
  if (key === "microphone") {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return "granted";
    } catch {
      return "denied";
    }
  }
  if (key === "camera") {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((t) => t.stop());
      return "granted";
    } catch {
      return "denied";
    }
  }
  if (key === "bluetooth") {
    return navigator.bluetooth ? "prompt" : "unsupported";
  }
  return "unsupported";
}

async function renderAppPermissions() {
  const list = document.getElementById("permissionsList");
  if (!list) return;
  list.innerHTML = "";

  for (const perm of APP_PERMISSIONS) {
    const state = await queryPermissionState(perm.key);
    const row = document.createElement("div");
    row.className = "perm-row";
    const granted = state === "granted" || state === "prompt";
    row.innerHTML = `
      <span>${perm.label}</span>
      <span class="perm-status${granted ? " granted" : ""}">${state}</span>
    `;
    if (state !== "granted" && state !== "unsupported") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Allow";
      btn.onclick = async () => {
        await requestAppPermission(perm.key);
        renderAppPermissions();
      };
      row.appendChild(btn);
    }
    list.appendChild(row);
  }
}

function refreshAppPermissions() {
  renderAppPermissions();
  setProfileMsg("Permissions updated.");
}

function onBiometricToggle(enabled) {
  const uid = getProfileUid();
  if (!uid) return;
  localStorage.setItem(`${BIOMETRIC_KEY}_${uid}`, enabled ? "1" : "0");
  renderSettingsList();
  if (!enabled) setProfileMsg("Biometric login off.");
}

async function setupBiometric() {
  const uid = getProfileUid();
  if (!uid) return setProfileMsg("Login first.", true);
  if (!window.PublicKeyCredential) {
    return setProfileMsg("Biometric not supported on this browser.", true);
  }
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: "Walkie Talkie", id: window.location.hostname || "localhost" },
        user: {
          id: new TextEncoder().encode(uid),
          name: loggedInUser.email || uid,
          displayName: loggedInUser.name || "User"
        },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required"
        },
        timeout: 60000
      }
    });
    localStorage.setItem(`${BIOMETRIC_KEY}_${uid}`, "1");
    const cb = document.getElementById("profileBiometric");
    if (cb) cb.checked = true;
    renderSettingsList();
    setProfileMsg("Biometric enabled on this device.");
  } catch (err) {
    setProfileMsg(err.message || "Biometric setup cancelled.", true);
  }
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
  initCountrySelect();
  initAvatarPickers();
  updateMenuAvatar();

  const first = document.getElementById("profileFirstName");
  const last = document.getElementById("profileLastName");
  const email = document.getElementById("profileEmail");
  const mobile = document.getElementById("profileMobile");
  const country = document.getElementById("profileCountry");
  const bio = document.getElementById("profileBiometric");
  const uid = getProfileUid();
  const names = loadUserNames(uid);
  if (!names.firstName && !names.lastName && loggedInUser.name) {
    const parsed = parseNameParts(loggedInUser.name);
    names.firstName = parsed.firstName;
    names.lastName = parsed.lastName;
  }
  const normalized = normalizeNameFields(names.firstName, names.lastName);

  if (first) first.value = normalized.firstName || "";
  if (last) last.value = normalized.lastName || "";
  if (email) email.value = "";
  updateEmailVerifiedBadge();

  if (mobile && country) {
    const raw = localStorage.getItem(`${PROFILE_MOBILE_KEY}_${uid}`);
    let parsed = { country: "+91", number: "" };
    try {
      if (raw?.startsWith("{")) parsed = JSON.parse(raw);
      else if (raw) parsed = { country: "+91", number: raw };
    } catch {
      if (raw) parsed = { country: "+91", number: raw };
    }
    const savedCountry = localStorage.getItem(`${PROFILE_COUNTRY_KEY}_${uid}`);
    country.value = savedCountry || parsed.country || "+91";
    mobile.value = parsed.number || "";
  }
  if (bio) bio.checked = localStorage.getItem(`${BIOMETRIC_KEY}_${uid}`) === "1";
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
    : `${loggedInUser.name} · <span style="color:var(--text-faint)">Select a channel in menu</span>`;
}

function buildLoggedInUser(user) {
  const uid = user.uid;
  let names = loadUserNames(uid);
  const display = user.displayName || user.name || "";
  if (!names.firstName && !names.lastName && display) {
    names = { ...parseNameParts(display), accountType: "individual" };
    saveUserNames(uid, names.firstName, names.lastName);
  }
  const fullName = `${names.firstName} ${names.lastName}`.trim() || display || (user.email || "").split("@")[0];
  return {
    uid,
    firstName: names.firstName,
    lastName: names.lastName,
    name: fullName,
    email: user.email,
    emailVerified: !!user.emailVerified
  };
}

function enterApp(user) {
  isLoggedIn = true;
  loggedInUser = buildLoggedInUser(user);
  const uid = loggedInUser.uid;
  if (uid && !getUserId(uid)) {
    const suggested = suggestUserIdFromEmail(loggedInUser.email);
    if (suggested.length >= 3) saveProfileExtra(uid, { userId: suggested });
  }
  loadChannels();
  loadFriends();
  loadBtDevices();
  loadSelectedWifi();
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("mainUI").style.display = "block";
  refreshStatusBar();
  renderChannels();
  updatePttHint();
  updateMenuAvatar();
  renderSettingsList();
  ensureWifiForDiscovery();
  if (selectedWifiName) setWifiStatus(true, selectedWifiName);
  renderBluetoothList();
  startChannelWifiSync();
}

window.onFirebaseUser = function (firebaseUser) {
  if (!firebaseUser || isLoggedIn) return;
  enterApp({
    uid: firebaseUser.uid,
    displayName: firebaseUser.displayName,
    email: firebaseUser.email,
    emailVerified: firebaseUser.emailVerified
  });
};

function getSignupE164() {
  const country = document.getElementById("signupCountry")?.value || "+91";
  const number = document.getElementById("signupMobile")?.value.trim().replace(/\D/g, "");
  if (!number) return "";
  return `${country}${number.replace(/^0+/, "")}`;
}

async function signup() {
  if (!requireFirebase()) return;
  const rawFirst = document.getElementById("signupFirstName")?.value.trim() || "";
  const rawLast = document.getElementById("signupLastName")?.value.trim() || "";
  const { firstName, lastName } = normalizeNameFields(rawFirst, rawLast);
  const email = document.getElementById("signupEmail").value.trim().toLowerCase();
  const country = document.getElementById("signupCountry")?.value || "+91";
  const mobile = document.getElementById("signupMobile")?.value.trim().replace(/\D/g, "");
  const userId = normalizeUserId(document.getElementById("signupUserId")?.value || "");
  const gender = document.getElementById("signupGender")?.value || "";
  const birthday = document.getElementById("signupBirthday")?.value || "";
  const password = document.getElementById("signupPassword").value;
  const confirm = document.getElementById("signupConfirm").value;

  const firstErr = validateFirstName(firstName);
  if (firstErr) return setAuthError(firstErr, ["signupFirstName"]);
  if (!lastName) return setAuthError("Please enter last name.", ["signupLastName"]);
  const userIdErr = validateUserId(userId);
  if (userIdErr) return setAuthError(userIdErr, ["signupUserId"]);
  if (!email) return setAuthError("Please enter Gmail or email address.", ["signupEmail"]);
  if (!isValidEmail(email))
    return setAuthError("Wrong email format. Use you@gmail.com", ["signupEmail"]);
  if (!mobile || mobile.length < 8) {
    return setAuthError("Please enter a valid mobile number.", ["signupMobile"]);
  }
  if (!gender) return setAuthError("Please select gender.", ["signupGender"]);
  if (!birthday) return setAuthError("Please enter birthday.", ["signupBirthday"]);
  if (password.length < 6) return setAuthError("Password must be at least 6 characters.", ["signupPassword"]);
  if (password !== confirm)
    return setAuthError("Passwords do not match.", ["signupPassword", "signupConfirm"]);

  setAuthLoading(true);
  setAuthError("", []);
  try {
    const user = await window.mosAuth.signupEmail(firstName, lastName, email, password);
    saveUserNames(user.uid, firstName, lastName);
    saveMobileProfile(user.uid, country, mobile, false);
    saveProfileExtra(user.uid, { userId, gender, birthday });
    alert("Account created! Check your email to verify (✓ will show in Settings).");
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
    await user.reload?.();
    enterApp({
      uid: user.uid,
      displayName: user.displayName,
      email: user.email,
      emailVerified: user.emailVerified
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
      displayName: user.displayName,
      email: user.email,
      emailVerified: user.emailVerified
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

function getChannelSearchQuery() {
  return (document.getElementById("channelSearch")?.value || "").trim().toLowerCase();
}

function getWifiDiscoveryKey() {
  if (!selectedWifiName) return null;
  const n = selectedWifiName.trim();
  if (!n) return null;
  if (n === "Current WiFi (browser)") return "channel-wifi";
  return n.toLowerCase();
}

function getFirestoreDb() {
  return window.mosAuth?.getFirestore?.() || null;
}

function getRealtimeDb() {
  return window.mosAuth?.getRealtimeDb?.() || null;
}

function channelDocIsFresh(data) {
  const ts = data.updatedAt?.toMillis?.() ?? data.updatedAt;
  if (!ts) return true;
  return Date.now() - Number(ts) < CHANNEL_STALE_MS;
}

function mapSyncError(err) {
  const msg = String(err?.message || "");
  if (err?.code === "permission-denied" || msg.includes("PERMISSION_DENIED")) {
    return (
      'Database rules blocked access. In Firebase Console open <a href="https://console.firebase.google.com/project/walkietalkie-mos/database" target="_blank" rel="noopener">Realtime Database</a>, create the database if needed, then paste rules from <code>database.rules.json</code> in this project and Publish.'
    );
  }
  if (msg.includes("not been used") || msg.includes("SERVICE_DISABLED")) {
    return (
      'Cloud sync is off. Open <a href="https://console.firebase.google.com/project/walkietalkie-mos/database" target="_blank" rel="noopener">Firebase → Realtime Database</a>, click <strong>Create Database</strong>, then Publish rules from <code>database.rules.json</code>.'
    );
  }
  return "Could not load nearby channels. Check internet and try again.";
}

async function resolveChannelSyncBackend() {
  if (channelSyncBackend) return channelSyncBackend;
  const fs = getFirestoreDb();
  if (fs) {
    try {
      await getDocs(query(collection(fs, PUBLIC_CHANNELS_COLLECTION), limit(1)));
      channelSyncBackend = "firestore";
      return channelSyncBackend;
    } catch (err) {
      console.warn("Firestore unavailable, using Realtime Database", err);
    }
  }
  if (getRealtimeDb()) {
    channelSyncBackend = "rtdb";
    return channelSyncBackend;
  }
  channelSyncBackend = "none";
  return channelSyncBackend;
}

function buildChannelPayload(ch) {
  const wifiKey = getWifiDiscoveryKey();
  if (!wifiKey || !loggedInUser || !ch?.channelId) return null;
  return {
    name: ch.name,
    frequency: ch.frequency,
    channelId: ch.channelId,
    wifiKey,
    ownerUid: loggedInUser.uid,
    ownerName: loggedInUser.name || "User",
    updatedAt: Date.now()
  };
}

async function publishChannelRecord(ch) {
  const payload = buildChannelPayload(ch);
  if (!payload) return false;
  const backend = await resolveChannelSyncBackend();
  try {
    if (backend === "firestore") {
      const fs = getFirestoreDb();
      await setDoc(
        doc(fs, PUBLIC_CHANNELS_COLLECTION, ch.channelId),
        { ...payload, updatedAt: serverTimestamp() },
        { merge: true }
      );
      channelShareOk = true;
      return true;
    }
    if (backend === "rtdb") {
      const rtdb = getRealtimeDb();
      await set(ref(rtdb, `${PUBLIC_CHANNELS_COLLECTION}/${ch.channelId}`), payload);
      channelShareOk = true;
      return true;
    }
  } catch (err) {
    console.warn("Channel publish failed", err);
    channelShareOk = false;
    nearbySearchError = mapSyncError(err);
  }
  return false;
}

async function publishAllChannelsToWifi() {
  if (!getWifiDiscoveryKey() || !loggedInUser) return;
  const list = channels.length ? channels : getActiveChannel() ? [getActiveChannel()] : [];
  for (const ch of list) {
    await publishChannelRecord(ch);
  }
}

function ensureWifiForDiscovery() {
  if (selectedWifiName) return;
  selectedWifiName = "channel-wifi";
  localStorage.setItem(WIFI_SEL_KEY, "channel-wifi");
  setWifiStatus(true, "Same WiFi as channel");
  updateWifiChip(true, "Same WiFi");
}

function parseNearbySnapshotEntries(entries) {
  const list = [];
  for (const item of entries) {
    const data = item.data;
    if (!channelDocIsFresh(data)) continue;
    const channelId = data.channelId || item.id;
    if (getLocalChannelByPublicId(channelId)) continue;
    list.push({
      name: data.name || "Channel",
      channelId,
      frequency: String(data.frequency || ""),
      ownerName: data.ownerName || ""
    });
  }
  list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  nearbyChannels = list;
}

function stopNearbyListener() {
  if (nearbyRtdbRef) {
    off(nearbyRtdbRef);
    nearbyRtdbRef = null;
  }
}

function startNearbyRtdbListener(wifiKey) {
  const rtdb = getRealtimeDb();
  if (!rtdb || !wifiKey) return;
  stopNearbyListener();
  nearbyRtdbRef = ref(rtdb, PUBLIC_CHANNELS_COLLECTION);
  onValue(nearbyRtdbRef, (snap) => {
    const entries = [];
    snap.forEach((child) => {
      const data = child.val();
      if (!data || data.wifiKey !== wifiKey) return;
      entries.push({ id: child.key, data });
    });
    parseNearbySnapshotEntries(entries);
    nearbyLoading = false;
    if (channelPanelOpen) renderChannels();
  }, (err) => {
    console.warn("RTDB listener failed", err);
    nearbySearchError = mapSyncError(err);
    nearbyLoading = false;
    if (channelPanelOpen) renderChannels();
  });
}

function getLocalChannelByPublicId(publicId) {
  return channels.find((c) => c.channelId === publicId);
}

function channelMatchesSearch(ch, query) {
  if (!query) return true;
  const hay = `${ch.name || ""} ${ch.channelId || ""} ${ch.frequency || ""} ${ch.ownerName || ""}`.toLowerCase();
  return hay.includes(query);
}

function scheduleNearbyRefresh() {
  clearTimeout(nearbyRefreshTimer);
  nearbyRefreshTimer = setTimeout(() => refreshNearbyChannels(), 300);
}

function filterChannels() {
  renderChannels();
  scheduleNearbyRefresh();
}

async function publishActiveChannelToWifi() {
  const ch = getActiveChannel();
  if (!ch) return;
  await publishChannelRecord(ch);
}

async function refreshNearbyChannels() {
  const wifiKey = getWifiDiscoveryKey();
  if (!wifiKey || !isLoggedIn) {
    stopNearbyListener();
    nearbyChannels = [];
    nearbyLoading = false;
    nearbySearchError = "";
    if (channelPanelOpen) renderChannels();
    return;
  }
  nearbyLoading = true;
  nearbySearchError = "";
  if (channelPanelOpen) renderChannels();

  const backend = await resolveChannelSyncBackend();
  if (backend === "none") {
    nearbyLoading = false;
    nearbySearchError =
      'Channel sharing needs Firebase Database. <a href="https://console.firebase.google.com/project/walkietalkie-mos/database" target="_blank" rel="noopener">Create Realtime Database</a> (one time), then Publish <code>database.rules.json</code> rules.';
    if (channelPanelOpen) renderChannels();
    return;
  }

  if (backend === "rtdb") {
    startNearbyRtdbListener(wifiKey);
    return;
  }

  const fs = getFirestoreDb();
  if (!fs) {
    nearbyLoading = false;
    return;
  }
  try {
    const snap = await getDocs(
      query(collection(fs, PUBLIC_CHANNELS_COLLECTION), where("wifiKey", "==", wifiKey))
    );
    const entries = [];
    snap.forEach((docSnap) => {
      entries.push({ id: docSnap.id, data: docSnap.data() });
    });
    parseNearbySnapshotEntries(entries);
    channelShareOk = true;
  } catch (err) {
    console.warn("Nearby channel search failed", err);
    nearbyChannels = [];
    nearbySearchError = mapSyncError(err);
    channelSyncBackend = null;
  }
  nearbyLoading = false;
  if (channelPanelOpen) renderChannels();
}

function startChannelWifiSync() {
  stopChannelWifiSync();
  ensureWifiForDiscovery();
  publishAllChannelsToWifi();
  refreshNearbyChannels();
  channelHeartbeatTimer = setInterval(() => {
    publishAllChannelsToWifi();
    if (channelPanelOpen && channelSyncBackend !== "rtdb") refreshNearbyChannels();
  }, 45000);
}

function stopChannelWifiSync() {
  if (channelHeartbeatTimer) clearInterval(channelHeartbeatTimer);
  channelHeartbeatTimer = null;
  stopNearbyListener();
  channelSyncBackend = null;
  nearbyChannels = [];
  nearbyLoading = false;
  nearbySearchError = "";
  channelShareOk = false;
}

function appendChannelEmpty(container, html) {
  const el = document.createElement("div");
  el.className = "channel-empty";
  el.innerHTML = html;
  container.appendChild(el);
}

function appendChannelSectionLabel(container, text) {
  const el = document.createElement("div");
  el.className = "channel-section-label";
  el.textContent = text;
  container.appendChild(el);
}

function selectLocalChannel(id) {
  currentChannel = id;
  renderChannels();
  refreshStatusBar();
  updatePttHint();
  publishActiveChannelToWifi();
  closeMenu();
}

function joinNearbyChannel(publicId) {
  const nearby = nearbyChannels.find((c) => c.channelId === publicId);
  if (!nearby) return;
  const existing = getLocalChannelByPublicId(publicId);
  if (existing) {
    selectLocalChannel(existing.id);
    return;
  }
  const newId = channels.length ? Math.max(...channels.map((c) => c.id)) + 1 : 1;
  const record = normalizeChannelRecord({
    id: newId,
    name: nearby.name,
    channelId: nearby.channelId,
    frequency: nearby.frequency || generateChannelFrequency()
  });
  channels.push(record);
  currentChannel = newId;
  saveChannels();
  renderChannels();
  updatePttHint();
  publishActiveChannelToWifi();
  refreshNearbyChannels();
  closeMenu();
}

function renderLocalChannelItem(container, ch) {
  const div = document.createElement("div");
  div.className = "channel-item" + (ch.id === currentChannel ? " active" : "");
  div.innerHTML = `
    <div class="channel-info">
      <span class="channel-name">${escapeHtml(ch.name)}</span>
      <span class="channel-meta">${escapeHtml(getChannelMetaLine(ch))}</span>
    </div>
    <button type="button" class="delete-btn" title="Delete channel" aria-label="Delete channel">🗑</button>
  `;
  div.querySelector(".delete-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteChannel(ch.id);
  });
  div.addEventListener("click", (e) => {
    if (e.target.classList.contains("delete-btn")) return;
    selectLocalChannel(ch.id);
  });
  container.appendChild(div);
}

function renderNearbyChannelItem(container, ch) {
  const div = document.createElement("div");
  div.className = "channel-item channel-item-nearby";
  const owner = ch.ownerName ? ` · ${ch.ownerName}` : "";
  div.innerHTML = `
    <div class="channel-info">
      <span class="channel-name">${escapeHtml(ch.name)}</span>
      <span class="channel-meta">${escapeHtml(getChannelMetaLine(ch))}${escapeHtml(owner)}</span>
    </div>
    <button type="button" class="channel-join-btn">Join</button>
  `;
  div.querySelector(".channel-join-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    joinNearbyChannel(ch.channelId);
  });
  div.addEventListener("click", () => joinNearbyChannel(ch.channelId));
  container.appendChild(div);
}

function renderChannels() {
  const container = document.getElementById("channelList");
  if (!container) return;
  container.innerHTML = "";
  const query = getChannelSearchQuery();
  const wifiKey = getWifiDiscoveryKey();

  if (!wifiKey) {
    appendChannelEmpty(
      container,
      "Open <strong>WiFi</strong> in menu and select your network (or “Same WiFi as channel”) to find channels nearby."
    );
  } else if (nearbyLoading) {
    appendChannelEmpty(container, "Searching channels on your WiFi…");
  } else if (nearbySearchError) {
    appendChannelEmpty(container, nearbySearchError);
  }

  if (channels.length && (!currentChannel || !channels.some((c) => c.id === currentChannel))) {
    currentChannel = channels[0].id;
  }

  const localVisible = channels.filter((ch) => channelMatchesSearch(ch, query));
  const nearbyVisible = wifiKey
    ? nearbyChannels.filter((ch) => channelMatchesSearch(ch, query))
    : [];

  if (localVisible.length) {
    if (wifiKey && (nearbyVisible.length || channels.length > 1)) {
      appendChannelSectionLabel(container, "Your channels");
    }
    localVisible.forEach((ch) => renderLocalChannelItem(container, ch));
  }

  if (nearbyVisible.length) {
    appendChannelSectionLabel(container, "On same WiFi");
    nearbyVisible.forEach((ch) => renderNearbyChannelItem(container, ch));
  }

  if (!localVisible.length && !nearbyVisible.length && !nearbyLoading && !nearbySearchError) {
    if (query) {
      appendChannelEmpty(
        container,
        wifiKey
          ? "No channels match your search on this WiFi.<br>Ask others to open Channel with the same WiFi selected."
          : "No channels match your search."
      );
    } else if (channels.length && wifiKey && channelShareOk) {
      appendChannelEmpty(
        container,
        "Your channel is on WiFi. Waiting for others — they need the same WiFi option + Channel menu open."
      );
    } else if (!channels.length && wifiKey) {
      appendChannelEmpty(
        container,
        "No channels on this WiFi yet.<br>Create one above — others on the same WiFi will see it in search."
      );
    } else if (!channels.length) {
      appendChannelEmpty(container, "No channels yet.<br>Create one above.");
      currentChannel = null;
    }
  }

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
  publishAllChannelsToWifi();
}

function parseChannelFrequency(raw) {
  const val = (raw || "").trim().replace(/mhz/gi, "").trim();
  if (!val) return generateChannelFrequency();
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return generateChannelFrequency();
  return num.toFixed(4);
}

function addNewChannel() {
  const input = document.getElementById("newChannelName");
  const freqInput = document.getElementById("newChannelFreq");
  const name = input?.value.trim();
  if (!name) {
    alert("Please enter a channel name.");
    return;
  }
  const newId = channels.length ? Math.max(...channels.map((c) => c.id)) + 1 : 1;
  const record = normalizeChannelRecord({
    id: newId,
    name,
    channelId: generateChannelId(),
    frequency: parseChannelFrequency(freqInput?.value)
  });
  channels.push(record);
  currentChannel = newId;
  if (input) input.value = "";
  if (freqInput) freqInput.value = "";
  saveChannels();
  renderChannels();
  updatePttHint();
  publishAllChannelsToWifi();
  refreshNearbyChannels();
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
  if (isLoggedIn) {
    publishAllChannelsToWifi();
    refreshNearbyChannels();
  }
}

let lastWifiScanNetworks = [];
let lastWifiConnected = "";

function bindWifiListClicks(list) {
  list.querySelectorAll("[data-wifi]").forEach((el) => {
    el.addEventListener("click", () => selectWifiNetwork(el.getAttribute("data-wifi")));
  });
  list.querySelector("#wifiManualApply")?.addEventListener("click", applyManualWifiName);
  list.querySelector("#wifiManualName")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyManualWifiName();
  });
}

function applyManualWifiName() {
  const raw = document.getElementById("wifiManualName")?.value?.trim();
  if (!raw) {
    alert("Type your WiFi name (same on all devices), or tap “Same WiFi as channel” above.");
    return;
  }
  selectWifiNetwork(raw);
}

function renderWifiPickList({ networks = [], connectedSsid = "", topHint = "", bottomHint = "" } = {}) {
  const list = document.getElementById("wifiList");
  if (!list) return;

  let html = "";
  if (topHint) {
    html += `<div class="pick-item warn">${escapeHtml(topHint)}</div>`;
  }

  const sameWifiActive = selectedWifiName === "channel-wifi" ? " active" : "";
  html += `<div class="pick-item pick-item-primary${sameWifiActive}" data-wifi="channel-wifi"><strong>Same WiFi as channel</strong><span class="pick-item-sub">Tap this on every phone on the same WiFi (recommended)</span></div>`;

  if (connectedSsid) {
    const active = selectedWifiName === connectedSsid ? " active" : "";
    html += `<div class="pick-item${active}" data-wifi="${escapeHtml(connectedSsid)}">${escapeHtml(connectedSsid)} (connected on this device)</div>`;
  }

  networks.forEach((n) => {
    if (!n || n === connectedSsid) return;
    const active = selectedWifiName === n ? " active" : "";
    html += `<div class="pick-item${active}" data-wifi="${escapeHtml(n)}">${escapeHtml(n)}</div>`;
  });

  html += `
    <div class="wifi-manual-row">
      <input type="text" id="wifiManualName" class="wifi-manual-input" placeholder="WiFi name (optional, same on all devices)" autocomplete="off">
      <button type="button" class="btn btn-sm" id="wifiManualApply">Use name</button>
    </div>`;

  if (bottomHint) {
    html += `<div class="pick-item warn">${escapeHtml(bottomHint)}</div>`;
  } else if (!window.windowsAPI?.scanWifiNetworks) {
    html += `<div class="pick-item warn">Phones cannot list WiFi names in the browser — use “Same WiFi as channel” above.</div>`;
  }

  list.innerHTML = html;
  bindWifiListClicks(list);
}

function renderWifiList(networks, connectedSsid) {
  lastWifiScanNetworks = networks || [];
  lastWifiConnected = connectedSsid || "";
  renderWifiPickList({ networks: lastWifiScanNetworks, connectedSsid: lastWifiConnected });
}

async function refreshWifiList() {
  const list = document.getElementById("wifiList");
  if (!list) return;
  list.innerHTML = '<div class="pick-item warn">Loading…</div>';

  if (window.windowsAPI?.scanWifiNetworks) {
    try {
      const result = await window.windowsAPI.scanWifiNetworks();
      lastWifiScanNetworks = result.networks || [];
      lastWifiConnected = result.connected || "";
      renderWifiPickList({
        networks: lastWifiScanNetworks,
        connectedSsid: lastWifiConnected,
        topHint: result.ok ? "" : result.message || "Scan could not list networks.",
        bottomHint: lastWifiScanNetworks.length
          ? ""
          : "No extra networks found — you can still use “Same WiFi as channel” above."
      });
      if (!selectedWifiName) {
        selectWifiNetwork("channel-wifi");
      }
      return;
    } catch (err) {
      renderWifiPickList({
        topHint: err.message || "WiFi scan failed.",
        bottomHint: "Use “Same WiFi as channel” above to connect with other phones."
      });
      if (!selectedWifiName) selectWifiNetwork("channel-wifi");
      return;
    }
  }

  const hint = getNetworkHint();
  lastWifiScanNetworks = [];
  lastWifiConnected = "";
  renderWifiPickList({
    topHint: hint,
    bottomHint: "After selecting WiFi, open Channel to search or join nearby channels."
  });
  if (!selectedWifiName) selectWifiNetwork("channel-wifi");
}

function cancelNameEdit() {
  closeSettingsEditor();
  renderSettingsList();
}

function setupDeleteAccountEditor() {
  const user = window.mosAuth?.getCurrentUser?.();
  const hasPassword = window.mosAuth?.userHasPasswordProvider?.(user);
  const passWrap = document.getElementById("deleteAccountPassWrap");
  const googleHint = document.getElementById("deleteAccountGoogleHint");
  if (passWrap) passWrap.style.display = hasPassword ? "block" : "none";
  if (googleHint) googleHint.style.display = hasPassword ? "none" : "block";
}

function clearLocalUserData(uid) {
  if (!uid) return;
  [
    PROFILE_NAMES_KEY,
    PROFILE_MOBILE_KEY,
    PROFILE_AVATAR_KEY,
    PROFILE_COUNTRY_KEY,
    PROFILE_EXTRA_KEY,
    BIOMETRIC_KEY,
    PASSWORD_CHANGED_KEY
  ].forEach((key) => localStorage.removeItem(`${key}_${uid}`));
}

async function confirmDeleteAccount() {
  if (
    !confirm(
      "Delete your account permanently? All profile data will be removed and cannot be recovered."
    )
  ) {
    return;
  }
  const uid = getProfileUid();
  const pass = document.getElementById("deleteAccountPass")?.value || "";
  try {
    await window.mosAuth.deleteAccount(pass);
    clearLocalUserData(uid);
    closeSettingsEditor();
    await logout();
    setAuthError("Your account was deleted.", []);
  } catch (err) {
    setProfileMsg(window.mosAuth.mapError(err), true);
  }
}

async function saveProfileName() {
  const rawFirst = document.getElementById("profileFirstName")?.value.trim() || "";
  const rawLast = document.getElementById("profileLastName")?.value.trim() || "";
  const { firstName, lastName } = normalizeNameFields(rawFirst, rawLast);
  const firstErr = validateFirstName(firstName);
  if (firstErr) return setProfileMsg(firstErr, true);
  if (!lastName) return setProfileMsg("Enter last name.", true);
  const fullName = `${firstName} ${lastName}`.trim();
  try {
    await window.mosAuth.updateDisplayName(fullName);
    saveUserNames(getProfileUid(), firstName, lastName);
    loggedInUser.firstName = firstName;
    loggedInUser.lastName = lastName;
    loggedInUser.name = fullName;
    refreshStatusBar();
    updateMenuAvatar();
    renderSettingsList();
    setProfileMsg("Name updated.");
    cancelNameEdit();
  } catch (err) {
    setProfileMsg(window.mosAuth.mapError(err), true);
  }
}

function showOtpBox(id, show) {
  document.getElementById(id)?.classList.toggle("open", !!show);
}

function getE164Phone() {
  const country = document.getElementById("profileCountry")?.value || "+91";
  const number = document.getElementById("profileMobile")?.value.trim().replace(/\D/g, "");
  if (!number) return "";
  return `${country}${number.replace(/^0+/, "")}`;
}

async function sendEmailChangeOtp() {
  const email = document.getElementById("profileEmail")?.value.trim().toLowerCase();
  const pass = document.getElementById("profileCurrentPass")?.value;
  if (!email || !isValidEmail(email)) return setProfileMsg("Enter a valid new email.", true);
  if (!pass) return setProfileMsg("Enter current password first.", true);
  if (email === loggedInUser?.email?.toLowerCase()) {
    return setProfileMsg("Enter a different email address.", true);
  }
  try {
    const result = await window.mosAuth.requestEmailChangeOtp(email, pass);
    showOtpBox("emailOtpBox", true);
    document.getElementById("profileEmailOtp")?.focus();
    setProfileMsg(
      `Code sent to ${email}. Check inbox (and verification link). Demo OTP: ${result.otp}`
    );
  } catch (err) {
    setProfileMsg(window.mosAuth.mapError(err), true);
  }
}

async function confirmEmailChange() {
  const email = document.getElementById("profileEmail")?.value.trim().toLowerCase();
  const pass = document.getElementById("profileCurrentPass")?.value;
  const otp = document.getElementById("profileEmailOtp")?.value.trim();
  if (!otp || otp.length !== 6) return setProfileMsg("Enter 6-digit verification code.", true);
  if (!pass) return setProfileMsg("Enter current password.", true);
  try {
    await window.mosAuth.confirmEmailChangeOtp(email, otp, pass);
    loggedInUser.email = email;
    loggedInUser.emailVerified = true;
    document.getElementById("profileEmailOtp").value = "";
    showOtpBox("emailOtpBox", false);
    refreshStatusBar();
    updateEmailVerifiedBadge();
    renderSettingsList();
    setProfileMsg("Email verified and updated.");
  } catch (err) {
    setProfileMsg(window.mosAuth.mapError(err), true);
  }
}

async function sendMobileChangeOtp() {
  const pass = document.getElementById("profileCurrentPass")?.value;
  const e164 = getE164Phone();
  if (!e164 || e164.length < 10) return setProfileMsg("Enter valid mobile with country code.", true);
  if (!pass) return setProfileMsg("Enter current password first.", true);
  try {
    await window.mosAuth.reauthWithPassword(pass);
    try {
      await window.mosAuth.sendPhoneOtp(e164);
      showOtpBox("mobileOtpBox", true);
      document.getElementById("profileMobileOtp")?.focus();
      setProfileMsg(`OTP sent by SMS to ${e164}.`);
      return;
    } catch (phoneErr) {
      if (
        phoneErr?.code !== "auth/operation-not-allowed" &&
        phoneErr?.code !== "auth/invalid-app-credential"
      ) {
        throw phoneErr;
      }
    }
    const fallback = await window.mosAuth.requestPhoneChangeOtp(e164, pass);
    showOtpBox("mobileOtpBox", true);
    document.getElementById("profileMobileOtp")?.focus();
    setProfileMsg(
      `Phone Auth not enabled in Firebase. Demo OTP: ${fallback.otp} (enable Phone provider for real SMS).`
    );
  } catch (err) {
    setProfileMsg(window.mosAuth.mapError(err), true);
  }
}

async function confirmMobileChange() {
  const pass = document.getElementById("profileCurrentPass")?.value;
  const otp = document.getElementById("profileMobileOtp")?.value.trim();
  const country = document.getElementById("profileCountry")?.value || "+91";
  const number = document.getElementById("profileMobile")?.value.trim().replace(/\D/g, "");
  const e164 = getE164Phone();
  if (!otp || otp.length !== 6) return setProfileMsg("Enter 6-digit OTP.", true);
  if (!pass) return setProfileMsg("Enter current password.", true);
  const uid = getProfileUid();
  try {
    await window.mosAuth.reauthWithPassword(pass);
    await window.mosAuth.confirmPhoneOtp(otp, e164);
    saveMobileProfile(uid, country, number, true);
    document.getElementById("profileMobileOtp").value = "";
    showOtpBox("mobileOtpBox", false);
    renderSettingsList();
    setProfileMsg(`Mobile verified: ${country} ${number}`);
  } catch (err) {
    setProfileMsg(window.mosAuth.mapError(err), true);
  }
}

async function saveProfilePassword() {
  const cur = document.getElementById("profileCurrentPass")?.value;
  const neu = document.getElementById("profileNewPass")?.value;
  if (!cur) return setProfileMsg("Enter current password.", true);
  if (!neu || neu.length < 6) return setProfileMsg("New password min 6 characters.", true);
  try {
    await window.mosAuth.changePassword(cur, neu);
    const uid = getProfileUid();
    if (uid) localStorage.setItem(`${PASSWORD_CHANGED_KEY}_${uid}`, new Date().toISOString());
    document.getElementById("profileCurrentPass").value = "";
    document.getElementById("profileNewPass").value = "";
    renderSettingsList();
    setProfileMsg("Password changed.");
    closeSettingsEditor();
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

function isTypingInFormField() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!el.isContentEditable;
}

function startTalk(e) {
  if (e?.cancelable) e.preventDefault();
  if (!getActiveChannelName()) {
    openMenu();
    return;
  }
  isTalking = true;
  setPttVisual(true);
  const ch = getActiveChannelTalkLabel() || getActiveChannelName();
  const el = document.getElementById("statusMain");
  if (el) el.innerHTML = `<span class="accent">Live · ${escapeHtml(ch)}</span>`;
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
  stopChannelWifiSync();
  stopTalk();
  closeMenu();
  setBluetoothMenuOpen(false);
  setWifiMenuOpen(false);
  settingsPanelOpen = false;
  closeSettingsEditor();
  friendPanelOpen = false;
  channelPanelOpen = false;
  ["btnSettingsAction", "btnFriendAction", "btnBluetoothMenu", "btnWifiMenu", "btnChannelAction"].forEach((id) => {
    document.getElementById(id)?.classList.remove("selected");
  });
  ["settingsPanel", "friendPanel", "channelPanel"].forEach((id) => {
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
  initCountrySelect();
  initSignupFields();
  initAvatarPickers();
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

  document.addEventListener(
    "keydown",
    (e) => {
      if (isSpaceKey(e) && isLoggedIn && !isTypingInFormField()) {
        e.preventDefault();
        startTalk();
      }
    },
    true
  );
  document.addEventListener(
    "keyup",
    (e) => {
      if (isSpaceKey(e) && isLoggedIn && !isTypingInFormField()) stopTalk();
    },
    true
  );
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
  toggleChannelPanel,
  toggleTeamPanel,
  filterChannels,
  toggleFriendPanel,
  toggleSettingsPanel,
  toggleSettingsEditor,
  closeSettingsEditor,
  cancelNameEdit,
  confirmDeleteAccount,
  pickAvatarGallery,
  pickAvatarCamera,
  toggleEmojiPicker,
  saveProfileGender,
  saveProfileBirthday,
  saveProfileLanguage,
  saveProfileUserId,
  refreshAppPermissions,
  resendEmailVerification,
  setupBiometric,
  onBiometricToggle,
  addFriend,
  removeFriend,
  refreshWifiList,
  saveProfileName,
  sendEmailChangeOtp,
  confirmEmailChange,
  sendMobileChangeOtp,
  confirmMobileChange,
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