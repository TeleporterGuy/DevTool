# JSON-lines bridge: DevTool main process <-> jupyter_client / ipykernel.
# stdin commands, stdout events. Keep prints as JSON; diagnostics go to stderr.
from __future__ import annotations

import json
import sys
import threading
import traceback

def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(code, message):
    emit({"event": "fail", "code": code, "message": message})
    sys.exit(2)


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
try:
    km.start_kernel()
    kc = km.client()
    kc.start_channels()
    kc.wait_for_ready(timeout=60)
except Exception as exc:
    fail("kernel-start", "Could not start an ipykernel: %s" % exc)

lock = threading.Lock()
# jupyter msg_id -> DevTool request id
pending = {}
alive = True


def mime_data(content):
    data = content.get("data") or {}
    out = {}
    for key, value in data.items():
        if isinstance(value, list):
            out[key] = "".join(str(part) for part in value)
        elif isinstance(value, str):
            out[key] = value
        else:
            out[key] = str(value)
    return out


def lookup_request_id(parent_header):
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
        req_id = lookup_request_id(parent)

        if msg_type == "status":
            state = content.get("execution_state")
            if state in ("starting", "idle", "busy"):
                emit({"event": "status", "execution_state": state})
            continue

        if not req_id:
            continue

        if msg_type == "stream":
            name = content.get("name") or "stdout"
            if name not in ("stdout", "stderr"):
                name = "stdout"
            text = content.get("text") or ""
            if isinstance(text, list):
                text = "".join(text)
            emit({"event": "stream", "id": req_id, "name": name, "text": text})
        elif msg_type == "execute_result":
            emit({
                "event": "execute_result",
                "id": req_id,
                "data": mime_data(content),
                "execution_count": content.get("execution_count"),
            })
        elif msg_type == "display_data":
            emit({
                "event": "display_data",
                "id": req_id,
                "data": mime_data(content),
            })
        elif msg_type == "error":
            tb = content.get("traceback") or []
            if not isinstance(tb, list):
                tb = [str(tb)]
            emit({
                "event": "error",
                "id": req_id,
                "ename": content.get("ename") or "Error",
                "evalue": content.get("evalue") or "",
                "traceback": [str(line) for line in tb],
            })


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
            req_id = pending.pop(jupyter_id, None)
        if not req_id:
            continue
        status = content.get("status") or "ok"
        if status not in ("ok", "error", "abort"):
            status = "ok"
        emit({
            "event": "execute_reply",
            "id": req_id,
            "status": status,
            "execution_count": content.get("execution_count"),
        })


def shutdown():
    global alive
    alive = False
    try:
        kc.stop_channels()
    except Exception:
        pass
    try:
        km.shutdown_kernel(now=True)
    except Exception:
        pass


def handle_command(cmd):
    kind = cmd.get("cmd")
    if kind == "execute":
        req_id = cmd.get("id")
        code = cmd.get("code") or ""
        if not req_id:
            return
        jupyter_id = kc.execute(code, store_history=True, allow_stdin=False)
        with lock:
            pending[jupyter_id] = req_id
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

emit({"event": "ready"})
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
