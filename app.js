// --------------------------------
// Agent: Desktop-only enforcement
// --------------------------------
(function blockMobileAgents() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("role") !== "agent") return;

    const isMobileOrTablet = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i.test(navigator.userAgent)
        || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) // iPad on iOS 13+
        || window.screen.width < 1024;

    if (isMobileOrTablet) {
        document.getElementById("desktopOnlyBlock").classList.add("visible");
        document.querySelector(".app").style.display = "none";
        document.getElementById("noticeBanner").style.display = "none";
        // Stop all further script execution for this page
        throw new Error("Agent access blocked on mobile/tablet device.");
    }
})();

const SIGNALING_URL = "wss://kyc-video-call-server.onrender.com";

// --------------------------------
// ICE Servers (STUN + TURN)
// --------------------------------
// STUN alone fails on carrier-grade / symmetric NAT (very common on mobile
// data). TURN relays media when a direct P2P path can't be found.
// These are your Metered.ca TURN credentials (500MB/month free trial).
// Note: this is visible in client-side code to anyone who inspects the
// page source -- normal for a small app, but be aware it's not secret.
const ICE_SERVERS = [
    { urls: "stun:stun.relay.metered.ca:80" },
    {
        urls: "turn:global.relay.metered.ca:80",
        username: "0cee67fc19463f44367bd9ed",
        credential: "s20ksF/FcNxluJ/k"
    },
    {
        urls: "turn:global.relay.metered.ca:80?transport=tcp",
        username: "0cee67fc19463f44367bd9ed",
        credential: "s20ksF/FcNxluJ/k"
    },
    {
        urls: "turn:global.relay.metered.ca:443",
        username: "0cee67fc19463f44367bd9ed",
        credential: "s20ksF/FcNxluJ/k"
    },
    {
        urls: "turns:global.relay.metered.ca:443?transport=tcp",
        username: "0cee67fc19463f44367bd9ed",
        credential: "s20ksF/FcNxluJ/k"
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

if (role === "agent") {
    document.getElementById("videoGrid").classList.add("agent-layout");
    document.getElementById("remoteLabel").textContent = "Customer";
    document.getElementById("customerControls").style.display = "none";
    document.getElementById("agentStrip").classList.add("visible");
    document.getElementById("headerCenter").classList.add("visible");
}

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
    if (role === "agent") {
        document.getElementById("startCallStrip").style.display = show ? "none" : "";
        document.getElementById("endCallStrip").style.display   = show ? "" : "none";
        document.getElementById("stripLink").style.display      = show ? "" : "none";
        document.getElementById("stripCopy").style.display      = show ? "" : "none";
    } else {
        const startBtn = document.getElementById("startCall");
        const endBtn   = document.getElementById("endCall");
        startBtn.style.display = "none";
        endBtn.style.display   = show ? "" : "none";
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
        console.log("REMOTE TRACK RECEIVED:", event.track.kind);
        const remoteVideo = document.getElementById("remoteVideo");

        // Audio and video tracks fire separate ontrack events but share the
        // same MediaStream. Only (re)assign srcObject the first time, or
        // every subsequent track aborts the in-flight play() on the prior one.
        if (remoteVideo.srcObject !== event.streams[0]) {
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
        }
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

let currentFacingMode = "user";

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

async function handleFlipCamera() {
    currentFacingMode = currentFacingMode === "user" ? "environment" : "user";
    let newStream;
    try {
        newStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: currentFacingMode },
            audio: true
        });
    } catch (err) {
        console.log("Flip camera failed:", err);
        currentFacingMode = currentFacingMode === "user" ? "environment" : "user"; // revert
        return;
    }

    const newVideoTrack = newStream.getVideoTracks()[0];
    const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === "video");
    if (sender) await sender.replaceTrack(newVideoTrack);

    // stop old tracks and swap local stream
    localStream.getTracks().forEach(t => t.stop());
    localStream = newStream;

    const localVideo = document.getElementById("localVideo");
    localVideo.srcObject = localStream;
}

// --------------------------------
// Geolocation
// --------------------------------
let myGeoLocation = null;

if (role === "agent") {
    document.getElementById("geoPanel").classList.add("visible");
}

function formatGeoValue(lat, lng, accuracy) {
    const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
    return `${lat.toFixed(5)}, ${lng.toFixed(5)} <span style="color:var(--muted);font-size:11px;">(±${Math.round(accuracy)}m)</span> — <a href="${mapsUrl}" target="_blank" rel="noopener">View on Map</a>`;
}

async function captureAndShareGeolocation() {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const { latitude, longitude, accuracy } = position.coords;
            myGeoLocation = { lat: latitude, lng: longitude, accuracy };

            // Show own location if agent
            if (role === "agent") {
                document.getElementById("agentGeoValue").innerHTML = formatGeoValue(latitude, longitude, accuracy);
            }

            // Share with the other participant via signaling server
            if (callId && socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    type: "geo_location",
                    call_id: callId,
                    role,
                    lat: latitude,
                    lng: longitude,
                    accuracy
                }));
            }
        },
        (err) => {
            console.log("Geolocation error:", err.message);
            if (role === "agent") {
                document.getElementById("agentGeoValue").innerHTML = `<span class="geo-status">Permission denied or unavailable</span>`;
            }
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
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
        captureAndShareGeolocation();
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

    if (message.type === "geo_location") {
        // Agent receives customer's location (and vice versa, but only agent shows the panel)
        if (role === "agent" && message.role === "customer") {
            document.getElementById("customerGeoValue").innerHTML = formatGeoValue(message.lat, message.lng, message.accuracy);
        }
        return;
    }

    if (message.type === "flip_camera") {
        if (role === "customer") await handleFlipCamera();
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
        captureAndShareGeolocation();

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
// Capture Photo (agent captures customer's frame)
// --------------------------------
document.getElementById("capturePhotoBtn").onclick = () => {
    const video = document.getElementById("remoteVideo");
    if (!video.srcObject) {
        showNotice("No customer video to capture yet.", { isError: false });
        return;
    }
    const canvas = document.createElement("canvas");
    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 480;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const a = document.createElement("a");
    a.href     = canvas.toDataURL("image/png");
    a.download = `kyc-capture-${Date.now()}.png`;
    a.click();
    showNotice("Photo captured and downloaded.", { isError: false });
};

// --------------------------------
// Flip Camera (agent requests customer to switch camera)
// --------------------------------
document.getElementById("flipCameraBtn").onclick = () => {
    if (!callId || callState !== "connected") {
        showNotice("Call must be connected to flip camera.", { isError: false });
        return;
    }
    socket.send(JSON.stringify({ type: "flip_camera", call_id: callId }));
};

// --------------------------------
// Call Controls
// --------------------------------
const startCallButton      = document.getElementById("startCall");
const endCallButton        = document.getElementById("endCall");
const startCallStripButton = document.getElementById("startCallStrip");
const endCallStripButton   = document.getElementById("endCallStrip");

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

document.getElementById("stripCopy").onclick = async () => {
    const stripLink = document.getElementById("stripLink");
    await navigator.clipboard.writeText(stripLink.value);
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

function doStartCall() {
    if (callState !== "idle") return;

    setCallState("calling");
    callId = generateCallId();

    const customerUrl = `${window.location.origin}/index.html?role=customer&call_id=${callId}`;

    // populate both the old link box and the strip link
    const customerLinkBox = document.getElementById("customerLinkBox");
    const customerLink    = document.getElementById("customerLink");
    customerLink.value            = customerUrl;
    customerLinkBox.style.display = "block";

    const stripLink = document.getElementById("stripLink");
    if (stripLink) stripLink.value = customerUrl;

    if (peerConnection) peerConnection.close();
    peerConnection = createPeerConnection();
    pendingCandidates = [];

    socket.send(JSON.stringify({ type: "call_invitation", call_id: callId }));
    captureAndShareGeolocation();
}

function doEndCall() {
    if (callId) {
        const type = callState === "calling" ? "call_cancelled" : "hangup";
        socket.send(JSON.stringify({ type, call_id: callId }));
    }
    endCall();
}

startCallButton.onclick    = doStartCall;
endCallButton.onclick      = doEndCall;
if (startCallStripButton) startCallStripButton.onclick = doStartCall;
if (endCallStripButton)   endCallStripButton.onclick   = doEndCall;

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

    // Reset geo panel
    if (role === "agent") {
        document.getElementById("agentGeoValue").innerHTML = `<span class="geo-status">Requesting...</span>`;
        document.getElementById("customerGeoValue").innerHTML = `<span class="geo-status">Waiting for customer...</span>`;
    }

    setCallState("idle");
    callId = null;
}

connectSocket();