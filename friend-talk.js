/**
 * 1:1 friend voice talk over internet (WebRTC + Firebase RTDB signaling).
 */

const FT_ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

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

function ftAttachRemote(stream) {
  if (!ftRemoteAudio) {
    ftRemoteAudio = document.createElement("audio");
    ftRemoteAudio.autoplay = true;
    ftRemoteAudio.playsInline = true;
    document.body.appendChild(ftRemoteAudio);
  }
  ftRemoteAudio.srcObject = stream;
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

async function ftPushCandidate(rtdb, path, myUid, candidate) {
  const { ref, push, set } = await ftLoadDb();
  const id = push(ref(rtdb, `${path}/candidates/${myUid}`)).key;
  await set(ref(rtdb, `${path}/candidates/${myUid}/${id}`), {
    candidate: candidate.toJSON(),
    fromUid: myUid,
    at: Date.now()
  });
}

async function ftCreatePeer(myUid, friendUid) {
  const { ref, onValue, off, set, get } = await ftLoadDb();
  const rtdb = ftGetRtdb();
  if (!rtdb) throw new Error("Database not available.");

  ftMyUid = myUid;
  ftFriendUid = friendUid;
  ftSignalPath = ftSignalBase(myUid, friendUid);
  ftConnected = false;

  if (ftPc) {
    ftPc.close();
    ftPc = null;
  }

  ftPc = new RTCPeerConnection(FT_ICE);
  const stream = await ftEnsureMic();
  stream.getTracks().forEach((t) => ftPc.addTrack(t, stream));

  ftPc.ontrack = (ev) => {
    if (ev.streams?.[0]) ftAttachRemote(ev.streams[0]);
  };

  ftPc.onicecandidate = (ev) => {
    if (ev.candidate) void ftPushCandidate(rtdb, ftSignalPath, myUid, ev.candidate);
  };

  ftPc.onconnectionstatechange = () => {
    const s = ftPc?.connectionState || "closed";
    if (s === "connected") {
      ftConnected = true;
      ftSetStatus("Friend talk connected — Hold to talk.");
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

    if (data.offer?.fromUid === friendUid && data.offer?.sdp && ftPc.signalingState !== "stable") {
      try {
        await ftPc.setRemoteDescription(data.offer.sdp);
        const answer = await ftPc.createAnswer();
        await ftPc.setLocalDescription(answer);
        await set(ref(rtdb, `${ftSignalPath}/answer`), {
          sdp: ftPc.localDescription,
          fromUid: myUid,
          at: Date.now()
        });
      } catch (err) {
        console.warn("Friend talk answer failed", err);
      }
    }

    if (data.answer?.fromUid === friendUid && data.answer?.sdp && ftPc.signalingState === "have-local-offer") {
      try {
        await ftPc.setRemoteDescription(data.answer.sdp);
      } catch (err) {
        console.warn("Friend talk set answer failed", err);
      }
    }
  };
  onValue(signalRef, onSignal);
  ftUnsubs.push(() => off(signalRef));

  const candRef = ref(rtdb, `${ftSignalPath}/candidates/${friendUid}`);
  const onCand = async (snap) => {
    snap.forEach((child) => {
      const item = child.val();
      if (!item?.candidate || !ftPc) return;
      ftPc.addIceCandidate(new RTCIceCandidate(item.candidate)).catch(() => {});
    });
  };
  onValue(candRef, onCand);
  ftUnsubs.push(() => off(candRef));

  if (ftIsInitiator(myUid, friendUid)) {
    const offer = await ftPc.createOffer();
    await ftPc.setLocalDescription(offer);
    await set(ref(rtdb, `${ftSignalPath}/offer`), {
      sdp: ftPc.localDescription,
      fromUid: myUid,
      at: Date.now()
    });
    ftSetStatus("Calling friend…");
  } else {
    const existing = (await get(signalRef)).val();
    if (existing?.offer?.fromUid === friendUid) {
      await onSignal({ val: () => existing });
    } else {
      ftSetStatus("Waiting for friend to connect…");
    }
  }
}

async function ftConnect(myUid, friendUid) {
  if (!window.RTCPeerConnection) {
    ftSetStatus("Voice talk not supported in this browser.", true);
    return false;
  }
  if (!myUid || !friendUid) return false;
  try {
    await ftDisconnect(false);
    await ftCreatePeer(myUid, friendUid);
    return true;
  } catch (err) {
    console.warn("Friend talk connect failed", err);
    ftSetStatus(err.message || "Could not start friend talk.", true);
    return false;
  }
}

async function ftDisconnect(clearSignal = true) {
  ftStopUnsubs();
  ftConnected = false;
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
    try {
      const { ref, remove } = await ftLoadDb();
      await remove(ref(ftGetRtdb(), ftSignalPath));
    } catch {
      /* ignore */
    }
  }
  ftMyUid = null;
  ftFriendUid = null;
  ftSignalPath = null;
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