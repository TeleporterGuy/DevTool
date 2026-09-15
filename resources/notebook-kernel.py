# JSON-lines bridge: DevTool main process <-> jupyter_client / ipykernel.
# stdin commands, stdout events. Keep prints as JSON; diagnostics go to stderr.
#
# Stream / mime caps must stay in sync with src/shared/notebook.ts.
from __future__ import annotations

import atexit
import json
import signal
import sys
import threading
import traceback

STREAM_CHAR_LIMIT = 200_000
MIME_CHAR_LIMIT = 1_500_000
TRUNCATED_MARKER = "\n[truncated]\n"
PNG_OMITTED = "[truncated: image/png omitted (too large)]"


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(code, message):
    emit({"event": "fail", "code": code, "message": message})
    sys.exit(2)


def cap_text(text, limit=STREAM_CHAR_LIMIT):
    if not isinstance(text, str):
        text = str(text)
    if len(text) <= limit:
        return text
    keep = max(0, limit - len(TRUNCATED_MARKER))
    return text[:keep] + TRUNCATED_MARKER


try:
    from jupyter_client import KernelManager
except ImportError:
    fail(
        "missing-jupyter-client",
        "Install jupyter_client and ipykernel in the project conda env, then Restart kernel.\n"
        "  conda install ipykernel jupyter_client",
    )

try:
    import ipykernel  # noqa: F401
except ImportError:
    fail(
        "missing-ipykernel",
        "Install jupyter_client and ipykernel in the project conda env, then Restart kernel.\n"
        "  conda install ipykernel jupyter_client",
    )


km = KernelManager()
kc = None
lock = threading.Lock()
# jupyter msg_id -> {"id": request id, "cellId": cell id}
pending = {}
alive = True
_shutting_down = False


def kernel_pid():
    try:
        provisioner = getattr(km, "provisioner", None)
        if provisioner is not None:
            pid = getattr(provisioner, "pid", None)
            if pid:
                return int(pid)
    except Exception:
        pass
    try:
        kernel = getattr(km, "kernel", None)
        if kernel is not None:
            pid = getattr(kernel, "pid", None)
            if pid:
                return int(pid)
    except Exception:
        pass
    return None


def shutdown():
    """Always stop ipykernel. Safe to call more than once (atexit + signals)."""
    global alive, _shutting_down
    if _shutting_down:
        return
    _shutting_down = True
    alive = False
    try:
        if kc is not None:
            kc.stop_channels()
    except Exception:
        pass
    try:
        km.shutdown_kernel(now=True)
    except Exception:
        pass


def _on_signal(signum, _frame):
    shutdown()
    sys.exit(0)


# Register before start_kernel so SIGTERM during startup still reaps ipykernel.
atexit.register(shutdown)
signal.signal(signal.SIGTERM, _on_signal)
signal.signal(signal.SIGINT, _on_signal)
if hasattr(signal, "SIGBREAK"):
    signal.signal(signal.SIGBREAK, _on_signal)

try:
    km.start_kernel()
    kc = km.client()
    kc.start_channels()
    kc.wait_for_ready(timeout=60)
except Exception as exc:
    try:
        km.shutdown_kernel(now=True)
    except Exception:
        pass
    fail("kernel-start", "Could not start an ipykernel: %s" % exc)


def mime_data(content):
    data = content.get("data") or {}
    out = {}
    omitted_png = False
    for key, value in data.items():
        if isinstance(value, list):
            text = "".join(str(part) for part in value)
        elif isinstance(value, str):
            text = value
        else:
            text = str(value)
        if key == "image/png" and len(text) > MIME_CHAR_LIMIT:
            omitted_png = True
            continue
        out[key] = cap_text(text, MIME_CHAR_LIMIT)
    if omitted_png:
        existing = out.get("text/plain") or ""
        note = (existing + "\n" + PNG_OMITTED) if existing else PNG_OMITTED
        out["text/plain"] = note
    return out


def lookup_request(parent_header):
    msg_id = (parent_header or {}).get("msg_id")
    if not msg_id:
        return None
    with lock:
        return pending.get(msg_id)


def iopub_loop():
    global alive
    while alive:
        try:
            msg = kc.get_iopub_msg(timeout=0.2)
        except Exception:
            continue
        header = msg.get("header") or {}
        msg_type = header.get("msg_type")
        content = msg.get("content") or {}
        parent = msg.get("parent_header") or {}
        req = lookup_request(parent)

        if msg_type == "status":
            state = content.get("execution_state")
            if state in ("starting", "idle", "busy"):
                emit({"event": "status", "execution_state": state})
            continue

        if not req:
            continue
        req_id = req.get("id")
        cell_id = req.get("cellId")

        if msg_type == "stream":
            name = content.get("name") or "stdout"
            if name not in ("stdout", "stderr"):
                name = "stdout"
            text = content.get("text") or ""
            if isinstance(text, list):
                text = "".join(text)
            payload = {
                "event": "stream",
                "id": req_id,
                "name": name,
                "text": cap_text(text),
            }
            if cell_id:
                payload["cellId"] = cell_id
            emit(payload)
        elif msg_type == "execute_result":
            payload = {
                "event": "execute_result",
                "id": req_id,
                "data": mime_data(content),
                "execution_count": content.get("execution_count"),
            }
            if cell_id:
                payload["cellId"] = cell_id
            emit(payload)
        elif msg_type == "display_data":
            payload = {
                "event": "display_data",
                "id": req_id,
                "data": mime_data(content),
            }
            if cell_id:
                payload["cellId"] = cell_id
            emit(payload)
        elif msg_type == "error":
            tb = content.get("traceback") or []
            if not isinstance(tb, list):
                tb = [str(tb)]
            joined = "\n".join(str(line) for line in tb)
            payload = {
                "event": "error",
                "id": req_id,
                "ename": content.get("ename") or "Error",
                "evalue": content.get("evalue") or "",
                "traceback": [cap_text(joined)],
            }
            if cell_id:
                payload["cellId"] = cell_id
            emit(payload)


def shell_loop():
    global alive
    while alive:
        try:
            msg = kc.get_shell_msg(timeout=0.2)
        except Exception:
            continue
        header = msg.get("header") or {}
        if header.get("msg_type") != "execute_reply":
            continue
        parent = msg.get("parent_header") or {}
        jupyter_id = parent.get("msg_id")
        content = msg.get("content") or {}
        with lock:
            req = pending.pop(jupyter_id, None)
        if not req:
            continue
        status = content.get("status") or "ok"
        if status not in ("ok", "error", "abort"):
            status = "ok"
        payload = {
            "event": "execute_reply",
            "id": req.get("id"),
            "status": status,
            "execution_count": content.get("execution_count"),
        }
        if req.get("cellId"):
            payload["cellId"] = req.get("cellId")
        emit(payload)


def handle_command(cmd):
    kind = cmd.get("cmd")
    if kind == "execute":
        req_id = cmd.get("id")
        code = cmd.get("code") or ""
        cell_id = cmd.get("cellId") or ""
        if not req_id:
            return
        jupyter_id = kc.execute(code, store_history=True, allow_stdin=False)
        with lock:
            pending[jupyter_id] = {"id": req_id, "cellId": cell_id}
    elif kind == "interrupt":
        try:
            km.interrupt_kernel()
        except Exception as exc:
            sys.stderr.write("interrupt failed: %s\n" % exc)
            sys.stderr.flush()
    elif kind == "shutdown":
        shutdown()
        emit({"event": "dead", "message": "Kernel shut down."})
        sys.exit(0)
    else:
        sys.stderr.write("unknown cmd: %s\n" % kind)
        sys.stderr.flush()


iopub_thread = threading.Thread(target=iopub_loop, daemon=True)
shell_thread = threading.Thread(target=shell_loop, daemon=True)
iopub_thread.start()
shell_thread.start()

ready = {"event": "ready"}
pid = kernel_pid()
if pid:
    ready["kernel_pid"] = pid
emit(ready)
emit({"event": "status", "execution_state": "idle"})

try:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except Exception:
            sys.stderr.write("bad command json: %s\n" % line[:200])
            sys.stderr.flush()
            continue
        if not isinstance(cmd, dict):
            continue
        handle_command(cmd)
        if not alive:
            break
except Exception:
    traceback.print_exc(file=sys.stderr)
    emit({"event": "dead", "message": "Kernel helper crashed."})
    shutdown()
    sys.exit(1)

shutdown()
