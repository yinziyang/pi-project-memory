"""获取 Linux 共享锁后原地执行只读 worker，不保留代理进程。"""

import errno
import fcntl
import os
import sys


# fd 3 与宿主的描述符共享同一打开文件描述；本进程与宿主只关闭各自副本，不主动解锁。
try:
    fcntl.flock(3, fcntl.LOCK_SH | fcntl.LOCK_NB)
except BlockingIOError as error:
    sys.exit(73 if error.errno == errno.EWOULDBLOCK else 74)
except OSError:
    sys.exit(74)

try:
    os.set_inheritable(3, True)
    os.execvp(sys.argv[1], sys.argv[1:])
except OSError:
    sys.exit(74)
