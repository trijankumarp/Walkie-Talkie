/**
 * WhatsApp-style 1:1 friend voice call (WebRTC + Firebase RTDB).
 * Ring → Accept/Decline → full-duplex audio (no Hold to talk).
 */

const FT_ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ]
};

const FT_CONNECT_TIMEOUT_MS = 45000;

const FT_INCOMING_PATH = "friendIncomingCalls";

let ftDb = null;
let ftPc = null;
let ftStream = null;
let ftRemoteAudio = null;
let ftMyUid = null;
let ftFriendUid = null;
let ftSignalPath = null;
let ftUnsubs = [];
let ftIncomingUnsubs = [];
let ftConnected = false;
let ftStatusCb = null;
let ftUiCb = null;
let ftSessionId = null;
let ftPendingCandidates = [];
let ftSeenCandidateKeys = new Set();
let ftHandlingOffer = false;
let ftRole = null;
let ftCallState = "idle";
let ftMuted = false;
let ftIncomingWatchUid = null;
let ftConnectTimer = null;
let ftPollTimer = null;
let ftRtcStarted = false;
let ftDisconnectTimer = null;
let ftIceRestarted = false;
let ftOfferResendTimer = null;
let ftOfferWaitTimer = null;

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

function ftInvitePath(toUid, fromUid) {
  return `${FT_INCOMING_PATH}/${toUid}/${fromUid}`;
}

function ftGetRtdb() {
  return window.mosAuth?.getRealtimeDb?.() || null;
}

function ftFormatError(err) {
  if (typeof window.formatFriendDbError === "function") return window.formatFriendDbError(err);
  const msg = String(err?.message || err || "");
  if (msg.includes("PERMISSION_DENIED")) {
    return "Firebase rules block calls. Publish database.rules.json → Rules → Publish.";
  }
  return msg || "Could not start voice call.";
}

function ftSetStatus(msg, isError) {
  if (typeof ftStatusCb === "function") ftStatusCb(msg, isError);
}

function ftEmitUi(event, meta = {}) {
  if (typeof ftUiCb === "function") ftUiCb(event, meta);
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

function ftClearConnectTimer() {
  if (ftConnectTimer) clearTimeout(ftConnectTimer);
  ftConnectTimer = null;
}

function ftStopCallPoll() {
  if (ftPollTimer) clearInterval(ftPollTimer);
  ftPollTimer = null;
}

function ftClearOfferTimers() {
  if (ftOfferResendTimer) clearTimeout(ftOfferResendTimer);
  if (ftOfferWaitTimer) clearTimeout(ftOfferWaitTimer);
  ftOfferResendTimer = null;
  ftOfferWaitTimer = null;
}

function ftCallStatusPath(uid1, uid2) {
  return `${ftSignalBase(uid1, uid2)}/callStatus`;
}

function ftStatusMatchesCurrentCall(data) {
  if (!data) return false;
  if (!ftSessionId) return true;
  return !data.sessionId || data.sessionId === ftSessionId;
}

function ftClearDisconnectTimer() {
  if (ftDisconnectTimer) clearTimeout(ftDisconnectTimer);
  ftDisconnectTimer = null;
}

async function ftPrepareNewCall(myUid, friendUid, opts = {}) {
  const { clearRtc = true, clearCallStatus = true } = opts;
  const rtdb = ftGetRtdb();
  if (!rtdb || !myUid || !friendUid) return;
  const base = ftSignalBase(myUid, friendUid);
  const { ref, remove } = await ftLoadDb();
  if (clearRtc) await ftClearRtcOnly(base);
  if (clearCallStatus) await remove(ref(rtdb, `${base}/callStatus`));
  await ftClearInvite(friendUid, myUid);
  await ftClearInvite(myUid, friendUid);
}

async function ftSetCallStatus(status, extra = {}) {
  const rtdb = ftGetRtdb();
  if (!rtdb || !ftMyUid || !ftFriendUid) return;
  const { ref, set, remove } = await ftLoadDb();
  const path = ftCallStatusPath(ftMyUid, ftFriendUid);
  if (status === "cleared") {
    await remove(ref(rtdb, path));
    return;
  }
  await set(ref(rtdb, path), {
    status,
    sessionId: ftSessionId,
    callerUid: ftRole === "caller" ? ftMyUid : ftFriendUid,
    calleeUid: ftRole === "caller" ? ftFriendUid : ftMyUid,
    at: Date.now(),
    ...extra
  });
}

async function ftResetForNewSession() {
  ftClearConnectTimer();
  ftClearDisconnectTimer();
  ftClearOfferTimers();
  ftStopCallPoll();
  ftStopUnsubs();
  ftConnected = false;
  ftRtcStarted = false;
  ftIceRestarted = false;
  ftHandlingOffer = false;
  ftResetIceQueue();
  if (ftPc) {
    ftPc.close();
    ftPc = null;
  }
}

async function ftClearRtcOnly(basePath) {
  const rtdb = ftGetRtdb();
  if (!rtdb || !basePath) return;
  try {
    const { ref, remove } = await ftLoadDb();
    await remove(ref(rtdb, `${basePath}/offer`));
    await remove(ref(rtdb, `${basePath}/answer`));
    await remove(ref(rtdb, `${basePath}/candidates`));
  } catch {
    /* ignore */
  }
}

async function ftPollCallStatus(myUid, friendUid) {
  const rtdb = ftGetRtdb();
  if (!rtdb || ftRole !== "caller" || ftCallState !== "outgoing" || ftRtcStarted) return;
  try {
    const { ref, get } = await ftLoadDb();
    const snap = await get(ref(rtdb, ftCallStatusPath(myUid, friendUid)));
    const data = snap.val();
    if (data?.status === "accepted" && data.sessionId === ftSessionId) {
      await ftBeginWebRtc("caller");
    }
  } catch (err) {
    console.warn("Call status poll failed", err);
  }
}

function ftStartCallPoll(myUid, friendUid) {
  ftStopCallPoll();
  ftPollTimer = setInterval(() => {
    void ftPollCallStatus(myUid, friendUid);
  }, 1500);
}

async function ftWatchCallStatus(myUid, friendUid) {
  const rtdb = ftGetRtdb();
  if (!rtdb) return;
  const { ref, onValue, off } = await ftLoadDb();
  const statusRef = ref(rtdb, ftCallStatusPath(myUid, friendUid));
  const onStatus = (snap) => {
    const data = snap.val();
    if (!data || ftRole !== "caller") return;
    if (!ftStatusMatchesCurrentCall(data)) return;
    if (data.status === "accepted" && ftCallState === "outgoing" && !ftRtcStarted) {
      void ftBeginWebRtc("caller");
    } else if (
      ftCallState !== "idle" &&
      (data.status === "rejected" || data.status === "cancelled" || data.status === "ended")
    ) {
      void ftEndCall(data.status === "rejected" ? "declined" : data.status === "cancelled" ? "cancelled" : "ended");
    }
  };
  const onStatusErr = (err) => {
    console.warn("Call status listener failed", err);
    ftSetStatus(ftFormatError(err), true);
  };
  onValue(statusRef, onStatus, onStatusErr);
  ftUnsubs.push(() => off(statusRef));
}

function ftStartConnectTimer() {
  ftClearConnectTimer();
  ftConnectTimer = setTimeout(() => {
    if (ftCallState === "connecting" || (ftCallState === "outgoing" && ftRole === "caller")) {
      ftSetStatus("Call could not connect. Try again.", true);
      void ftEndCall("lost");
    }
  }, FT_CONNECT_TIMEOUT_MS);
}

function ftWaitIceGathering(pc, timeoutMs = 6000) {
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

function ftPlayRemote() {
  if (!ftRemoteAudio) return;
  const p = ftRemoteAudio.play();
  if (p && typeof p.catch === "function") p.catch(() => {});
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
      /* ignore */
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

function ftApplyMicState() {
  if (!ftStream) return;
  const on = (ftCallState === "active" || ftCallState === "connecting") && !ftMuted;
  ftStream.getAudioTracks().forEach((t) => {
    t.enabled = on;
  });
}

async function ftEnsureMic() {
  if (ftStream) {
    ftApplyMicState();
    return ftStream;
  }
  ftStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: false
  });
  ftApplyMicState();
  return ftStream;
}

function ftAdoptSessionId(data) {
  if (!data?.sessionId) return;
  if (!ftSessionId) {
    ftSessionId = data.sessionId;
    return;
  }
  if (ftSessionId !== data.sessionId && ftRole === "caller") return;
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
  if (!ftPc || ftHandlingOffer || ftRole !== "callee") return;
  const offer = data?.offer;
  if (!offer?.sdp || offer.fromUid !== ftFriendUid) return;
  if (!ftIsCurrentSession(data)) return;
  if (ftPc.signalingState !== "stable") return;

  ftHandlingOffer = true;
  try {
    await ftPc.setRemoteDescription(offer.sdp);
    const answer = await ftPc.createAnswer();
    await ftPc.setLocalDescription(answer);
    await ftWaitIceGathering(ftPc);
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
    console.warn("Friend call answer failed", err);
  } finally {
    ftHandlingOffer = false;
  }
}

async function ftHandleAnswer(data) {
  if (!ftPc || ftRole !== "caller") return;
  const answer = data?.answer;
  const offer = data?.offer;
  if (!answer?.sdp || answer.fromUid !== ftFriendUid) return;
  if (!ftIsCurrentSession(data)) return;
  if (ftPc.signalingState !== "have-local-offer") return;
  if (offer?.at && answer.at && answer.at < offer.at) return;

  try {
    await ftPc.setRemoteDescription(answer.sdp);
    await ftDrainCandidates();
    ftClearOfferTimers();
  } catch (err) {
    console.warn("Friend call set answer failed", err);
  }
}

async function ftSetupPeerConnection(myUid, friendUid) {
  const { ref, onValue, off } = await ftLoadDb();
  const rtdb = ftGetRtdb();
  if (!rtdb) throw new Error("Database not available.");

  ftMyUid = myUid;
  ftFriendUid = friendUid;
  ftSignalPath = ftSignalBase(myUid, friendUid);
  ftConnected = false;
  ftResetIceQueue();

  if (ftPc) {
    ftPc.close();
    ftPc = null;
  }

  ftPc = new RTCPeerConnection({ ...FT_ICE, iceCandidatePoolSize: 10 });
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
      ftClearConnectTimer();
      ftClearDisconnectTimer();
      ftClearOfferTimers();
      ftConnected = true;
      ftCallState = "active";
      ftApplyMicState();
      ftSetStatus("On call");
      ftEmitUi("active", { friendUid: ftFriendUid });
      ftPlayRemote();
      if (typeof window.refreshStatusBar === "function") window.refreshStatusBar();
      if (typeof window.updatePttHint === "function") window.updatePttHint();
    } else if (s === "failed") {
      ftConnected = false;
      void ftEndCall("lost");
    } else if (s === "disconnected") {
      ftClearDisconnectTimer();
      ftDisconnectTimer = setTimeout(() => {
        if (ftPc?.connectionState === "disconnected" || ftPc?.connectionState === "failed") {
          ftConnected = false;
          void ftEndCall("lost");
        }
      }, 6000);
    } else if (s === "connecting") {
      ftCallState = "connecting";
      ftEmitUi("connecting", { friendUid: ftFriendUid });
      ftSetStatus("Connecting…");
      ftStartConnectTimer();
    }
  };

  ftPc.oniceconnectionstatechange = () => {
    const ice = ftPc?.iceConnectionState || "closed";
    if (ice === "connected" || ice === "completed") {
      ftClearConnectTimer();
      ftClearDisconnectTimer();
    }
    if (ice === "failed" && ftPc) {
      if (!ftIceRestarted && typeof ftPc.restartIce === "function") {
        ftIceRestarted = true;
        ftSetStatus("Retrying connection…");
        try {
          ftPc.restartIce();
        } catch {
          void ftEndCall("lost");
        }
        return;
      }
      ftSetStatus("Network blocked call. Try mobile data or WiFi.", true);
      void ftEndCall("lost");
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
}

async function ftCallerCreateOffer() {
  const { ref, update } = await ftLoadDb();
  const rtdb = ftGetRtdb();
  if (!rtdb || !ftPc) return;
  const offer = await ftPc.createOffer({ offerToReceiveAudio: true });
  await ftPc.setLocalDescription(offer);
  await ftWaitIceGathering(ftPc);
  await update(ref(rtdb, ftSignalPath), {
    sessionId: ftSessionId,
    offer: {
      sdp: ftPc.localDescription,
      fromUid: ftMyUid,
      at: Date.now()
    }
  });
}

async function ftWaitForRemoteOffer(rtdb, maxMs = 12000) {
  const { ref, get } = await ftLoadDb();
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    if (!ftPc || ftCallState !== "connecting" || ftRole !== "callee") return false;
    const existing = (await get(ref(rtdb, ftSignalPath))).val();
    ftAdoptSessionId(existing);
    if (existing?.offer?.fromUid === ftFriendUid && ftIsCurrentSession(existing)) {
      await ftHandleOffer(rtdb, existing);
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function ftScheduleOfferResend() {
  ftClearOfferTimers();
  if (ftRole !== "caller" || !ftPc) return;
  ftOfferResendTimer = setTimeout(async () => {
    if (ftCallState !== "connecting" || !ftPc || ftRole !== "caller") return;
    if (ftPc.signalingState !== "have-local-offer") return;
    if (ftPc.connectionState === "connected") return;
    try {
      ftSetStatus("Reconnecting call…");
      await ftCallerCreateOffer();
      ftScheduleOfferResend();
    } catch (err) {
      console.warn("Offer resend failed", err);
    }
  }, 8000);
}

async function ftBeginWebRtc(role) {
  if (!ftMyUid || !ftFriendUid || ftRtcStarted) return;
  ftRtcStarted = true;
  ftStopCallPoll();
  ftRole = role;
  ftCallState = "connecting";
  ftEmitUi("connecting", { friendUid: ftFriendUid, role });

  const path = ftSignalBase(ftMyUid, ftFriendUid);
  ftSignalPath = path;
  if (role === "caller") {
    await ftClearRtcOnly(path);
  }
  await ftSetupPeerConnection(ftMyUid, ftFriendUid);

  if (role === "caller") {
    await ftCallerCreateOffer();
    ftScheduleOfferResend();
  } else {
    const rtdb = ftGetRtdb();
    const { ref, get } = await ftLoadDb();
    const existing = (await get(ref(rtdb, ftSignalPath))).val();
    ftAdoptSessionId(existing);
    if (existing?.offer?.fromUid === ftFriendUid && ftIsCurrentSession(existing)) {
      await ftHandleOffer(rtdb, existing);
    } else {
      const gotOffer = await ftWaitForRemoteOffer(rtdb);
      if (!gotOffer && ftCallState === "connecting") {
        ftSetStatus("Waiting for caller…", true);
      }
    }
  }
  ftWatchCallStatusDuringRtc(ftMyUid, ftFriendUid);
}

async function ftWatchCallStatusDuringRtc(myUid, friendUid) {
  const rtdb = ftGetRtdb();
  if (!rtdb) return;
  const { ref, onValue, off } = await ftLoadDb();
  const statusRef = ref(rtdb, ftCallStatusPath(myUid, friendUid));
  const onStatus = (snap) => {
    const data = snap.val();
    if (!data || !ftStatusMatchesCurrentCall(data)) return;
    if (ftCallState !== "active" && ftCallState !== "connecting") return;
    if (data.status === "ended" || data.status === "cancelled" || data.status === "rejected") {
      void ftEndCall("ended");
    }
  };
  onValue(statusRef, onStatus);
  ftUnsubs.push(() => off(statusRef));
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

async function ftClearInvite(toUid, fromUid) {
  const rtdb = ftGetRtdb();
  if (!rtdb || !toUid || !fromUid) return;
  try {
    const { ref, remove } = await ftLoadDb();
    await remove(ref(rtdb, ftInvitePath(toUid, fromUid)));
  } catch {
    /* ignore */
  }
}

async function ftSetInviteStatus(toUid, fromUid, status, extra = {}) {
  const rtdb = ftGetRtdb();
  if (!rtdb) return;
  const { ref, set, remove } = await ftLoadDb();
  const path = ftInvitePath(toUid, fromUid);
  if (status === "cleared") {
    await remove(ref(rtdb, path));
    return;
  }
  await set(ref(rtdb, path), {
    fromUid,
    toUid,
    status,
    sessionId: ftSessionId,
    at: Date.now(),
    ...extra
  });
}

function ftWatchOutgoingInvite(myUid, friendUid) {
  const rtdb = ftGetRtdb();
  if (!rtdb) return;
  void ftLoadDb().then(({ ref, onValue, off }) => {
    const inviteRef = ref(rtdb, ftInvitePath(friendUid, myUid));
    const onInvite = (snap) => {
      const data = snap.val();
      if (!data || ftRole !== "caller") return;
      if (!ftStatusMatchesCurrentCall(data)) return;
      if (data.status === "accepted" && ftCallState === "outgoing" && !ftRtcStarted) {
        void ftBeginWebRtc("caller");
      } else if (
        ftCallState !== "idle" &&
        (data.status === "rejected" || data.status === "cancelled" || data.status === "ended")
      ) {
        void ftEndCall(data.status === "rejected" ? "declined" : data.status === "cancelled" ? "cancelled" : "ended");
      }
    };
    const onInviteErr = (err) => {
      console.warn("Call invite listener failed", err);
      ftSetStatus(ftFormatError(err), true);
    };
    onValue(inviteRef, onInvite, onInviteErr);
    ftUnsubs.push(() => off(inviteRef));
  });
}

async function ftStartOutgoingCall(myUid, friendUid, friendName) {
  if (!window.RTCPeerConnection) {
    ftSetStatus("Voice calls not supported in this browser.", true);
    return false;
  }
  if (!myUid || !friendUid) return false;
  if (ftCallState !== "idle") return false;

  try {
    await ftResetForNewSession();
    ftMyUid = myUid;
    ftFriendUid = friendUid;
    ftSignalPath = ftSignalBase(myUid, friendUid);
    ftRole = "caller";
    ftSessionId = `ft_${Date.now()}`;
    ftCallState = "outgoing";
    ftMuted = false;

    await ftPrepareNewCall(myUid, friendUid);
    await ftSetCallStatus("ringing", { fromName: friendName || "Friend" });
    await ftSetInviteStatus(friendUid, myUid, "ringing", {
      fromName: friendName || "Friend"
    });
    await ftWatchCallStatus(myUid, friendUid);
    ftWatchOutgoingInvite(myUid, friendUid);
    ftStartCallPoll(myUid, friendUid);
    ftEmitUi("outgoing", { friendUid, friendName });
    ftSetStatus(`Calling ${friendName || "friend"}…`);
    ftStartConnectTimer();
    return true;
  } catch (err) {
    console.warn("Outgoing call failed", err);
    ftSetStatus(ftFormatError(err), true);
    ftCallState = "idle";
    return false;
  }
}

async function ftAcceptCall(fromUid, fromName, myUidOverride) {
  if (!window.RTCPeerConnection) return false;
  const myUid = myUidOverride || ftMyUid;
  if (!myUid || !fromUid) return false;
  if (ftCallState !== "idle" && ftCallState !== "incoming") return false;

  try {
    const rtdb = ftGetRtdb();
    const { ref, get } = await ftLoadDb();
    const inviteSnap = await get(ref(rtdb, ftInvitePath(myUid, fromUid)));
    const invite = inviteSnap.val();

    await ftResetForNewSession();
    ftMyUid = myUid;
    ftFriendUid = fromUid;
    ftSignalPath = ftSignalBase(myUid, fromUid);
    ftRole = "callee";
    ftMuted = false;
    ftSessionId = invite?.sessionId || `ft_${Date.now()}`;
    ftCallState = "connecting";

    await ftPrepareNewCall(myUid, fromUid, { clearRtc: false, clearCallStatus: false });
    await ftSetCallStatus("accepted", {
      fromName: invite?.fromName || fromName || "Friend"
    });
    await ftSetInviteStatus(myUid, fromUid, "accepted", {
      fromName: invite?.fromName || fromName || "Friend"
    });
    ftEmitUi("connecting", { friendUid: fromUid, friendName: fromName || invite?.fromName });
    await ftBeginWebRtc("callee");
    return true;
  } catch (err) {
    console.warn("Accept call failed", err);
    ftSetStatus(ftFormatError(err), true);
    await ftRejectCall(fromUid);
    return false;
  }
}

async function ftRejectCall(fromUid, myUidOverride) {
  const myUid = myUidOverride || ftMyUid;
  if (!myUid || !fromUid) return;
  try {
    if (!ftSignalPath) ftSignalPath = ftSignalBase(myUid, fromUid);
    ftFriendUid = fromUid;
    ftMyUid = myUid;
    ftRole = "callee";
    await ftSetCallStatus("rejected");
    await ftSetInviteStatus(myUid, fromUid, "rejected");
    setTimeout(() => void ftClearInvite(myUid, fromUid), 1500);
  } catch {
    /* ignore */
  }
  if (ftCallState === "incoming") {
    ftCallState = "idle";
    ftFriendUid = null;
    ftEmitUi("ended", { reason: "declined" });
  }
}

async function ftCancelOutgoing() {
  if (ftCallState !== "outgoing" || !ftMyUid || !ftFriendUid) return;
  await ftSetCallStatus("cancelled");
  await ftSetInviteStatus(ftFriendUid, ftMyUid, "cancelled");
  setTimeout(() => void ftClearInvite(ftFriendUid, ftMyUid), 1500);
  await ftEndCall("cancelled");
}

async function ftEndCall(reason = "ended") {
  const myUid = ftMyUid;
  const friendUid = ftFriendUid;
  const path = ftSignalPath;

  if (myUid && friendUid) {
    if (ftCallState === "outgoing") {
      await ftSetCallStatus("cancelled");
      await ftSetInviteStatus(friendUid, myUid, "cancelled");
    } else if (ftCallState === "active" || ftCallState === "connecting") {
      await ftSetCallStatus("ended");
      await ftSetInviteStatus(friendUid, myUid, "ended");
      await ftSetInviteStatus(myUid, friendUid, "ended");
    }
    setTimeout(() => {
      void ftClearInvite(friendUid, myUid);
      void ftClearInvite(myUid, friendUid);
      if (path && ftGetRtdb()) {
        void ftLoadDb().then(({ ref, remove }) => remove(ref(ftGetRtdb(), `${path}/callStatus`)));
      }
    }, 1200);
  }

  ftClearConnectTimer();
  ftClearDisconnectTimer();
  ftClearOfferTimers();
  ftStopCallPoll();
  ftStopUnsubs();
  ftConnected = false;
  ftRtcStarted = false;
  ftIceRestarted = false;
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
  if (path && ftGetRtdb()) {
    await ftClearRtcOnly(path);
  }

  const was = ftCallState;
  ftCallState = "idle";
  ftRole = null;
  ftMyUid = null;
  ftFriendUid = null;
  ftSignalPath = null;
  ftSessionId = null;
  ftMuted = false;

  if (was !== "idle") {
    ftEmitUi("ended", { reason });
    ftSetStatus(reason === "declined" ? "Call declined" : reason === "cancelled" ? "Call cancelled" : "Call ended");
    if (typeof window.refreshStatusBar === "function") window.refreshStatusBar();
    if (typeof window.updatePttHint === "function") window.updatePttHint();
  }
}

function ftStartIncomingListener(myUid) {
  if (ftIncomingWatchUid === myUid) return;
  ftStopIncomingListener();
  ftIncomingWatchUid = myUid;
  const rtdb = ftGetRtdb();
  if (!rtdb || !myUid) return;

  void ftLoadDb().then(({ ref, onValue, off }) => {
    const inboxRef = ref(rtdb, `${FT_INCOMING_PATH}/${myUid}`);
    const onInbox = (snap) => {
      let newest = null;
      let newestUid = null;
      snap.forEach((child) => {
        const data = child.val();
        if (!data) return;
        if (
          ftCallState === "incoming" &&
          child.key === ftFriendUid &&
          (data.status === "cancelled" || data.status === "ended" || data.status === "rejected")
        ) {
          if (ftStatusMatchesCurrentCall(data)) void ftEndCall("cancelled");
          return;
        }
        if (ftCallState !== "idle" || data.status !== "ringing") return;
        const at = Number(data.at || 0);
        if (!newest || at > Number(newest.at || 0)) {
          newest = data;
          newestUid = child.key;
        }
      });
      if (ftCallState === "idle" && newest && newestUid) {
        ftCallState = "incoming";
        ftFriendUid = newestUid;
        ftMyUid = myUid;
        ftSessionId = newest.sessionId || null;
        ftEmitUi("incoming", {
          fromUid: newestUid,
          fromName: newest.fromName || "Friend"
        });
      }
    };
    onValue(inboxRef, onInbox);
    ftIncomingUnsubs.push(() => off(inboxRef));
  });
}

function ftStopIncomingUnsubs() {
  ftIncomingUnsubs.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
  ftIncomingUnsubs = [];
}

function ftStopIncomingListener() {
  ftStopIncomingUnsubs();
  ftIncomingWatchUid = null;
}

async function ftDisconnect(clearSignal = true) {
  const path = ftSignalPath;
  await ftEndCall("ended");
  if (clearSignal && path) await ftClearSignal(path);
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
  ftStopIncomingListener();
  void ftEndCall("ended");
}

function ftIsActive() {
  return ftCallState === "active" && ftConnected;
}

function ftIsConnecting() {
  return ftCallState === "connecting" || ftCallState === "outgoing";
}

function ftIsInCall() {
  return ftCallState === "active" || ftCallState === "connecting" || ftCallState === "outgoing";
}

function ftGetFriendUid() {
  return ftFriendUid;
}

function ftGetCallState() {
  return ftCallState;
}

function ftToggleMute() {
  ftMuted = !ftMuted;
  ftApplyMicState();
  ftEmitUi("mute", { muted: ftMuted });
  return ftMuted;
}

function ftStartTransmit() {
  if (ftCallState === "active" && ftMuted) ftToggleMute();
}

function ftStopTransmit() {
  /* full-duplex — no PTT */
}

window.friendTalk = {
  startOutgoingCall: ftStartOutgoingCall,
  acceptCall: ftAcceptCall,
  rejectCall: ftRejectCall,
  cancelOutgoing: ftCancelOutgoing,
  endCall: ftEndCall,
  connect: async (myUid, friendUid) => ftStartOutgoingCall(myUid, friendUid, ""),
  disconnect: ftDisconnect,
  cleanup: ftCleanup,
  isActive: ftIsActive,
  isConnecting: ftIsConnecting,
  isInCall: ftIsInCall,
  getCallState: ftGetCallState,
  getFriendUid: ftGetFriendUid,
  toggleMute: ftToggleMute,
  startTransmit: ftStartTransmit,
  stopTransmit: ftStopTransmit,
  startIncomingListener: ftStartIncomingListener,
  setStatusCallback: (cb) => {
    ftStatusCb = cb;
  },
  setUiCallback: (cb) => {
    ftUiCb = cb;
  }
};