"""Linux 本地文件系统原子交换；父目录由调用方可信独占，锁仅协调合作式 exporter。"""
import base64
import ctypes
import fcntl
import hashlib
import json
import os
import re
import stat
import sys

FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
MANIFEST = '.export-manifest.json'
STAGE = '.md-export-stage'
CATEGORIES = ['项目概况', '领域规则', '代码导航', '开发操作', '设计决策', '排障经验', '项目约定']


def sha(data):
    return hashlib.sha256(data).hexdigest()


MAX_MANIFEST = 1024 * 1024
MAX_FILE = 8 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024


def read_file(fd, name, limit=MAX_FILE):
    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = os.fstat(child)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('MD_SPECIAL_OR_HARDLINK')
        if info.st_size > limit:
            raise ValueError('MD_SIZE_BUDGET')
        chunks = []
        size = 0
        while block := os.read(child, min(65536, limit - size + 1)):
            size += len(block)
            if size > limit:
                raise ValueError('MD_SIZE_BUDGET')
            chunks.append(block)
        return b''.join(chunks)
    finally:
        os.close(child)


def validate(fd):
    # 先读有界 manifest，未知目录和文件集合在读取任何正文前拒绝，不递归扫描用户树。
    manifest = json.loads(read_file(fd, MANIFEST, MAX_MANIFEST))
    if not isinstance(manifest, dict) or set(manifest) != {'version', 'project', 'snapshot', 'files'} or type(manifest['version']) is not int or manifest['version'] != 1:
        raise ValueError('MD_MANIFEST')
    if not isinstance(manifest['project'], str) or not isinstance(manifest['snapshot'], str) or not re.fullmatch('[a-f0-9]{64}', manifest['snapshot']):
        raise ValueError('MD_MANIFEST_IDENTITY')
    expected_files = manifest['files']
    if not isinstance(expected_files, dict) or 'README.md' not in expected_files:
        raise ValueError('MD_FILES')
    for path, digest in expected_files.items():
        if path != 'README.md' and not any(re.fullmatch(re.escape(c) + r'/k-[a-z0-9][a-z0-9-]{0,79}\.md', path) for c in CATEGORIES):
            raise ValueError('MD_PATH')
        if not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest):
            raise ValueError('MD_FILE_DIGEST')
    if set(os.listdir(fd)) != {*CATEGORIES, 'README.md', MANIFEST}:
        raise ValueError('MD_DIRECTORIES')
    files = {}
    total = 0
    # 所有目录必须恰好匹配归属集合后才读取正文，避免未知 vendor 子树或特殊文件参与扫描。
    for category in CATEGORIES:
        child = os.open(category, FLAGS, dir_fd=fd)
        try:
            names = {path.split('/')[1] for path in expected_files if path.startswith(category + '/')}
            if set(os.listdir(child)) != names:
                raise ValueError('MD_UNKNOWN_OR_MISSING_FILE')
        finally:
            os.close(child)
    for path in expected_files:
        if path == 'README.md':
            data = read_file(fd, path, min(MAX_FILE, MAX_TOTAL - total))
        else:
            category, name = path.split('/')
            child = os.open(category, FLAGS, dir_fd=fd)
            try:
                data = read_file(child, name, min(MAX_FILE, MAX_TOTAL - total))
            finally:
                os.close(child)
        total += len(data)
        files[path] = data
    if {p: sha(v) for p, v in files.items()} != expected_files:
        raise ValueError('MD_USER_CONFLICT')
    first = files['README.md'].split(b'\n', 1)[0]
    prefix = b'<!-- project-memory-export:'
    if not first.startswith(prefix) or not first.endswith(b' -->'):
        raise ValueError('MD_README_IDENTITY')
    identity = json.loads(base64.b64decode(first[len(prefix):-4], validate=True))
    expected = {k: manifest[k] for k in ('version', 'project', 'snapshot')}
    if identity != expected or type(identity['version']) is not int:
        raise ValueError('MD_MANIFEST_IDENTITY_BINDING')
    return manifest, files


def exists(fd, name):
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False


def remove_owned(parent, name, project):
    # 仅在重新验证整个树归属和逐文件摘要后删除，不对未知或部分生成的 staging 猜测恢复。
    fd = os.open(name, FLAGS, dir_fd=parent)
    try:
        manifest, _ = validate(fd)
        if manifest['project'] != project:
            raise ValueError('MD_STAGE_PROJECT')
        for category in CATEGORIES:
            child = os.open(category, FLAGS, dir_fd=fd)
            try:
                for file in os.listdir(child):
                    os.unlink(file, dir_fd=child)
            finally:
                os.close(child)
            os.rmdir(category, dir_fd=fd)
        for file in os.listdir(fd):
            os.unlink(file, dir_fd=fd)
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=parent)
    os.fsync(parent)


def write_file(fd, name, content):
    child = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        view = memoryview(content)
        while view:
            count = os.write(child, view)
            if count <= 0:
                raise OSError('MD_SHORT_WRITE')
            view = view[count:]
        os.fsync(child)
    finally:
        os.close(child)


def parent_fd(path):
    # 从根目录逐级打开，拒绝祖先 symlink；这不是同 UID 攻击者沙箱。
    if not os.path.isabs(path) or '..' in path.split('/'):
        raise ValueError('MD_PARENT_PATH')
    fd = os.open('/', FLAGS)
    try:
        for part in path.split('/'):
            if not part:
                continue
            child = os.open(part, FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def main():
    payload = json.load(sys.stdin)
    if payload['version'] != 1 or payload['directories'] != CATEGORIES:
        raise ValueError('MD_INPUT')
    sizes = [len(v.encode('utf-8')) for v in payload['files'].values()]
    if any(size > MAX_FILE for size in sizes) or sum(sizes) > MAX_TOTAL:
        raise ValueError('MD_SIZE_BUDGET')
    parent = parent_fd(sys.argv[1])
    committed = False
    lock = None
    try:
        lock = os.open('.md-export.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
        if not stat.S_ISREG(os.fstat(lock).st_mode) or os.fstat(lock).st_nlink != 1:
            raise ValueError('MD_LOCK_TYPE')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = None
        files = {}
        if exists(parent, 'md'):
            fd = os.open('md', FLAGS, dir_fd=parent)
            try:
                current, files = validate(fd)
                if current['project'] != payload['project']:
                    raise ValueError('MD_PROJECT_CONFLICT')
            finally:
                os.close(fd)
        # 先确认当前树完整，避免因当前冲突而删除前次留下的唯一完整备份。
        if exists(parent, STAGE):
            remove_owned(parent, STAGE, payload['project'])
        if current and current['snapshot'] == payload['snapshot']:
            if files != {k: v.encode('utf-8') for k, v in payload['files'].items()}:
                raise ValueError('MD_SNAPSHOT_CONTENT_CONFLICT')
            print(json.dumps({'status': 'unchanged', 'snapshot': payload['snapshot']}))
            return
        os.mkdir(STAGE, 0o700, dir_fd=parent)
        stage = os.open(STAGE, FLAGS, dir_fd=parent)
        try:
            for category in CATEGORIES:
                os.mkdir(category, 0o700, dir_fd=stage)
            for path, content in payload['files'].items():
                if path == 'README.md':
                    write_file(stage, path, content.encode('utf-8'))
                else:
                    category, name = path.split('/')
                    if category not in CATEGORIES or not re.fullmatch(r'k-[a-z0-9][a-z0-9-]{0,79}\.md', name):
                        raise ValueError('MD_INPUT_PATH')
                    fd = os.open(category, FLAGS, dir_fd=stage)
                    try:
                        write_file(fd, name, content.encode('utf-8'))
                        os.fsync(fd)
                    finally:
                        os.close(fd)
            for category in CATEGORIES:
                fd = os.open(category, FLAGS, dir_fd=stage)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            manifest = {k: payload[k] for k in ('version', 'project', 'snapshot')}
            manifest['files'] = {p: sha(v.encode('utf-8')) for p, v in payload['files'].items()}
            write_file(stage, MANIFEST, (json.dumps(manifest, ensure_ascii=False, sort_keys=True) + '\n').encode('utf-8'))
            os.fsync(stage)
            validate(stage)
        finally:
            os.close(stage)
        os.fsync(parent)
        libc = ctypes.CDLL(None, use_errno=True)
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        if rename(parent, STAGE.encode(), parent, b'md', 2 if current else 1) != 0:
            raise OSError(ctypes.get_errno(), 'MD_ATOMIC_RENAME_REQUIRED')
        committed = True
        os.fsync(parent)
        if current:
            remove_owned(parent, STAGE, payload['project'])
        print(json.dumps({'status': 'committed', 'snapshot': payload['snapshot']}))
    except BaseException as error:
        if committed:
            raise RuntimeError('committed-but-cleanup-failed') from error
        raise
    finally:
        try:
            if lock is not None:
                os.close(lock)
        finally:
            os.close(parent)


if __name__ == '__main__':
    main()
