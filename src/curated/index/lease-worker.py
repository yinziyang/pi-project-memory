"""用真实 flock 为整个构建生命周期持有根级协作锁，不通过 PID 文件推测所有权。"""

import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys


def interrupt(_signum, _frame):
    raise InterruptedError("INDEX_CANCELLED")


def main():
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    descriptor = None
    try:
        message = json.loads(sys.stdin.readline())
        root = Path(message["directory"])
        path = root / "build.lock"
        descriptor = os.open(
            path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
        )
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_nlink != 1
            or info.st_mode & 0o077
        ):
            raise ValueError("INDEX_CACHE_UNSAFE")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps({"ok": True, "result": {"held": True}}), flush=True)
        # 原子提交只在此直接子进程内执行，整个 syscall 期间持有同一 flock，实际退出前不得让另一构建越过旧提交。
        committed = False
        for line in sys.stdin:
            request = json.loads(line)
            if (
                committed
                or set(request) != {"op", "temporary"}
                or request["op"] != "commit"
                or not isinstance(request["temporary"], str)
                or re.fullmatch(r"[a-f0-9-]{36}\.tmp", request["temporary"]) is None
            ):
                raise ValueError("INDEX_PROTOCOL_INVALID")
            temporary = root / request["temporary"]
            info = temporary.lstat()
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or info.st_nlink != 1
                or info.st_mode & 0o7777 != 0o600
                or info.st_size > 16384
            ):
                raise ValueError("INDEX_CACHE_UNSAFE")
            os.replace(temporary, root / "ready.json")
            committed = True
            print(json.dumps({"ok": True, "result": {"installed": True}}), flush=True)
    except BlockingIOError:
        print(json.dumps({"ok": False, "code": "INDEX_BUSY"}), flush=True)
        return 1
    except Exception:
        return 1
    finally:
        if descriptor is not None:
            os.close(descriptor)
    return 0


if __name__ == "__main__":
    sys.exit(main())
