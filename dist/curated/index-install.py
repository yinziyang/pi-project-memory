"""Linux 用户级索引安装入口：python3 -I index-install.py HOME PACKAGE_ROOT。

调用方须提供可信的包目录和 PATH，并通过 authoring/supervise.py 的 index-install 模式启动。
本脚本只负责安装和 stdout 上的单条 JSON 结果，外层负责整体时限、取消和后代回收确认。
"""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request


REPO = 'Xenova/multilingual-e5-small'
REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
MODEL_FILES = {
    'config.json', 'tokenizer.json', 'tokenizer_config.json',
    'special_tokens_map.json', 'onnx/model.onnx',
}
CHROMA_VERSION = '1.5.9'
RECEIPT = 'index-receipt.json'
PART = '.index-install.part'
CHUNK = 1024 * 1024
# 不将工具输出或异常内容透传到公开协议。
ERROR_CODES = {
    'UNSAFE_PATH', 'MANIFEST_INVALID', 'MODEL_DOWNLOAD_FAILED', 'UV_UNAVAILABLE',
    'PYTHON_UNAVAILABLE', 'CHROMA_FAILED', 'BUSY', 'FAILED',
    'INVALID_ARGUMENTS', 'EXISTING_ASSET_INVALID',
}


class InstallError(Exception):
    """仅携带可公开的固定错误码。"""


def local_stat(path: Path, directory: bool) -> os.stat_result:
    info = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if (not kind(info.st_mode) or info.st_uid != os.geteuid()
            or info.st_mode & 0o022 or (not directory and info.st_nlink != 1)):
        raise InstallError('UNSAFE_PATH')
    return info


def make_dir(path: Path) -> Path:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass  # 锁前可能有另一安装器创建同一目录，必须按相同规则重新校验。
    local_stat(path, directory=True)
    return path


def read_manifest(package: Path) -> list[tuple[str, int, str]]:
    here = Path(__file__).resolve().parent
    manifest = (here / 'e5-model-manifest.json' if here == package / 'src' / 'curated'
                else package / 'dist' / 'curated' / 'e5-model-manifest.json')
    try:
        with manifest.open('rb') as stream:
            raw = stream.read(16385)
        if len(raw) > 16384:
            raise ValueError
        data = json.loads(raw)
        if (data['repo'] != REPO or data['revision'] != REVISION
                or data['complete'] is not True):
            raise ValueError
        files = data['files']
        if not isinstance(files, list) or len(files) != len(MODEL_FILES):
            raise ValueError
        entries = []
        for entry in files:
            name, size, digest = entry['path'], entry['bytes'], entry['sha256']
            if (name not in MODEL_FILES or type(size) is not int or not 0 < size <= 512 * CHUNK
                    or not re.fullmatch('[a-f0-9]{64}', digest)):
                raise ValueError
            entries.append((name, size, digest))
        if {name for name, _, _ in entries} != MODEL_FILES:
            raise ValueError
        return entries
    except (OSError, ValueError, TypeError, KeyError, RecursionError) as exc:
        raise InstallError('MANIFEST_INVALID') from exc


def unlink_managed(path: Path) -> None:
    try:
        local_stat(path, directory=False)
        path.unlink()
    except FileNotFoundError:
        pass  # 首次安装和上次未创建时没有遗留文件。


def verified(path: Path, size: int, digest: str) -> bool:
    try:
        if local_stat(path, directory=False).st_size != size:
            return False
    except FileNotFoundError:
        return False
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        remaining = size
        while remaining:
            part = stream.read(min(remaining, CHUNK))
            if not part:
                return False
            hasher.update(part)
            remaining -= len(part)
        return not stream.read(1) and hasher.hexdigest() == digest


class HttpsRedirect(urllib.request.HTTPRedirectHandler):
    """在 urllib 发送重定向请求之前拒绝降级和 URL 中的凭据。"""

    max_redirections = 6

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        if (target.scheme != 'https' or not target.hostname
                or target.username is not None or target.password is not None):
            raise InstallError('MODEL_DOWNLOAD_FAILED')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def atomic_publish(part: Path, target: Path) -> None:
    os.replace(part, target)
    fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def download(target: Path, name: str, size: int, digest: str) -> None:
    part = target.parent / PART
    unlink_managed(part)
    hasher = hashlib.sha256()
    request = urllib.request.Request(
        f'https://huggingface.co/{REPO}/resolve/{REVISION}/{name}',
        headers={'Accept-Encoding': 'identity'},
    )
    # 不继承代理或 netrc，官方 CDN 的跳转仍受 TLS、大小及摘要校验约束。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), HttpsRedirect())
    try:
        with opener.open(request, timeout=20) as response, part.open('xb') as stream:
            if response.status != 200:
                raise InstallError('MODEL_DOWNLOAD_FAILED')
            remaining = size
            while remaining:
                block = response.read(min(remaining, CHUNK))
                if not block:
                    raise InstallError('MODEL_DOWNLOAD_FAILED')
                hasher.update(block)
                stream.write(block)
                remaining -= len(block)
            if response.read(1) or hasher.hexdigest() != digest:
                raise InstallError('MODEL_DOWNLOAD_FAILED')
            stream.flush()
            os.fsync(stream.fileno())
        atomic_publish(part, target)
    except (OSError, ValueError, urllib.error.URLError) as exc:
        raise InstallError('MODEL_DOWNLOAD_FAILED') from exc
    finally:
        unlink_managed(part)


def install_models(root: Path, entries: list[tuple[str, int, str]]) -> None:
    repo = make_dir(make_dir(make_dir(root / 'models') / 'Xenova') / 'multilingual-e5-small')
    for name, size, digest in entries:
        target = repo / name
        if target.parent != repo:
            make_dir(target.parent)
        unlink_managed(target.parent / PART)
        if not verified(target, size, digest):
            if target.exists():
                raise InstallError('EXISTING_ASSET_INVALID')
            download(target, name, size, digest)


def trusted_executable(path: Path) -> Path:
    """允许受信工具的系统或用户链接，但检查链接所在目录和真实目标。"""
    owners = {0, os.geteuid()}
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError
    for item in (path, *path.parents):
        info = item.lstat()
        if info.st_uid not in owners:
            raise ValueError
        real = item.resolve(strict=True)
        for resolved in (real, *real.parents):
            info = resolved.stat()
            if info.st_uid not in owners or (info.st_mode & 0o022 and not (
                    stat.S_ISDIR(info.st_mode) and info.st_mode & stat.S_ISVTX)):
                raise ValueError
    real = path.resolve(strict=True)
    if not real.is_file() or not os.access(real, os.X_OK):
        raise ValueError
    return real


def find_uv() -> Path:
    for entry in os.environ.get('PATH', '').split(os.pathsep):
        try:
            return trusted_executable(Path(entry) / 'uv')
        except (OSError, RuntimeError, ValueError):
            continue
    raise InstallError('UV_UNAVAILABLE')


def ensure_venv_tree(venv: Path) -> None:
    """启动解释器前拒绝虚拟环境中可能劫持导入的链接和不安全文件。"""
    local_stat(venv, directory=True)
    pending = [venv]
    while pending:
        for child in pending.pop().iterdir():
            directory = stat.S_ISDIR(child.lstat().st_mode)
            local_stat(child, directory=directory)
            if directory:
                pending.append(child)


def run_tool(args, *, capture=False, **kwargs) -> subprocess.CompletedProcess:
    result = subprocess.run(args, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, **kwargs)
    return result


def probe(python: Path, root: Path, env: dict[str, str]) -> bool:
    try:
        local_stat(python, directory=False)
        result = run_tool([
            python, '-IB', '-c',
            'import sys; sys.exit(1) if sys.version_info[:2] != (3, 13) else None; '
            'import chromadb; '
            f'sys.exit(0 if chromadb.__version__ == {CHROMA_VERSION!r} else 1)',
        ], cwd=root, env=env)
        return result.returncode == 0
    except OSError:
        return False


# Linux 上的 uv Python 可能从解释器旁的 lib 目录加载 libpython，单复制解释器不够。
CREATE_VENV = """
import pathlib
import shutil
import sys
import sysconfig
import venv

root = pathlib.Path(sys.argv[1])
if sys.version_info[:2] != (3, 13):
    sys.exit(1)

class IndexVenv(venv.EnvBuilder):
    # 安装器只发布 Python 入口，不生成引用暂存目录的激活脚本。
    def setup_scripts(self, context):
        pass

IndexVenv(symlinks=False).create(root)
libname = sysconfig.get_config_var('INSTSONAME')
libdir = sysconfig.get_config_var('LIBDIR')
if libname and libdir:
    shared = pathlib.Path(libdir) / libname
    if shared.is_file():
        shutil.copyfile(shared, root / 'lib' / shared.name)
"""


def unlink_uv_stage_lock(stage: Path) -> None:
    # uv 特意将暂存锁设为 0666；只删除私有暂存目录内属于当前用户的普通单链接文件。
    local_stat(stage, directory=True)
    lock = stage / '.lock'
    try:
        info = lock.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
        raise InstallError('UNSAFE_PATH')
    lock.unlink()


def install_chroma(home: Path, root: Path, package: Path, install_lock: int) -> None:
    venv = root / 'venv'
    python = venv / 'bin' / 'python'
    env = {
        'HOME': str(home), 'PATH': os.defpath, 'LANG': 'C.UTF-8',
        'UV_PYTHON_DOWNLOADS': 'never', 'UV_PROJECT_ENVIRONMENT': str(venv),
        'UV_LINK_MODE': 'copy', 'ANONYMIZED_TELEMETRY': 'False',
    }
    existing = venv.exists() or venv.is_symlink()
    if existing:
        ensure_venv_tree(venv)
        if probe(python, root, env):
            return
        raise InstallError('EXISTING_ASSET_INVALID')
    stage = root / '.index-venv-install'
    staged_python = stage / 'bin' / 'python'
    env['UV_PROJECT_ENVIRONMENT'] = str(stage)
    uv = find_uv()
    if not all((package / name).is_file() for name in ('pyproject.toml', 'uv.lock')):
        raise InstallError('CHROMA_FAILED')
    try:
        found = run_tool([uv, '--no-config', '--no-python-downloads', 'python',
                          'find', '--system', '3.13'], capture=True, cwd=root, env=env)
        if found.returncode or not 0 < len(found.stdout) <= 4096:
            raise ValueError
        executable = trusted_executable(Path(os.fsdecode(found.stdout.rstrip(b'\n'))))
    except (OSError, RuntimeError, ValueError) as exc:
        raise InstallError('PYTHON_UNAVAILABLE') from exc
    try:
        # 只恢复安装器自己的暂存目录，绝不删除或重建已经发布的 venv。
        if stage.exists() or stage.is_symlink():
            unlink_uv_stage_lock(stage)
            ensure_venv_tree(stage)
            shutil.rmtree(stage)
        # 预建目录，避免 venv 创建 lib64 链接后被取消，导致暂存目录无法安全回收。
        make_dir(make_dir(stage) / 'lib64')
        # 让直接写入暂存目录的命令持有同一把锁，避免 worker 先被终止时并发接管暂存目录。
        create = run_tool([executable, '-IB', '-c', CREATE_VENV, stage], cwd=root, env=env,
                          pass_fds=(install_lock,))
        if create.returncode:
            raise InstallError('CHROMA_FAILED')
        ensure_venv_tree(stage)
        sync = run_tool([
            uv, '--no-config', '--no-python-downloads', '--no-cache', 'sync', '--locked',
            '--no-dev', '--no-install-project', '--python', staged_python,
        ], cwd=package, env=env, pass_fds=(install_lock,))
        if sync.returncode:
            raise InstallError('CHROMA_FAILED')
        unlink_uv_stage_lock(stage)
        ensure_venv_tree(stage)
        if not probe(staged_python, root, env):
            raise InstallError('CHROMA_FAILED')
        # 只承诺 venv/bin/python 入口，暂存环境通过探测后才发布到固定路径。
        atomic_publish(stage, venv)
        env['UV_PROJECT_ENVIRONMENT'] = str(venv)
        if not probe(python, root, env):
            raise InstallError('CHROMA_FAILED')
    except OSError as exc:
        raise InstallError('CHROMA_FAILED') from exc


def validate_receipt(receipt: Path) -> bool:
    try:
        info = local_stat(receipt, directory=False)
    except FileNotFoundError:
        return False
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise InstallError('UNSAFE_PATH')
    with receipt.open('rb') as stream:
        raw = stream.read(257)
    if len(raw) > 256 or not re.fullmatch(rb'[ \t\r\n]*\{[ \t\r\n]*"version"[ \t\r\n]*:[ \t\r\n]*1[ \t\r\n]*\}[ \t\r\n]*', raw):
        raise InstallError('EXISTING_ASSET_INVALID')
    return True


def install(home_arg: str, package_arg: str) -> None:
    home_path, package_path = Path(home_arg), Path(package_arg)
    if not home_path.is_absolute() or not package_path.is_absolute():
        raise InstallError('UNSAFE_PATH')
    home = home_path.resolve(strict=True)
    local_stat(home, directory=True)
    package = package_path.resolve(strict=True)
    root = make_dir(make_dir(make_dir(home / '.local') / 'share') / 'local-project-memory')
    if stat.S_IMODE(local_stat(root, directory=True).st_mode) != 0o700:
        raise InstallError('UNSAFE_PATH')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # 对根目录 inode 取锁，避免替换锁文件后出现两个安装所有者。
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise InstallError('BUSY') from exc
        receipt = root / RECEIPT
        part = root / PART
        already_published = validate_receipt(receipt)
        unlink_managed(part)
        install_models(root, read_manifest(package))
        install_chroma(home, root, package, fd)
        # 复验期间保留旧凭证，既有资产失效时只报错，由运行时校验负责降级。
        if already_published:
            return
        # 两项校验完成后才发布唯一就绪凭证，外层仍须确认整个子树已回收。
        try:
            with part.open('xb') as stream:
                stream.write(b'{"version":1}\n')
                stream.flush()
                os.fsync(stream.fileno())
            atomic_publish(part, receipt)
        finally:
            unlink_managed(part)
    finally:
        os.close(fd)


def report(code: str) -> int:
    try:
        # 结果小于 PIPE_BUF，不等待失联的接收方腾出缓冲区。
        os.set_blocking(1, False)
        data = (json.dumps({'code': 'INDEX_INSTALL_' + code}, separators=(',', ':')) + '\n').encode()
        if os.write(1, data) != len(data):
            return 1
    except OSError:
        return 1
    return int(code != 'READY')


def main(argv: list[str]) -> int:
    """仅接受两个绝对路径参数，错误以白名单 JSON 返回，无路径或环境内容。"""
    if len(argv) != 2 or any(not value.startswith('/') for value in argv):
        return report('INVALID_ARGUMENTS')
    try:
        os.umask(0o077)
        install(*argv)
    except InstallError as exc:
        code = str(exc)
        return report(code if code in ERROR_CODES else 'FAILED')
    except Exception:
        return report('FAILED')
    return report('READY')


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
