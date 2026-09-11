const SIGNALING_URL = "wss://kyc-video-call-server.onrender.com";

// --------------------------------
// ICE Servers (STUN + TURN)
// --------------------------------
// STUN alone fails on carrier-grade / symmetric NAT (very common on mobile
// data). TURN relays media when a direct P2P path can't be found.
// Below uses OpenRelay's free public TURN (no signup) so this works out of
// the box. For production, swap in your own TURN credentials
// (Twilio Network Traversal Service / metered.ca / Cloudflare Calls) since
// public shared TURN has no uptime/bandwidth guarantees.
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
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
];

const CONNECT_TIMEOUT_MS = 20000; // give up waiting for "connected" after this

const params = new URLSearchParams(window.location.search);
const role = params.get("role");
const callIdFromUrl = params.get("call_id");

let callId = callIdFromUrl || null;
let socket;
let reconnectAttempts = 0;
let reconnectTimer = null;

function generateCallId() {
    return crypto.randomUUID();
}

document.getElementById("role").textContent = role === "agent" ? "🧑‍💼 Agent" : "👤 Customer";

const statusDot  = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

const STATUS = {
    idle:         { label: "Ready",         cls: "" },
    calling:      { label: "Calling...",    cls: "" },
    ringing:      { label: "Incoming...",   cls: "" },
    connecting:   { label: "Connecting",    cls: "" },
    connected:    { label: "Live",          cls: "connected" },
    ended:        { label: "Call Ended",    cls: "ended" },
    reconnecting: { label: "Reconnecting...", cls: "" },
};

function updateStatusUI(state) {
    const s = STATUS[state] || STATUS.idle;
    statusText.textContent = s.label;
    statusDot.className = "status-dot " + s.cls;
}

function showEndCallBtn(show) {
    const startBtn = document.getElementById("startCall");
    const endBtn   = document.getElementById("endCall");
    if (role === "customer") {
        startBtn.style.display = "none";
        endBtn.style.display   = show ? "" : "none";
    } else {
        startBtn.style.display = show ? "none" : "";
        endBtn.style.display   = show ? ""     : "none";
    }
}

function hideVideoPlaceholder(videoId, placeholderId) {
    const vid = document.getElementById(videoId);
    const ph  = document.getElementById(placeholderId);
    if (vid.srcObject) ph.style.display = "none";
    else               ph.style.display = "";
}

// --------------------------------
// User-visible notice banner
// (replaces silent console.log-only errors)
// --------------------------------
function showNotice(message, { retry, isError = true } = {}) {
    const banner   = document.getElementById("noticeBanner");
    const text     = document.getElementById("noticeText");
    const retryBtn = document.getElementById("noticeRetryBtn");

    text.textContent = message;
    banner.classList.toggle("notice-error", isError);
    banner.classList.toggle("notice-info", !isError);
    banner.style.display = "flex";

    if (retry) {
        retryBtn.style.display = "";
        retryBtn.onclick = () => {
            hideNotice();
            retry();
        };
    } else {
        retryBtn.style.display = "none";
        retryBtn.onclick = null;
    }
}

function hideNotice() {
    document.getElementById("noticeBanner").style.display = "none";
}

document.getElementById("noticeCloseBtn").onclick = hideNotice;

// --------------------------------
// WebRTC Peer Connection
// --------------------------------
let peerConnection;
let connectTimeoutId = null;

function startConnectTimeout() {
    clearConnectTimeout();
    connectTimeoutId = setTimeout(() => {
        console.log("Connection timed out waiting for ICE to connect");
        showNotice("Connection timed out. This can happen on unstable mobile networks.", {
            retry: () => endCall()
        });
        endCall();
    }, CONNECT_TIMEOUT_MS);
}

function clearConnectTimeout() {
    if (connectTimeoutId) {
        clearTimeout(connectTimeoutId);
        connectTimeoutId = null;
    }
}

function createPeerConnection() {
    console.log("Creating new PeerConnection...");
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.oniceconnectionstatechange = () => {
        console.log("ICE Connection State:", pc.iceConnectionState);

        // Mobile networks commonly flap into "disconnected" during a
        // handoff (WiFi<->cellular, tower change) without the call being
        // truly over. Try an ICE restart before giving up.
        if (pc.iceConnectionState === "disconnected") {
            setTimeout(() => {
                if (pc.iceConnectionState === "disconnected") {
                    console.log("Attempting ICE restart after disconnect...");
                    try {
                        pc.restartIce();
                    } catch (e) {
                        console.log("restartIce not available/failed:", e);
                    }
                }
            }, 2000);
        }

        if (pc.iceConnectionState === "failed") {
            showNotice("Network connection failed. Please retry the call.", {
                retry: () => endCall()
            });
            setCallState("ended");
        }
    };

    pc.onconnectionstatechange = () => {
        console.log("WebRTC Connection State:", pc.connectionState);
        if (pc.connectionState === "connected") {
            clearConnectTimeout();
            setCallState("connected");
        }
        if (pc.connectionState === "failed") {
            showNotice("Call connection failed. Please retry.", { retry: () => endCall() });
            setCallState("ended");
        }
        if (pc.connectionState === "closed") {
            setCallState("ended");
        }
    };

    pc.ontrack = (event) => {
        console.log("REMOTE TRACK RECEIVED:", event);
        const remoteVideo = document.getElementById("remoteVideo");
        remoteVideo.srcObject = event.streams[0];
        hideVideoPlaceholder("remoteVideo", "remotePlaceholder");

        // Some mobile browsers restrict autoplay of unmuted video. Video is
        // muted by default (see index.html) so autoplay is reliable; offer
        // an explicit control to enable sound.
        remoteVideo.play().catch((err) => {
            console.log("Remote video play() blocked:", err);
        });
        const unmuteBtn = document.getElementById("unmuteBtn");
        if (unmuteBtn) unmuteBtn.style.display = "flex";

        console.log("Remote stream attached to video element");
    };

    pc.onicegatheringstatechange = () => {
        console.log("ICE Gathering State:", pc.iceGatheringState);
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.send(JSON.stringify({
                type: "candidate",
                call_id: callId,
                candidate: event.candidate
            }));
        } else {
            console.log("ICE GATHERING COMPLETE");
        }
    };

    return pc;
}

let pendingCandidates = [];
let callState = "idle";

function setCallState(newState) {
    callState = newState;
    console.log("CALL STATE:", callState);
    updateStatusUI(newState);
    showEndCallBtn(newState !== "idle" && newState !== "ended");
}

async function addPendingCandidates() {
    console.log("Adding pending ICE candidates:", pendingCandidates.length);
    for (const candidate of pendingCandidates) {
        try {
            await peerConnection.addIceCandidate(candidate);
        } catch (e) {
            console.log("Failed to add pending ICE candidate:", e);
        }
    }
    pendingCandidates = [];
}

peerConnection = createPeerConnection();

// --------------------------------
// Local Media Stream
// --------------------------------
let localStream;

function describeMediaError(err) {
    switch (err.name) {
        case "NotAllowedError":
            return "Camera/microphone permission was denied. Please allow access and try again.";
        case "NotFoundError":
            return "No camera or microphone found on this device.";
        case "NotReadableError":
            return "Your camera or microphone is already in use by another app. Close it and retry.";
        case "SecurityError":
            return "Camera access requires a secure (HTTPS) connection.";
        default:
            return "Could not access camera/microphone. Please check permissions and try again.";
    }
}

async function startCamera() {
    console.log("Requesting camera and microphone...");
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
        console.error("getUserMedia failed:", err);
        showNotice(describeMediaError(err), { retry: () => endCall() });
        // Let the other side know we can't proceed instead of leaving them hanging.
        if (callId) {
            socket.send(JSON.stringify({ type: "hangup", call_id: callId }));
        }
        endCall();
        throw err; // stop the caller's flow (createOffer/answer) from continuing
    }

    console.log("Camera and microphone access granted");

    const localVideo = document.getElementById("localVideo");
    localVideo.srcObject = localStream;
    hideVideoPlaceholder("localVideo", "localPlaceholder");

    localStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
    });
}

// --------------------------------
// WebSocket connection (with auto-reconnect)
// --------------------------------
showEndCallBtn(false);

function connectSocket() {
    socket = new WebSocket(SIGNALING_URL);

    socket.onopen = async () => {
        console.log("Connected to signaling server");
        reconnectAttempts = 0;
        hideNotice();

        socket.send(JSON.stringify({ type: "register", role: role }));

        if (role === "customer" && callId) {
            if (callState === "idle") {
                // Fresh load of a customer link
                socket.send(JSON.stringify({ type: "call_link_opened", call_id: callId }));
            } else if (callState !== "ended") {
                // We reconnected mid-call: try to reclaim our slot.
                socket.send(JSON.stringify({ type: "join", call_id: callId, role: role }));
            }
        } else if (role === "agent" && callId && callState !== "idle" && callState !== "ended") {
            socket.send(JSON.stringify({ type: "join", call_id: callId, role: role }));
        }

        updateStatusUI(callState === "idle" ? "idle" : callState);
    };

    socket.onmessage = handleSocketMessage;

    socket.onclose = () => {
        console.log("Disconnected from signaling server");
        if (callState !== "idle" && callState !== "ended") {
            updateStatusUI("reconnecting");
            showNotice("Connection lost. Reconnecting...", { isError: false });
        }
        scheduleReconnect();
    };

    socket.onerror = (error) => {
        console.error("WebSocket error:", error);
    };
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 10000);
    console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectSocket();
    }, delay);
}

// --------------------------------
// Agent: Create SDP Offer
// --------------------------------
async function createOffer() {
    console.log("Creating SDP Offer...");
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.send(JSON.stringify({ type: "offer", call_id: callId, sdp: offer.sdp }));
    console.log("SDP Offer sent");
}

// --------------------------------
// Receive signaling messages
// --------------------------------
async function handleSocketMessage(event) {
    const message = JSON.parse(event.data);
    console.log("Received:", message.type);

    if (message.type === "error") {
        console.log("SERVER ERROR:", message);
        handleServerError(message);
        return;
    }

    if (message.type === "call_invitation") {
        callId = message.call_id;
        setCallState("ringing");
        document.getElementById("incomingCall").style.display = "flex";
        return;
    }

    if (message.type === "accept_call") {
        if (message.call_id !== callId) return;
        setCallState("connecting");
        startConnectTimeout();
        try {
            await startCamera();
            await createOffer();
        } catch (e) {
            // Already handled (notice shown, call ended) inside startCamera/createOffer paths
        }
        return;
    }

    if (message.type === "reject_call") {
        if (message.call_id !== callId) return;
        showNotice("The customer declined the call.", { isError: false });
        setCallState("idle");
        callId = null;
        return;
    }

    if (message.type === "call_cancelled") {
        if (message.call_id !== callId) return;
        showNotice("The call was cancelled.", { isError: false });
        document.getElementById("incomingCall").style.display = "none";
        setCallState("idle");
        callId = null;
        return;
    }

    if (message.type === "call_timeout") {
        if (message.call_id !== callId) return;
        showNotice("Customer didn't respond in time. Call ended.", { isError: false });
        document.getElementById("incomingCall").style.display = "none";
        setCallState("idle");
        callId = null;
        return;
    }

    if (message.type === "hangup") {
        if (message.call_id !== callId) return;
        console.log("Other participant ended the call");
        endCall();
        return;
    }

    if (message.type === "candidate") {
        if (message.call_id !== callId) return;

        if (!peerConnection || peerConnection.signalingState === "closed") {
            pendingCandidates.push(message.candidate);
            return;
        }

        if (!peerConnection.remoteDescription) {
            pendingCandidates.push(message.candidate);
            return;
        }

        try {
            await peerConnection.addIceCandidate(message.candidate);
        } catch (e) {
            console.log("Failed to add ICE candidate:", e);
        }
        return;
    }

    if (message.type === "offer") {
        callId = message.call_id;
        setCallState("connecting");
        startConnectTimeout();

        if (peerConnection) peerConnection.close();
        peerConnection = createPeerConnection();

        try {
            await startCamera();
        } catch (e) {
            return; // handled inside startCamera
        }

        await peerConnection.setRemoteDescription({ type: "offer", sdp: message.sdp });
        await addPendingCandidates();

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        socket.send(JSON.stringify({ type: "answer", call_id: callId, sdp: answer.sdp }));
        return;
    }

    if (message.type === "answer") {
        if (message.call_id !== callId) return;
        await peerConnection.setRemoteDescription({ type: "answer", sdp: message.sdp });
        await addPendingCandidates();
        return;
    }
}

function handleServerError(message) {
    const friendly = {
        call_not_found: "This call link is no longer valid.",
        customer_already_joined: "Someone already joined this call from another device.",
        role_already_joined: "This role is already connected elsewhere for this call.",
        invalid_role: "Something went wrong with call setup. Please refresh.",
        call_already_exists: "A call is already in progress."
    };
    showNotice(friendly[message.error] || "Something went wrong. Please refresh and try again.");
    if (callState !== "connected") {
        setCallState("idle");
    }
}

// --------------------------------
// Call Controls
// --------------------------------
const startCallButton = document.getElementById("startCall");
const endCallButton   = document.getElementById("endCall");

document.getElementById("acceptCall").onclick = () => {
    if (!callId) return;
    document.getElementById("incomingCall").style.display = "none";
    setCallState("connecting");
    startConnectTimeout();

    socket.send(JSON.stringify({ type: "join", call_id: callId, role: role }));
    socket.send(JSON.stringify({ type: "accept_call", call_id: callId }));
};

document.getElementById("rejectCall").onclick = () => {
    if (!callId) return;
    socket.send(JSON.stringify({ type: "reject_call", call_id: callId }));
    document.getElementById("incomingCall").style.display = "none";
    setCallState("idle");
    callId = null;
};

document.getElementById("copyLink").onclick = async () => {
    const customerLink = document.getElementById("customerLink");
    await navigator.clipboard.writeText(customerLink.value);
    showNotice("Customer link copied!", { isError: false });
};

const unmuteBtnEl = document.getElementById("unmuteBtn");
if (unmuteBtnEl) {
    unmuteBtnEl.onclick = () => {
        const remoteVideo = document.getElementById("remoteVideo");
        remoteVideo.muted = false;
        remoteVideo.play().catch(() => {});
        unmuteBtnEl.style.display = "none";
    };
}

startCallButton.onclick = async () => {
    if (callState !== "idle") return;

    setCallState("calling");
    callId = generateCallId();

    const customerUrl = `${window.location.origin}/index.html?role=customer&call_id=${callId}`;

    const customerLinkBox = document.getElementById("customerLinkBox");
    const customerLink    = document.getElementById("customerLink");
    customerLink.value            = customerUrl;
    customerLinkBox.style.display = "block";

    if (peerConnection) peerConnection.close();
    peerConnection = createPeerConnection();
    pendingCandidates = [];

    socket.send(JSON.stringify({ type: "call_invitation", call_id: callId }));
};

endCallButton.onclick = () => {
    if (callId) {
        // If we're still just "calling" (no one joined yet), cancel instead
        // of a hangup so any waiting customer gets a clear message.
        const type = callState === "calling" ? "call_cancelled" : "hangup";
        socket.send(JSON.stringify({ type, call_id: callId }));
    }
    endCall();
};

function endCall() {
    clearConnectTimeout();
    setCallState("ended");

    if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
    }

    if (peerConnection) {
        peerConnection.close();
    }

    document.getElementById("localVideo").srcObject  = null;
    document.getElementById("remoteVideo").srcObject = null;
    hideVideoPlaceholder("localVideo",  "localPlaceholder");
    hideVideoPlaceholder("remoteVideo", "remotePlaceholder");
    if (unmuteBtnEl) unmuteBtnEl.style.display = "none";

    setCallState("idle");
    callId = null;
}

connectSocket();
