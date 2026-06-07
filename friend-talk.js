/**
 * WhatsApp-style 1:1 friend calls (WebRTC + Firebase RTDB).
 * Ring → Accept/Decline → full-duplex audio/video + optional screen share.
 * Each call uses an isolated session path so stale SDP never blocks connects.
 */

const FT_ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
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
  ],
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require"
};

const FT_CONNECT_TIMEOUT_MS = 50000;
const FT_INCOMING_PATH = "friendIncomingCalls";
const FT_SESSIONS_PATH = "friendCallSessions";

let ftDb = null;
let ftPc = null;
let ftLocalStream = null;
let ftRemoteAudio = null;
let ftRemoteVideo = null;
let ftScreenTrack = null;
let ftMyUid = null;
let ftFriendUid = null;
let ftSessionId = null;
let ftSessionPath = null;
let ftUnsubs = [];
let ftIncomingUnsubs = [];
let ftConnected = false;
let ftStatusCb = null;
let ftUiCb = null;
let ftPendingCandidates = [];
let ftSeenCandidateKeys = new Set();
let ftHandlingOffer = false;
let ftAnswerApplied = false;
let ftRole = null;
let ftCallState = "idle";
let ftCallMode = "audio";
let ftMuted = false;
let ftIncomingWatchUid = null;
let ftConnectTimer = null;
let ftPollTimer = null;
let ftRtcStarted = false;
let ftDisconnectTimer = null;
let ftIceRestarted = false;
let ftOfferResendTimer = null;

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

function ftSessionRoot(sessionId) {
  return `${FT_SESSIONS_PATH}/${sessionId}`;
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
  return msg || "Could not start call.";
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

function ftClearOfferTimer() {
  if (ftOfferResendTimer) clearTimeout(ftOfferResendTimer);
  ftOfferResendTimer = null;
}

function ftClearDisconnectTimer() {
  if (ftDisconnectTimer) clearTimeout(ftDisconnectTimer);
  ftDisconnectTimer = null;
}

function ftCallStatusPath(uid1, uid2) {
  return `${ftSignalBase(uid1, uid2)}/callStatus`;
}

function ftStatusMatchesCurrentCall(data) {
  if (!data) return false;
  if (!ftSessionId) return true;
  return !data.sessionId || data.sessionId === ftSessionId;
}

function ftNewSessionId() {
  return `ft_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function ftPackSdp(desc) {
  if (!desc) return null;
  return { type: desc.type, sdp: desc.sdp };
}

function ftUnpackSdp(packed) {
  if (!packed?.type || !packed?.sdp) return null;
  return new RTCSessionDescription(packed);
}

async function ftResetForNewSession() {
  ftClearConnectTimer();
  ftClearDisconnectTimer();
  ftClearOfferTimer();
  ftStopCallPoll();
  ftStopUnsubs();
  ftConnected = false;
  ftRtcStarted = false;
  ftIceRestarted = false;
  ftHandlingOffer = false;
  ftAnswerApplied = false;
  ftResetIceQueue();
  if (ftScreenTrack) {
    ftScreenTrack.stop();
    ftScreenTrack = null;
  }
  if (ftPc) {
    ftPc.close();
    ftPc = null;
  }
}

async function ftClearSession(sessionId) {
  const rtdb = ftGetRtdb();
  if (!rtdb || !sessionId) return;
  try {
    const { ref, remove } = await ftLoadDb();
    await remove(ref(rtdb, ftSessionRoot(sessionId)));
  } catch {
    /* ignore */
  }
}

async function ftClearInvitesBetween(myUid, friendUid) {
  await ftClearInvite(friendUid, myUid);
  await ftClearInvite(myUid, friendUid);
}

async function ftPrepareOutgoingCall(myUid, friendUid) {
  const rtdb = ftGetRtdb();
  if (!rtdb || !myUid || !friendUid) return;
  const base = ftSignalBase(myUid, friendUid);
  const { ref, remove } = await ftLoadDb();
  await remove(ref(rtdb, `${base}/callStatus`));
  await ftClearInvitesBetween(myUid, friendUid);
}

async function ftWriteSessionMeta(myUid, friendUid, mode) {
  const rtdb = ftGetRtdb();
  if (!rtdb || !ftSessionId) return;
  const { ref, set } = await ftLoadDb();
  await set(ref(rtdb, `${ftSessionPath}/meta`), {
    sessionId: ftSessionId,
    callerUid: myUid,
    calleeUid: friendUid,
    mode: mode || "audio",
    at: Date.now()
  });
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
    callMode: ftCallMode,
    callerUid: ftRole === "caller" ? ftMyUid : ftFriendUid,
    calleeUid: ftRole === "caller" ? ftFriendUid : ftMyUid,
    at: Date.now(),
    ...extra
  });
}

function ftStartConnectTimer() {
  ftClearConnectTimer();
  ftConnectTimer = setTimeout(() => {
    if (ftCallState === "connecting" || (ftCallState === "outgoing" && ftRole === "caller")) {
      ftSetStatus("Call could not connect. Check mic permission & try again.", true);
      void ftEndCall("lost");
    }
  }, FT_CONNECT_TIMEOUT_MS);
}

function ftWaitIceGathering(pc, timeoutMs = 8000) {
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

  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    ftRemoteVideo = document.getElementById("voiceCallRemoteVideo") || ftRemoteVideo;
    if (ftRemoteVideo) {
      ftRemoteVideo.srcObject = stream;
      const vp = ftRemoteVideo.play();
      if (vp && typeof vp.catch === "function") vp.catch(() => {});
      ftEmitUi("remoteVideo", { active: true });
    }
  }
}

function ftHideRemoteVideo() {
  ftRemoteVideo = document.getElementById("voiceCallRemoteVideo") || ftRemoteVideo;
  if (ftRemoteVideo) ftRemoteVideo.srcObject = null;
  const localVid = document.getElementById("voiceCallLocalVideo");
  if (localVid) localVid.srcObject = null;
  const wrap = document.getElementById("voiceCallVideoWrap");
  if (wrap) wrap.classList.remove("show");
  ftEmitUi("remoteVideo", { active: false });
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
  if (!ftLocalStream) return;
  const on = (ftCallState === "active" || ftCallState === "connecting") && !ftMuted;
  ftLocalStream.getAudioTracks().forEach((t) => {
    t.enabled = on;
  });
}

async function ftEnsureLocalMedia(mode = "audio") {
  const wantVideo = mode === "video";
  if (ftLocalStream) {
    const hasVideo = ftLocalStream.getVideoTracks().length > 0;
    if (wantVideo === hasVideo) {
      ftApplyMicState();
      return ftLocalStream;
    }
    ftLocalStream.getTracks().forEach((t) => t.stop());
    ftLocalStream = null;
  }
  const constraints = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: wantVideo ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } : false
  };
  ftLocalStream = await navigator.mediaDevices.getUserMedia(constraints);
  ftApplyMicState();
  return ftLocalStream;
}

async function ftPushCandidate(rtdb, myUid, candidate) {
  const { ref, push, set } = await ftLoadDb();
  const id = push(ref(rtdb, `${ftSessionPath}/candidates/${myUid}`)).key;
  await set(ref(rtdb, `${ftSessionPath}/candidates/${myUid}/${id}`), {
    candidate: candidate.toJSON(),
    fromUid: myUid,
    at: Date.now()
  });
}

async function ftApplyOffer(rtdb, packed, fromUid) {
  if (!ftPc || ftHandlingOffer || ftRole !== "callee" || !packed) return false;
  if (fromUid !== ftFriendUid) return false;
  if (ftPc.signalingState !== "stable") return false;

  ftHandlingOffer = true;
  try {
    ftSetStatus("Answering call…");
    const desc = ftUnpackSdp(packed);
    if (!desc) return false;
    await ftPc.setRemoteDescription(desc);
    const answer = await ftPc.createAnswer();
    await ftPc.setLocalDescription(answer);
    await ftWaitIceGathering(ftPc);
    const { ref, set } = await ftLoadDb();
    await set(ref(rtdb, `${ftSessionPath}/answer`), {
      sdp: ftPackSdp(ftPc.localDescription),
      fromUid: ftMyUid,
      at: Date.now()
    });
    await ftDrainCandidates();
    return true;
  } catch (err) {
    console.warn("Friend call answer failed", err);
    ftSetStatus(ftFormatError(err), true);
    return false;
  } finally {
    ftHandlingOffer = false;
  }
}

async function ftApplyAnswer(packed, fromUid) {
  if (!ftPc || ftRole !== "caller" || ftAnswerApplied || !packed) return false;
  if (fromUid !== ftFriendUid) return false;
  if (ftPc.signalingState !== "have-local-offer") return false;

  try {
    const desc = ftUnpackSdp(packed);
    if (!desc) return false;
    await ftPc.setRemoteDescription(desc);
    await ftDrainCandidates();
    ftAnswerApplied = true;
    ftClearOfferTimer();
    ftSetStatus("Connecting…");
    return true;
  } catch (err) {
    console.warn("Friend call set answer failed", err);
    return false;
  }
}

function ftBindPeerEvents(rtdb, myUid) {
  ftPc.ontrack = (ev) => {
    if (ev.streams?.[0]) {
      ftAttachRemote(ev.streams[0]);
      return;
    }
    if (ev.track) ftAttachRemote(new MediaStream([ev.track]));
  };

  ftPc.onicecandidate = (ev) => {
    if (ev.candidate) void ftPushCandidate(rtdb, myUid, ev.candidate);
  };

  ftPc.onconnectionstatechange = () => {
    const s = ftPc?.connectionState || "closed";
    if (s === "connected") {
      ftClearConnectTimer();
      ftClearDisconnectTimer();
      ftClearOfferTimer();
      ftConnected = true;
      ftCallState = "active";
      ftApplyMicState();
      ftSetStatus("On call");
      ftEmitUi("active", { friendUid: ftFriendUid, callMode: ftCallMode });
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
      }, 8000);
    } else if (s === "connecting") {
      ftCallState = "connecting";
      ftEmitUi("connecting", { friendUid: ftFriendUid, callMode: ftCallMode });
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
    if (ice === "checking") ftSetStatus("Finding network path…");
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
      ftSetStatus("Network blocked call. Try WiFi or mobile data.", true);
      void ftEndCall("lost");
    }
  };
}

async function ftSetupPeerConnection(myUid, friendUid) {
  const rtdb = ftGetRtdb();
  if (!rtdb) throw new Error("Database not available.");

  ftMyUid = myUid;
  ftFriendUid = friendUid;
  ftConnected = false;
  ftAnswerApplied = false;
  ftResetIceQueue();

  if (ftPc) {
    ftPc.close();
    ftPc = null;
  }

  ftPc = new RTCPeerConnection({ ...FT_ICE, iceCandidatePoolSize: 10 });
  const stream = await ftEnsureLocalMedia(ftCallMode);
  stream.getTracks().forEach((t) => ftPc.addTrack(t, stream));
  ftBindPeerEvents(rtdb, myUid);
  if (ftCallMode === "video") {
    const localVid = document.getElementById("voiceCallLocalVideo");
    const wrap = document.getElementById("voiceCallVideoWrap");
    if (localVid) {
      localVid.srcObject = stream;
      const lp = localVid.play();
      if (lp && typeof lp.catch === "function") lp.catch(() => {});
    }
    if (wrap) wrap.classList.add("show");
    const avatar = document.getElementById("voiceCallAvatar");
    if (avatar) avatar.style.display = "none";
  }
  ftEmitUi("localPreview", { stream, callMode: ftCallMode });
}

function ftWatchSessionSignaling(rtdb, myUid, friendUid) {
  const { ref, onValue, off } = ftDb;

  const offerRef = ref(rtdb, `${ftSessionPath}/offer`);
  const onOffer = (snap) => {
    const data = snap.val();
    if (!data?.sdp || !ftPc) return;
    void ftApplyOffer(rtdb, data.sdp, data.fromUid);
  };
  onValue(offerRef, onOffer);
  ftUnsubs.push(() => off(offerRef));

  const answerRef = ref(rtdb, `${ftSessionPath}/answer`);
  const onAnswer = (snap) => {
    const data = snap.val();
    if (!data?.sdp || !ftPc) return;
    void ftApplyAnswer(data.sdp, data.fromUid);
  };
  onValue(answerRef, onAnswer);
  ftUnsubs.push(() => off(answerRef));

  const candRef = ref(rtdb, `${ftSessionPath}/candidates/${friendUid}`);
  const onCand = (snap) => {
    snap.forEach((child) => {
      const item = child.val();
      if (!item?.candidate || !ftPc) return;
      void ftAddRemoteCandidate(item.candidate, child.key);
    });
  };
  onValue(candRef, onCand);
  ftUnsubs.push(() => off(candRef));
}

async function ftCallerCreateOffer() {
  const rtdb = ftGetRtdb();
  if (!rtdb || !ftPc) return;
  const { ref, set } = await ftLoadDb();
  ftSetStatus("Starting call link…");
  const offer = await ftPc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: ftCallMode === "video" });
  await ftPc.setLocalDescription(offer);
  await ftWaitIceGathering(ftPc);
  await set(ref(rtdb, `${ftSessionPath}/offer`), {
    sdp: ftPackSdp(ftPc.localDescription),
    fromUid: ftMyUid,
    at: Date.now()
  });
}

function ftScheduleOfferResend() {
  ftClearOfferTimer();
  if (ftRole !== "caller" || !ftPc) return;
  ftOfferResendTimer = setTimeout(async () => {
    if (ftCallState !== "connecting" || !ftPc || ftRole !== "caller" || ftAnswerApplied) return;
    if (ftPc.signalingState !== "have-local-offer") return;
    try {
      ftSetStatus("Resending call link…");
      await ftCallerCreateOffer();
      ftScheduleOfferResend();
    } catch (err) {
      console.warn("Offer resend failed", err);
    }
  }, 7000);
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
  }, 1200);
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
  onValue(statusRef, onStatus, (err) => {
    console.warn("Call status listener failed", err);
    ftSetStatus(ftFormatError(err), true);
  });
  ftUnsubs.push(() => off(statusRef));
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
    onValue(inviteRef, onInvite, (err) => {
      console.warn("Call invite listener failed", err);
      ftSetStatus(ftFormatError(err), true);
    });
    ftUnsubs.push(() => off(inviteRef));
  });
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

async function ftBeginWebRtc(role) {
  if (!ftMyUid || !ftFriendUid || !ftSessionId || ftRtcStarted) return;
  ftRtcStarted = true;
  ftStopCallPoll();
  ftRole = role;
  ftCallState = "connecting";
  ftSessionPath = ftSessionRoot(ftSessionId);
  ftEmitUi("connecting", { friendUid: ftFriendUid, callMode: ftCallMode, role });

  const rtdb = ftGetRtdb();
  await ftLoadDb();
  await ftSetupPeerConnection(ftMyUid, ftFriendUid);
  ftWatchSessionSignaling(rtdb, ftMyUid, ftFriendUid);

  if (role === "caller") {
    await ftCallerCreateOffer();
    ftScheduleOfferResend();
  } else {
    const { ref, get } = await ftLoadDb();
    const offerSnap = await get(ref(rtdb, `${ftSessionPath}/offer`));
    const offerData = offerSnap.val();
    if (offerData?.sdp) {
      await ftApplyOffer(rtdb, offerData.sdp, offerData.fromUid);
    }
  }

  ftWatchCallStatusDuringRtc(ftMyUid, ftFriendUid);
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
    callMode: ftCallMode,
    at: Date.now(),
    ...extra
  });
}

async function ftStartOutgoingCall(myUid, friendUid, friendName, options = {}) {
  if (!window.RTCPeerConnection) {
    ftSetStatus("Calls not supported in this browser.", true);
    return false;
  }
  if (!myUid || !friendUid) return false;
  if (ftCallState !== "idle") return false;

  const mode = options.video ? "video" : "audio";
  ftCallMode = mode;

  try {
    await ftResetForNewSession();
    ftMyUid = myUid;
    ftFriendUid = friendUid;
    ftRole = "caller";
    ftSessionId = ftNewSessionId();
    ftSessionPath = ftSessionRoot(ftSessionId);
    ftCallState = "outgoing";
    ftMuted = false;

    ftSetStatus("Allow microphone" + (mode === "video" ? " & camera" : "") + "…");
    await ftEnsureLocalMedia(mode);

    await ftPrepareOutgoingCall(myUid, friendUid);
    await ftWriteSessionMeta(myUid, friendUid, mode);
    await ftSetCallStatus("ringing", { fromName: friendName || "Friend" });
    await ftSetInviteStatus(friendUid, myUid, "ringing", {
      fromName: friendName || "Friend"
    });
    await ftWatchCallStatus(myUid, friendUid);
    ftWatchOutgoingInvite(myUid, friendUid);
    ftStartCallPoll(myUid, friendUid);
    ftEmitUi("outgoing", { friendUid, friendName, callMode: mode });
    ftSetStatus(`Calling ${friendName || "friend"}…`);
    ftStartConnectTimer();
    return true;
  } catch (err) {
    console.warn("Outgoing call failed", err);
    ftSetStatus(ftFormatError(err), true);
    ftCallState = "idle";
    ftSessionId = null;
    ftSessionPath = null;
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
    if (!invite?.sessionId) throw new Error("Call invite expired. Ask them to call again.");

    ftCallMode = invite.callMode === "video" ? "video" : "audio";

    await ftResetForNewSession();
    ftMyUid = myUid;
    ftFriendUid = fromUid;
    ftRole = "callee";
    ftMuted = false;
    ftSessionId = invite.sessionId;
    ftSessionPath = ftSessionRoot(ftSessionId);
    ftCallState = "connecting";

    ftSetStatus("Allow microphone" + (ftCallMode === "video" ? " & camera" : "") + "…");
    await ftEnsureLocalMedia(ftCallMode);

    await ftSetCallStatus("accepted", {
      fromName: invite?.fromName || fromName || "Friend"
    });
    await ftSetInviteStatus(myUid, fromUid, "accepted", {
      fromName: invite?.fromName || fromName || "Friend"
    });
    ftEmitUi("connecting", {
      friendUid: fromUid,
      friendName: fromName || invite?.fromName,
      callMode: ftCallMode
    });
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
  const sessionId = ftSessionId;

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
      void ftClearInvitesBetween(myUid, friendUid);
      if (sessionId) void ftClearSession(sessionId);
      if (ftGetRtdb()) {
        void ftLoadDb().then(({ ref, remove }) =>
          remove(ref(ftGetRtdb(), ftCallStatusPath(myUid, friendUid)))
        );
      }
    }, 1500);
  }

  ftClearConnectTimer();
  ftClearDisconnectTimer();
  ftClearOfferTimer();
  ftStopCallPoll();
  ftStopUnsubs();
  ftConnected = false;
  ftRtcStarted = false;
  ftIceRestarted = false;
  ftHandlingOffer = false;
  ftAnswerApplied = false;
  ftResetIceQueue();
  ftHideRemoteVideo();
  if (ftScreenTrack) {
    ftScreenTrack.stop();
    ftScreenTrack = null;
  }
  if (ftLocalStream) {
    ftLocalStream.getTracks().forEach((t) => {
      t.enabled = false;
    });
  }
  if (ftPc) {
    ftPc.close();
    ftPc = null;
  }

  const was = ftCallState;
  ftCallState = "idle";
  ftRole = null;
  ftMyUid = null;
  ftFriendUid = null;
  ftSessionId = null;
  ftSessionPath = null;
  ftCallMode = "audio";
  ftMuted = false;

  if (was !== "idle") {
    ftEmitUi("ended", { reason });
    ftSetStatus(
      reason === "declined"
        ? "Call declined"
        : reason === "cancelled"
          ? "Call cancelled"
          : reason === "lost"
            ? "Call disconnected"
            : "Call ended"
    );
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
        ftCallMode = newest.callMode === "video" ? "video" : "audio";
        ftEmitUi("incoming", {
          fromUid: newestUid,
          fromName: newest.fromName || "Friend",
          callMode: ftCallMode
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

async function ftStartScreenShare() {
  if (ftCallState !== "active" || !ftPc) return false;
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = display.getVideoTracks()[0];
    if (!screenTrack) return false;
    const sender = ftPc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) {
      await sender.replaceTrack(screenTrack);
    } else {
      ftPc.addTrack(screenTrack, display);
    }
    if (ftScreenTrack) ftScreenTrack.stop();
    ftScreenTrack = screenTrack;
    screenTrack.onended = () => void ftStopScreenShare();
    ftEmitUi("screenShare", { active: true });
    ftSetStatus("Sharing screen");
    return true;
  } catch (err) {
    console.warn("Screen share failed", err);
    ftSetStatus("Screen share cancelled.", true);
    return false;
  }
}

async function ftStopScreenShare() {
  if (!ftPc || !ftLocalStream) return;
  const videoTrack = ftLocalStream.getVideoTracks()[0];
  const sender = ftPc.getSenders().find((s) => s.track?.kind === "video");
  if (ftScreenTrack) {
    ftScreenTrack.stop();
    ftScreenTrack = null;
  }
  if (sender && videoTrack) {
    await sender.replaceTrack(videoTrack);
  }
  ftEmitUi("screenShare", { active: false });
  ftSetStatus("On call");
}

async function ftDisconnect() {
  await ftEndCall("ended");
}

function ftCleanup() {
  if (ftLocalStream) {
    ftLocalStream.getTracks().forEach((t) => t.stop());
    ftLocalStream = null;
  }
  if (ftScreenTrack) {
    ftScreenTrack.stop();
    ftScreenTrack = null;
  }
  if (ftRemoteAudio) {
    ftRemoteAudio.srcObject = null;
    ftRemoteAudio.remove();
    ftRemoteAudio = null;
  }
  ftHideRemoteVideo();
  ftRemoteVideo = null;
  const avatar = document.getElementById("voiceCallAvatar");
  if (avatar) avatar.style.display = "";
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

function ftGetCallMode() {
  return ftCallMode;
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
  /* full-duplex */
}

window.friendTalk = {
  startOutgoingCall: ftStartOutgoingCall,
  acceptCall: ftAcceptCall,
  rejectCall: ftRejectCall,
  cancelOutgoing: ftCancelOutgoing,
  endCall: ftEndCall,
  connect: async (myUid, friendUid, opts) => ftStartOutgoingCall(myUid, friendUid, "", opts),
  disconnect: ftDisconnect,
  cleanup: ftCleanup,
  isActive: ftIsActive,
  isConnecting: ftIsConnecting,
  isInCall: ftIsInCall,
  getCallState: ftGetCallState,
  getCallMode: ftGetCallMode,
  getFriendUid: ftGetFriendUid,
  toggleMute: ftToggleMute,
  startScreenShare: ftStartScreenShare,
  stopScreenShare: ftStopScreenShare,
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