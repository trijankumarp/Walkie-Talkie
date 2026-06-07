/**
 * 1:1 friend voice talk over internet (WebRTC + Firebase RTDB signaling).
 */

const FT_ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

let ftDb = null;
let ftPc = null;
let ftStream = null;
let ftRemoteAudio = null;
let ftMyUid = null;
let ftFriendUid = null;
let ftSignalPath = null;
let ftUnsubs = [];
let ftConnected = false;
let ftStatusCb = null;
let ftSessionId = null;
let ftPendingCandidates = [];
let ftSeenCandidateKeys = new Set();
let ftHandlingOffer = false;

async function ftLoadDb() {
  if (ftDb) return ftDb;
  const m = await import("https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js");
  ftDb = m;
  return ftDb;
}

function ftPair(uid1, uid2) {
  return [uid1, uid2].sort();
}

function ftSignalBase(uid1, uid2) {
  const [a, b] = ftPair(uid1, uid2);
  return `friendTalk/${a}/${b}`;
}

function ftGetRtdb() {
  return window.mosAuth?.getRealtimeDb?.() || null;
}

function ftFormatError(err) {
  if (typeof window.formatFriendDbError === "function") return window.formatFriendDbError(err);
  const msg = String(err?.message || err || "");
  if (msg.includes("PERMISSION_DENIED")) {
    return "Firebase rules block Talk. Publish database.rules.json → Rules → Publish.";
  }
  return msg || "Could not start friend talk.";
}

function ftSetStatus(msg, isError) {
  if (typeof ftStatusCb === "function") ftStatusCb(msg, isError);
}

function ftStopUnsubs() {
  ftUnsubs.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
  ftUnsubs = [];
}

function ftResetIceQueue() {
  ftPendingCandidates = [];
  ftSeenCandidateKeys = new Set();
}

function ftPlayRemote() {
  if (!ftRemoteAudio) return;
  const p = ftRemoteAudio.play();
  if (p && typeof p.catch === "function") {
    p.catch(() => {
      /* autoplay may need a user gesture; PTT press will retry */
    });
  }
}

function ftAttachRemote(stream) {
  if (!stream) return;
  if (!ftRemoteAudio) {
    ftRemoteAudio = document.createElement("audio");
    ftRemoteAudio.autoplay = true;
    ftRemoteAudio.playsInline = true;
    ftRemoteAudio.setAttribute("playsinline", "");
    ftRemoteAudio.volume = 1;
    document.body.appendChild(ftRemoteAudio);
  }
  ftRemoteAudio.srcObject = stream;
  ftPlayRemote();
}

async function ftDrainCandidates() {
  if (!ftPc?.remoteDescription) return;
  const pending = ftPendingCandidates.splice(0);
  for (const candidate of pending) {
    try {
      await ftPc.addIceCandidate(candidate);
    } catch {
      /* ignore stale/duplicate candidates */
    }
  }
}

async function ftAddRemoteCandidate(candidateJson, key) {
  if (!ftPc || !candidateJson) return;
  if (key && ftSeenCandidateKeys.has(key)) return;
  if (key) ftSeenCandidateKeys.add(key);

  const candidate = new RTCIceCandidate(candidateJson);
  if (!ftPc.remoteDescription) {
    ftPendingCandidates.push(candidate);
    return;
  }
  try {
    await ftPc.addIceCandidate(candidate);
  } catch {
    /* ignore */
  }
}

async function ftEnsureMic() {
  if (ftStream) return ftStream;
  ftStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: false
  });
  ftStream.getAudioTracks().forEach((t) => {
    t.enabled = false;
  });
  return ftStream;
}

function ftIsInitiator(myUid, friendUid) {
  return ftPair(myUid, friendUid)[0] === myUid;
}

function ftAdoptSessionId(data) {
  if (!data?.sessionId) return;
  if (!ftSessionId) {
    ftSessionId = data.sessionId;
    return;
  }
  if (ftSessionId !== data.sessionId && ftMyUid && ftFriendUid && ftIsInitiator(ftMyUid, ftFriendUid)) {
    return;
  }
  ftSessionId = data.sessionId;
}

function ftIsCurrentSession(data) {
  if (!data?.sessionId) return true;
  ftAdoptSessionId(data);
  if (!ftSessionId) return true;
  return data.sessionId === ftSessionId;
}

async function ftPushCandidate(rtdb, path, myUid, candidate) {
  const { ref, push, set } = await ftLoadDb();
  const id = push(ref(rtdb, `${path}/candidates/${myUid}`)).key;
  await set(ref(rtdb, `${path}/candidates/${myUid}/${id}`), {
    candidate: candidate.toJSON(),
    fromUid: myUid,
    sessionId: ftSessionId,
    at: Date.now()
  });
}

async function ftHandleOffer(rtdb, data) {
  if (!ftPc || ftHandlingOffer) return;
  const offer = data?.offer;
  if (!offer?.sdp || offer.fromUid !== ftFriendUid) return;
  if (!ftIsCurrentSession(data)) return;
  if (ftPc.signalingState !== "stable") return;

  ftHandlingOffer = true;
  try {
    await ftPc.setRemoteDescription(offer.sdp);
    const answer = await ftPc.createAnswer();
    await ftPc.setLocalDescription(answer);
    await ftLoadDb().then(({ ref, set }) =>
      set(ref(rtdb, `${ftSignalPath}/answer`), {
        sdp: ftPc.localDescription,
        fromUid: ftMyUid,
        sessionId: ftSessionId,
        at: Date.now()
      })
    );
    await ftDrainCandidates();
  } catch (err) {
    console.warn("Friend talk answer failed", err);
  } finally {
    ftHandlingOffer = false;
  }
}

async function ftHandleAnswer(data) {
  if (!ftPc) return;
  const answer = data?.answer;
  const offer = data?.offer;
  if (!answer?.sdp || answer.fromUid !== ftFriendUid) return;
  if (!ftIsCurrentSession(data)) return;
  if (ftPc.signalingState !== "have-local-offer") return;
  if (offer?.at && answer.at && answer.at < offer.at) return;

  try {
    await ftPc.setRemoteDescription(answer.sdp);
    await ftDrainCandidates();
  } catch (err) {
    console.warn("Friend talk set answer failed", err);
  }
}

async function ftCreatePeer(myUid, friendUid) {
  const { ref, onValue, off, set, get } = await ftLoadDb();
  const rtdb = ftGetRtdb();
  if (!rtdb) throw new Error("Database not available.");

  ftMyUid = myUid;
  ftFriendUid = friendUid;
  ftSignalPath = ftSignalBase(myUid, friendUid);
  ftSessionId = ftIsInitiator(myUid, friendUid) ? `ft_${Date.now()}` : null;
  ftConnected = false;
  ftResetIceQueue();

  if (ftPc) {
    ftPc.close();
    ftPc = null;
  }

  ftPc = new RTCPeerConnection(FT_ICE);
  const stream = await ftEnsureMic();
  stream.getTracks().forEach((t) => ftPc.addTrack(t, stream));

  ftPc.ontrack = (ev) => {
    if (ev.streams?.[0]) {
      ftAttachRemote(ev.streams[0]);
      return;
    }
    if (ev.track) ftAttachRemote(new MediaStream([ev.track]));
  };

  ftPc.onicecandidate = (ev) => {
    if (ev.candidate) void ftPushCandidate(rtdb, ftSignalPath, myUid, ev.candidate);
  };

  ftPc.onconnectionstatechange = () => {
    const s = ftPc?.connectionState || "closed";
    if (s === "connected") {
      ftConnected = true;
      ftSetStatus("Friend talk connected — Hold to talk.");
      ftPlayRemote();
      if (typeof window.refreshStatusBar === "function") window.refreshStatusBar();
      if (typeof window.updatePttHint === "function") window.updatePttHint();
    } else if (s === "failed" || s === "disconnected") {
      ftConnected = false;
      ftSetStatus("Friend talk disconnected. Tap Talk again.", true);
    } else {
      ftSetStatus(`Friend talk: ${s}…`);
    }
  };

  const signalRef = ref(rtdb, ftSignalPath);
  const onSignal = async (snap) => {
    const data = snap.val();
    if (!data || !ftPc) return;
    await ftHandleOffer(rtdb, data);
    await ftHandleAnswer(data);
  };
  onValue(signalRef, onSignal);
  ftUnsubs.push(() => off(signalRef));

  const candRef = ref(rtdb, `${ftSignalPath}/candidates/${friendUid}`);
  const onCand = (snap) => {
    snap.forEach((child) => {
      const item = child.val();
      if (!item?.candidate || !ftPc) return;
      if (item.sessionId && ftSessionId && item.sessionId !== ftSessionId) return;
      void ftAddRemoteCandidate(item.candidate, child.key);
    });
  };
  onValue(candRef, onCand);
  ftUnsubs.push(() => off(candRef));

  if (ftIsInitiator(myUid, friendUid)) {
    const offer = await ftPc.createOffer();
    await ftPc.setLocalDescription(offer);
    await set(ref(rtdb, ftSignalPath), {
      sessionId: ftSessionId,
      offer: {
        sdp: ftPc.localDescription,
        fromUid: myUid,
        at: Date.now()
      }
    });
    ftSetStatus("Calling friend…");
  } else {
    const existing = (await get(signalRef)).val();
    ftAdoptSessionId(existing);
    if (existing?.offer?.fromUid === friendUid) {
      await ftHandleOffer(rtdb, existing);
    } else {
      ftSetStatus("Waiting for friend to connect…");
    }
  }
}

async function ftClearSignal(path) {
  const rtdb = ftGetRtdb();
  if (!rtdb || !path) return;
  try {
    const { ref, remove } = await ftLoadDb();
    await remove(ref(rtdb, path));
  } catch {
    /* ignore */
  }
}

async function ftConnect(myUid, friendUid) {
  if (!window.RTCPeerConnection) {
    ftSetStatus("Voice talk not supported in this browser.", true);
    return false;
  }
  if (!myUid || !friendUid) return false;
  try {
    const path = ftSignalBase(myUid, friendUid);
    await ftDisconnect(false);
    await ftClearSignal(path);
    await ftCreatePeer(myUid, friendUid);
    return true;
  } catch (err) {
    console.warn("Friend talk connect failed", err);
    ftSetStatus(ftFormatError(err), true);
    return false;
  }
}

async function ftDisconnect(clearSignal = true) {
  ftStopUnsubs();
  ftConnected = false;
  ftHandlingOffer = false;
  ftResetIceQueue();
  if (ftStream) {
    ftStream.getTracks().forEach((t) => {
      t.enabled = false;
    });
  }
  if (ftPc) {
    ftPc.close();
    ftPc = null;
  }
  if (clearSignal && ftSignalPath && ftGetRtdb()) {
    await ftClearSignal(ftSignalPath);
  }
  ftMyUid = null;
  ftFriendUid = null;
  ftSignalPath = null;
  ftSessionId = null;
}

function ftCleanup() {
  if (ftStream) {
    ftStream.getTracks().forEach((t) => t.stop());
    ftStream = null;
  }
  if (ftRemoteAudio) {
    ftRemoteAudio.srcObject = null;
    ftRemoteAudio.remove();
    ftRemoteAudio = null;
  }
  void ftDisconnect(true);
}

function ftIsActive() {
  return !!ftPc && ftConnected;
}

function ftIsConnecting() {
  return !!ftPc && !ftConnected;
}

function ftGetFriendUid() {
  return ftFriendUid;
}

function ftStartTransmit() {
  if (!ftStream) return;
  ftStream.getAudioTracks().forEach((t) => {
    t.enabled = true;
  });
  ftPlayRemote();
}

function ftStopTransmit() {
  if (!ftStream) return;
  ftStream.getAudioTracks().forEach((t) => {
    t.enabled = false;
  });
}

window.friendTalk = {
  connect: ftConnect,
  disconnect: ftDisconnect,
  cleanup: ftCleanup,
  isActive: ftIsActive,
  isConnecting: ftIsConnecting,
  getFriendUid: ftGetFriendUid,
  startTransmit: ftStartTransmit,
  stopTransmit: ftStopTransmit,
  setStatusCallback: (cb) => {
    ftStatusCb = cb;
  }
};