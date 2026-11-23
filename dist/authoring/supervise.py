"""Linux 写宿主与只读观察子树所有者，继承当前组且只终止自己持有的子进程，不创建 detached 组。"""
import ctypes
import fcntl
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time


def report(code):
    """退出诊断只写固定短事件，不在未消费的管道上无限等待。"""
    target = 2
    data = ('{"kind":"' + code + '"}\n').encode()
    # fd 3 只由直接父宿主读取，Popen 默认 close_fds 会阻止 Bun/Node 后代伪造回收凭证。
    if code == 'HOST_OWNER_REAP_CONFIRMED' and os.environ.get('LOCAL_MEMORY_REAP_FD') == '3':
        target = 3
        data = b'REAP_CONFIRMED\n'
    try:
        if select.select([], [target], [], 0)[1]:
            os.write(target, data)
    except OSError:
        pass  # 退出码仍保留失败，不能为了诊断阻塞实际回收。


def lock_project(path):
    """锁定实际项目目录 inode，不用可被替换的锁文件。"""
    if not os.path.isabs(path) or os.path.realpath(path) != path:
        raise ValueError('PROJECT_DRAFT_PATH')
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # 目录权限位不能反映调用者的实际写权限，由持锁后的文件操作判定。
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        os.close(fd)
        raise
    return fd


def project_rejection(code):
    """在尚未启动写入进程时返回安全拒绝，不等待不消费响应的父端。"""
    try:
        if select.select([], [1], [], 0)[1]:
            os.write(1, ('{"ok":false,"code":"' + code + '"}\n').encode())
    except OSError:
        pass  # 父端拿不到拒绝帧时仍需以退出码识别失败。


def main():
    """正常停止预算为 3 秒，超时转为已报告的保留监管状态，不退出并把未知后代遗弃给 init。"""
    started = time.monotonic()
    mode = sys.argv[2] if len(sys.argv) > 2 else None
    allowed = {'http': 7, 'sdk': 7, 'archive': 7, 'observe': 7, 'index-install': 5, 'manual-draft': 6, 'project-draft': 4}
    if mode not in allowed or len(sys.argv) != allowed[mode]:
        report('HOST_OWNER_ARGUMENTS')
        report('HOST_OWNER_REAP_CONFIRMED')
        return 1
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        report('HOST_OWNER_SUBREAPER_FAILED')
        report('HOST_OWNER_REAP_CONFIRMED')
        return 1
    native_open = getattr(os, 'pidfd_open', None)
    native_send = getattr(signal, 'pidfd_send_signal', None)
    if (native_open is None or native_send is None) and os.uname().machine not in {'x86_64', 'aarch64'}:
        report('HOST_OWNER_PIDFD_UNSUPPORTED')
        report('HOST_OWNER_REAP_CONFIRMED')
        return 1
    libc.syscall.restype = ctypes.c_long

    def checked_syscall(number, *arguments):
        result = libc.syscall(ctypes.c_long(number), *arguments)
        if result == -1:
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
        return result

    def open_pidfd(pid):
        # 部分 uv Python 构建缺少封装，Linux x86_64/aarch64 的内核 ABI 仍提供同一 pidfd 系统调用。
        # 只补语言绑定，不改解释器或退回可被复用的裸 PID 信号。
        return native_open(pid) if native_open else checked_syscall(434, ctypes.c_int(pid), ctypes.c_uint(0))

    def send_pidfd(handle, number):
        if native_send:
            native_send(handle, number)
        else:
            checked_syscall(424, ctypes.c_int(handle), ctypes.c_int(number), ctypes.c_void_p(), ctypes.c_uint(0))

    try:
        os.close(open_pidfd(os.getpid()))
    except OSError:
        report('HOST_OWNER_PIDFD_UNAVAILABLE')
        report('HOST_OWNER_REAP_CONFIRMED')
        return 1
    stop_requested = False

    def request_stop(_number, _frame):
        nonlocal stop_requested
        stop_requested = True

    for number in [signal.SIGTERM, signal.SIGINT]:
        signal.signal(number, request_stop)
    child = None
    project_fd = None
    handles = {}
    shutdown_at = None
    forced = False
    retained_reported = False
    result = 1
    try:
        entries = {
            'sdk': Path(__file__).with_name('sdk-cli.mjs'),
            'http': Path(__file__).with_name('cli.mjs'),
            'archive': Path(__file__).with_name('archive-cli.mjs'),
            'observe': Path(__file__).parent.parent / 'curated' / 'trusted-observation-worker.mjs',
            'index-install': Path(__file__).parent.parent / 'curated' / 'index-install.py',
            'manual-draft': Path(__file__).with_name('manual-draft-cli.mjs'),
            'project-draft': Path(__file__).with_name('project-draft-cli.mjs'),
        }
        args = [sys.argv[1], str(entries[mode]), *sys.argv[3:]]
        if mode == 'project-draft':
            try:
                project_fd = lock_project(sys.argv[3])
            except BlockingIOError:
                project_rejection('PROJECT_DRAFT_BUSY')
                report('HOST_OWNER_REAP_CONFIRMED')
                return 1
            except (OSError, ValueError):
                project_rejection('PROJECT_DRAFT_UNAVAILABLE')
                report('HOST_OWNER_REAP_CONFIRMED')
                return 1
            if stop_requested:
                project_rejection('PROJECT_DRAFT_FAILED')
                report('HOST_OWNER_REAP_CONFIRMED')
                return 1
            child = subprocess.Popen([*args, str(project_fd)], pass_fds=(project_fd,))
        else:
            child = subprocess.Popen(args)
        handles[child.pid] = open_pidfd(child.pid)
        while True:
            now = time.monotonic()
            status = child.poll()
            if stop_requested or now - started >= ({'index-install': 900, 'manual-draft': 15, 'project-draft': 30}.get(mode, 3600)) or status is not None:
                if shutdown_at is None:
                    shutdown_at = now
                    if status is not None:
                        result = status if status >= 0 else 128 - status
            # 本专用所有者不启动其他工作，direct children 只可能是 Bun 或被 subreaper 收养的自有后代。
            children = Path(f'/proc/self/task/{os.getpid()}/children').read_text().split()
            for text in children:
                pid = int(text)
                if pid not in handles:
                    try:
                        handles[pid] = open_pidfd(pid)
                    except ProcessLookupError:
                        continue
            if shutdown_at is not None:
                number = signal.SIGKILL if now - shutdown_at >= 0.2 else signal.SIGTERM
                for handle in handles.values():
                    try:
                        send_pidfd(handle, number)
                        forced = forced or number == signal.SIGKILL
                    except ProcessLookupError:
                        pass  # 仍需 waitpid 确认回收，不能把发信号当作结束。
            # Popen 先负责其直接 child，其他被领养子进程逐项 waitpid，不触碰共享进程组。
            child.poll()
            if child.returncode is not None:
                try:
                    while os.waitpid(-1, os.WNOHANG)[0]:
                        pass
                except ChildProcessError:
                    if shutdown_at is not None:
                        if forced:
                            report('HOST_OWNER_FORCED_REAP')
                        report('HOST_OWNER_REAP_CONFIRMED')
                        return result
            if shutdown_at is not None and now - shutdown_at > 3 and not retained_reported:
                # 父宿主会在自己的 4 秒预算返回未确认，现有监管进程保留 pidfd 且不再启动任何工作。
                # 只有实际 ECHILD 后才退出，不能让监管 PID 的消失冒充不可杀死后代已回收。
                report('HOST_OWNER_REAP_UNCONFIRMED')
                retained_reported = True
                result = 1
            time.sleep(0.01)
    except Exception:
        report('HOST_OWNER_FAILED')
        if child is None:
            report('HOST_OWNER_REAP_CONFIRMED')
            return 1
        deadline = time.monotonic() + 3
        reported = False
        # 监管本身故障也不能先退出遗弃后代，父宿主有界返回失败，本进程只保留回收职责。
        while True:
            try:
                if child.poll() is None:
                    child.kill()
                for text in Path(f'/proc/self/task/{os.getpid()}/children').read_text().split():
                    try:
                        handle = open_pidfd(int(text))
                    except ProcessLookupError:
                        continue
                    try:
                        send_pidfd(handle, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    finally:
                        os.close(handle)
                child.poll()
                if child.returncode is not None:
                    try:
                        while os.waitpid(-1, os.WNOHANG)[0]:
                            pass
                    except ChildProcessError:
                        report('HOST_OWNER_REAP_CONFIRMED')
                        return 1
            except (OSError, ValueError):
                pass  # 原监管故障已经报告，继续保留所有权并重试回收，不新增进程或清空已知句柄。
            if time.monotonic() > deadline and not reported:
                report('HOST_OWNER_REAP_UNCONFIRMED')
                reported = True
            time.sleep(0.05)
    finally:
        for handle in handles.values():
            os.close(handle)
        # 只有实际回收子树后才释放目录锁，绝不在报告未确认时提前解锁。
        if project_fd is not None:
            os.close(project_fd)


if __name__ == '__main__':
    raise SystemExit(main())
