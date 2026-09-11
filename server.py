import asyncio
import json
import os
import time
import websockets


calls = {}

RING_TIMEOUT_SECONDS = 45     # how long a customer has to accept/reject
REAP_INTERVAL_SECONDS = 10    # how often the background sweep runs
PING_TIMEOUT_SECONDS = 4      # how long we wait for a pong before treating a socket as dead


def cleanup_call(call_id):
    if call_id in calls:
        del calls[call_id]
        print(f"Call cleaned up: {call_id}")


async def is_alive(ws):
    """Best-effort liveness check. Mobile connections often go silent
    without a clean close, so we actively ping instead of trusting that a
    socket object still being in memory means it's actually connected."""
    try:
        pong_waiter = await ws.ping()
        await asyncio.wait_for(pong_waiter, timeout=PING_TIMEOUT_SECONDS)
        return True
    except Exception:
        return False


async def safe_send(ws, payload):
    try:
        await ws.send(json.dumps(payload))
        return True
    except websockets.exceptions.ConnectionClosed:
        return False


async def reap_stale_calls():
    """Periodic background sweep so a phone that dies silently (screen
    lock, dropped signal, backgrounded tab) doesn't leave the other party
    or the call state stuck forever."""
    while True:
        await asyncio.sleep(REAP_INTERVAL_SECONDS)

        now = time.time()

        for call_id in list(calls.keys()):
            call = calls.get(call_id)
            if not call:
                continue

            # Unanswered ringing call has timed out
            ring_started_at = call.get("ring_started_at")
            if ring_started_at and (now - ring_started_at) > RING_TIMEOUT_SECONDS:
                agent = call.get("agent")
                if agent:
                    await safe_send(agent, {"type": "call_timeout", "call_id": call_id})
                pending = call.get("pending_customer")
                if pending:
                    await safe_send(pending, {"type": "call_timeout", "call_id": call_id})
                print(f"Call timed out waiting for customer: {call_id}")
                cleanup_call(call_id)
                continue

            # Check liveness of active participants (agent/customer keys only)
            for participant_role in ("agent", "customer"):
                client = call.get(participant_role)
                if not client:
                    continue

                if not await is_alive(client):
                    print(f"Reaper found dead {participant_role} on call {call_id}")
                    other_role = "customer" if participant_role == "agent" else "agent"
                    other_client = call.get(other_role)
                    if other_client:
                        await safe_send(other_client, {"type": "hangup", "call_id": call_id})
                    cleanup_call(call_id)
                    break


async def handle_client(websocket):

    print("Client connected")

    call_id = None
    role = None

    try:

        async for raw_message in websocket:

            message = json.loads(raw_message)
            message_type = message.get("type")
            message_call_id = message.get("call_id")

            print(f"Received: {message_type}")

            # --------------------------------
            # REGISTER CLIENT
            # --------------------------------
            if message_type == "register":
                role = message.get("role")
                print(f"Client registered as: {role}")
                continue

            # --------------------------------
            # CUSTOMER OPENS CALL LINK
            # --------------------------------
            if message_type == "call_link_opened":
                call_id = message_call_id
                call = calls.get(call_id)

                if not call:
                    await websocket.send(json.dumps({
                        "type": "error", "error": "call_not_found", "call_id": call_id
                    }))
                    continue

                if "customer" in call:
                    # Only reject if the existing customer socket is actually alive.
                    if await is_alive(call["customer"]):
                        await websocket.send(json.dumps({
                            "type": "error", "error": "customer_already_joined", "call_id": call_id
                        }))
                        continue
                    else:
                        print(f"Evicting stale customer on call: {call_id}")
                        del call["customer"]

                call["pending_customer"] = websocket
                call["ring_started_at"] = time.time()

                await websocket.send(json.dumps({"type": "call_invitation", "call_id": call_id}))
                continue

            # --------------------------------
            # JOIN CALL
            # --------------------------------
            if message_type == "join":

                requested_role = message.get("role")

                if message_call_id not in calls:
                    await websocket.send(json.dumps({
                        "type": "error", "error": "call_not_found", "call_id": message_call_id
                    }))
                    continue

                if requested_role not in ("agent", "customer"):
                    await websocket.send(json.dumps({
                        "type": "error", "error": "invalid_role", "call_id": message_call_id
                    }))
                    continue

                call = calls[message_call_id]

                if requested_role in call and call[requested_role] is not websocket:
                    # Allow takeover if the existing socket is actually dead
                    # (handles reconnects after a silent mobile drop).
                    if await is_alive(call[requested_role]):
                        await websocket.send(json.dumps({
                            "type": "error", "error": "role_already_joined", "call_id": message_call_id
                        }))
                        continue
                    else:
                        print(f"Evicting stale {requested_role} on call: {message_call_id}")

                call_id = message_call_id
                role = requested_role
                call[role] = websocket

                if requested_role == "customer":
                    call.pop("pending_customer", None)
                    call.pop("ring_started_at", None)

                print("Current call participants:", list(k for k in call.keys() if k in ("agent", "customer")))
                continue

            # --------------------------------
            # CALL INVITATION (agent creates a call)
            # --------------------------------
            if message_type == "call_invitation":
                call_id = message_call_id

                if call_id in calls:
                    await websocket.send(json.dumps({
                        "type": "error", "error": "call_already_exists", "call_id": call_id
                    }))
                    continue

                calls[call_id] = {"agent": websocket, "created_at": time.time()}
                role = "agent"
                print(f"Call created: {call_id}")
                continue

            # --------------------------------
            # ACCEPT CALL
            # --------------------------------
            if message_type == "accept_call":
                call = calls.get(message_call_id)
                if not call:
                    continue
                agent = call.get("agent")
                if agent:
                    await safe_send(agent, message)
                continue

            # --------------------------------
            # REJECT CALL
            # --------------------------------
            if message_type == "reject_call":
                call = calls.get(message_call_id)
                if not call:
                    continue
                agent = call.get("agent")
                if agent:
                    await safe_send(agent, message)
                cleanup_call(message_call_id)
                continue

            # --------------------------------
            # CANCEL CALL (agent cancels before customer accepts)
            # --------------------------------
            if message_type == "call_cancelled":
                call = calls.get(message_call_id)
                if not call:
                    continue
                pending = call.get("pending_customer")
                if pending:
                    await safe_send(pending, message)
                cleanup_call(message_call_id)
                continue

            # --------------------------------
            # HANGUP CALL
            # --------------------------------
            if message_type == "hangup":
                call = calls.get(message_call_id)
                if not call:
                    continue
                for participant_role, client in list(call.items()):
                    if participant_role in ("agent", "customer") and client != websocket:
                        await safe_send(client, message)
                cleanup_call(message_call_id)
                continue

            # --------------------------------
            # OTHER SIGNALING: OFFER / ANSWER / CANDIDATE
            # --------------------------------
            if not call_id:
                continue

            call = calls.get(call_id)
            if not call:
                continue

            for participant_role, client in list(call.items()):
                if participant_role in ("agent", "customer") and client != websocket:
                    await safe_send(client, message)

    except websockets.exceptions.ConnectionClosed:
        print("Client disconnected")

    finally:

        if call_id and call_id in calls:
            call = calls[call_id]

            if call.get("pending_customer") == websocket:
                print(f"Pending customer disconnected from call: {call_id}")
                del call["pending_customer"]
                call.pop("ring_started_at", None)

            elif role in ("agent", "customer") and call.get(role) == websocket:
                print(f"Active participant disconnected: {role}, {call_id}")

                for participant_role, client in list(call.items()):
                    if participant_role in ("agent", "customer") and participant_role != role:
                        await safe_send(client, {"type": "hangup", "call_id": call_id})

                del call[role]
                cleanup_call(call_id)

        print(f"Removed {role} from call {call_id}")


async def main():

    PORT = int(os.environ.get("PORT", 8765))

    reaper_task = asyncio.create_task(reap_stale_calls())

    async with websockets.serve(handle_client, "0.0.0.0", PORT):
        print(f"Signaling server running on port {PORT}")
        await asyncio.Future()

    reaper_task.cancel()


asyncio.run(main())
