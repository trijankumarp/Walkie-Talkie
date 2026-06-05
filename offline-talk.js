/**
 * Offline walkie (no Firebase / no internet after pairing).
 * Uses WebRTC on the same local link (phone hotspot or WiFi without data).
 * Signaling: copy-paste offer/answer codes between devices.
 */

const OFFLINE_ICE = { iceServers: [] };

let offlinePc = null;
let offlineLocalStream = null;
let offlineRemoteAudio = null;
let offlineMode = false;
let offlineRole = null;

function offlineSetStatus(msg, isError) {
  const el = document.getElementById("offlineTalkStatus");
  if (!el) return;
  el.textContent = msg;
  el.className = "profile-msg" + (isError ? " err" : " ok");
}

function isOfflineTalkActive() {
  return offlineMode && offlinePc?.connectionState === "connected";
}

async function offlineEnsureMic() {
  if (offlineLocalStream) return offlineLocalStream;
  offlineLocalStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: false
  });
  offlineLocalStream.getAudioTracks().forEach((t) => {
    t.enabled = false;
  });
  return offlineLocalStream;
}

function offlineAttachRemoteStream(stream) {
  if (!offlineRemoteAudio) {
    offlineRemoteAudio = document.createElement("audio");
    offlineRemoteAudio.autoplay = true;
    offlineRemoteAudio.playsInline = true;
    document.body.appendChild(offlineRemoteAudio);
  }
  offlineRemoteAudio.srcObject = stream;
}

function waitIceGathering(pc, timeoutMs = 8000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    const timer = setTimeout(done, timeoutMs);
  });
}

function offlineCreatePeer(role) {
  if (offlinePc) {
    offlinePc.close();
    offlinePc = null;
  }
  offlineRole = role;
  offlineMode = true;
  offlinePc = new RTCPeerConnection(OFFLINE_ICE);

  offlinePc.ontrack = (ev) => {
    if (ev.streams?.[0]) offlineAttachRemoteStream(ev.streams[0]);
  };

  offlinePc.onconnectionstatechange = () => {
    const s = offlinePc?.connectionState || "closed";
    if (s === "connected") {
      offlineSetStatus("Connected — Hold to talk (no internet).");
      if (typeof refreshStatusBar === "function") refreshStatusBar();
    } else if (s === "failed" || s === "disconnected") {
      offlineSetStatus("Connection lost. Create a new offer on both phones.", true);
    } else {
      offlineSetStatus(`Offline link: ${s}`);
    }
  };

  offlinePc.onicecandidate = (ev) => {
    if (ev.candidate) {
      offlineSetStatus("Gathering local network… keep both on same hotspot.");
    }
  };
}

function offlineEncode(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function offlineDecode(str) {
  const b64 = str.trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function offlineHostCreateOffer() {
  if (!window.RTCPeerConnection) {
    offlineSetStatus("WebRTC not supported in this browser.", true);
    return;
  }
  try {
    offlineCreatePeer("host");
    const stream = await offlineEnsureMic();
    stream.getTracks().forEach((t) => offlinePc.addTrack(t, stream));
    const offer = await offlinePc.createOffer();
    await offlinePc.setLocalDescription(offer);
    await waitIceGathering(offlinePc);
    const code = offlineEncode({ t: "offer", sdp: offlinePc.localDescription });
    const out = document.getElementById("offlineOfferOut");
    if (out) out.value = code;
    offlineSetStatus("Copy the OFFER code → send to other phone → they paste in JOIN.");
  } catch (err) {
    offlineSetStatus(err.message || "Could not create offer.", true);
  }
}

async function offlineJoinApplyOffer() {
  const raw = document.getElementById("offlineOfferIn")?.value?.trim();
  if (!raw) {
    offlineSetStatus("Paste the host OFFER code first.", true);
    return;
  }
  try {
    const payload = offlineDecode(raw);
    if (payload.t !== "offer" || !payload.sdp) throw new Error("Invalid offer code.");
    offlineCreatePeer("join");
    const stream = await offlineEnsureMic();
    stream.getTracks().forEach((t) => offlinePc.addTrack(t, stream));
    await offlinePc.setRemoteDescription(payload.sdp);
    const answer = await offlinePc.createAnswer();
    await offlinePc.setLocalDescription(answer);
    await waitIceGathering(offlinePc);
    const code = offlineEncode({ t: "answer", sdp: offlinePc.localDescription });
    const out = document.getElementById("offlineAnswerOut");
    if (out) out.value = code;
    offlineSetStatus("Copy the ANSWER code → send back to host → host pastes below.");
  } catch (err) {
    offlineSetStatus(err.message || "Invalid offer.", true);
  }
}

async function offlineHostApplyAnswer() {
  const raw = document.getElementById("offlineAnswerIn")?.value?.trim();
  if (!raw) {
    offlineSetStatus("Paste the JOIN phone ANSWER code here.", true);
    return;
  }
  try {
    const payload = offlineDecode(raw);
    if (payload.t !== "answer" || !payload.sdp) throw new Error("Invalid answer code.");
    if (!offlinePc || offlineRole !== "host") throw new Error("Create OFFER first.");
    await offlinePc.setRemoteDescription(payload.sdp);
    offlineSetStatus("Connecting on local network (no internet)…");
  } catch (err) {
    offlineSetStatus(err.message || "Invalid answer.", true);
  }
}

function offlineStartTransmit() {
  if (!offlineLocalStream) return;
  offlineLocalStream.getAudioTracks().forEach((t) => {
    t.enabled = true;
  });
}

function offlineStopTransmit() {
  if (!offlineLocalStream) return;
  offlineLocalStream.getAudioTracks().forEach((t) => {
    t.enabled = false;
  });
}

function offlineTalkCleanup() {
  offlineStopTransmit();
  if (offlinePc) {
    offlinePc.close();
    offlinePc = null;
  }
  if (offlineLocalStream) {
    offlineLocalStream.getTracks().forEach((t) => t.stop());
    offlineLocalStream = null;
  }
  if (offlineRemoteAudio) {
    offlineRemoteAudio.srcObject = null;
    offlineRemoteAudio.remove();
    offlineRemoteAudio = null;
  }
  offlineMode = false;
  offlineRole = null;
}

window.offlineTalk = {
  isActive: isOfflineTalkActive,
  isMode: () => offlineMode,
  hostCreateOffer: offlineHostCreateOffer,
  joinApplyOffer: offlineJoinApplyOffer,
  hostApplyAnswer: offlineHostApplyAnswer,
  startTransmit: offlineStartTransmit,
  stopTransmit: offlineStopTransmit,
  cleanup: offlineTalkCleanup,
  setStatus: offlineSetStatus
};