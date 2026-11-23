"""Linux 本地独占目录中的整套发布交换，不承诺 NFS、掉电持久性或同 UID 恶意防御。"""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import stat
import sys

MANIFEST = '.publication.json'
DIRECT_OWNER = 'project-draft-v1'


def validate_root(root):
    """根节点与子项同样属于信任边界，不能让 os.walk 把文件或链接当作合法空树。"""
    item = root.lstat()
    if not stat.S_ISDIR(item.st_mode) or stat.S_ISLNK(item.st_mode) or item.st_uid != os.getuid():
        raise ValueError('PUBLIC_DIRECTORY_INVALID')


def inventory(root):
    """校验当前 UID 的普通目录与文件，列出完整树以拒绝未知文件和空目录。"""
    validate_root(root)
    files = {}
    directories = []
    def raise_walk_error(error):
        raise error

    for current, dirs, names in os.walk(root, onerror=raise_walk_error, followlinks=False):
        for name in [*dirs, *names]:
            path = Path(current) / name
            item = path.lstat()
            if item.st_uid != os.getuid() or stat.S_ISLNK(item.st_mode):
                raise ValueError('PUBLIC_OWNER_OR_LINK')
            relative = path.relative_to(root).as_posix()
            if stat.S_ISDIR(item.st_mode):
                directories.append(relative)
            elif stat.S_ISREG(item.st_mode) and item.st_nlink == 1 and item.st_size <= 32 * 1024 * 1024:
                if relative != MANIFEST:
                    files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
            else:
                raise ValueError('PUBLIC_FILE_INVALID')
    return {'files': files, 'directories': sorted(directories)}


def validate(root, project, *, allow_direct=False):
    """只接管完整自有清单，拒绝内容、目录、项目或代的任何未登记变化。"""
    validate_root(root)
    manifest_path = root / MANIFEST
    info = manifest_path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1024 * 1024:
        raise ValueError('PUBLIC_MANIFEST_INVALID')
    manifest = json.loads(manifest_path.read_bytes())
    fields = {'version', 'project', 'generation', 'files', 'directories'}
    if allow_direct and manifest.get('owner') == DIRECT_OWNER:
        fields.add('owner')
    if set(manifest) != fields or type(manifest['version']) is not int or manifest['version'] != 1 or manifest['project'] != project:
        raise ValueError('PUBLIC_MANIFEST_INVALID')
    if allow_direct:
        # 在枚举全树前拒绝未知根文件，再复用导出器的 Markdown 目录和身份校验。
        if set(os.listdir(root)) != {MANIFEST, 'curated.json', 'knowledge.sqlite', 'md'}:
            raise ValueError('PUBLIC_LAYOUT_INVALID')
        markdown = runpy.run_path(str(Path(__file__).with_name('markdown-swap.py')))
        md = os.open(root / 'md', markdown['FLAGS'])
        try:
            exported, _ = markdown['validate'](md)
        finally:
            os.close(md)
        if exported['project'] != project or exported['snapshot'] != manifest['generation']:
            raise ValueError('PUBLIC_MARKDOWN_IDENTITY')
    actual = inventory(root)
    if actual != {key: manifest[key] for key in actual}:
        raise ValueError('PUBLIC_MANIFEST_CONFLICT')
    if allow_direct:
        if not isinstance(manifest['generation'], str) or not re.fullmatch(r'[a-f0-9]{64}', manifest['generation']):
            raise ValueError('PUBLIC_GENERATION_INVALID')
        if not {'curated.json', 'knowledge.sqlite'} <= actual['files'].keys():
            raise ValueError('PUBLIC_LAYOUT_INVALID')
    descriptor = json.loads((root / 'curated.json').read_bytes())
    if descriptor != {key: manifest[key] for key in ['version', 'project', 'generation']}:
        raise ValueError('PUBLIC_DESCRIPTOR_CONFLICT')
    return manifest


def main(state):
    """整套确认后才提交，失败不回退旧代，交换后的清理异常保留已提交状态。"""
    payload = json.loads(sys.stdin.buffer.read(8193))
    fields = set(payload)
    inspect = sys.argv[1:] == ['inspect']
    direct = not inspect and fields == {'project', 'parent', 'generation'}
    state['direct'] = direct
    if (inspect or not direct) and fields != {'project', 'parent'}:
        raise ValueError('PUBLIC_ARGUMENTS')
    if not inspect and sys.argv[1:]:
        raise ValueError('PUBLIC_ARGUMENTS')
    parent = Path(payload['parent'])
    if not parent.is_absolute() or parent.resolve() != parent:
        raise ValueError('PUBLIC_PARENT_INVALID')
    stage = parent / '.project-memory-next'
    target = parent / '.project-memory'
    if inspect:
        current = validate(target, payload['project'], allow_direct=True) if os.path.lexists(target) else None
        print(json.dumps({'generation': current['generation'] if current else None}))
        return
    validate_root(stage)
    descriptor = json.loads((stage / 'curated.json').read_bytes())
    content = {'version': 1, 'project': payload['project'], 'generation': descriptor['generation'], **inventory(stage)}
    if direct:
        # 旧版交换器只接受无 owner 的清单，因此不能把直发快照当作可覆盖的旧发布。
        content['owner'] = DIRECT_OWNER
    fd = os.open(stage / MANIFEST, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(content, stream, ensure_ascii=False)
        stream.write('\n')
    validate(stage, payload['project'], allow_direct=direct)
    current = os.path.lexists(target)
    baseline = validate(target, payload['project'], allow_direct=direct) if current else None
    if direct and (baseline['generation'] if baseline else None) != payload['generation']:
        raise ValueError('PUBLIC_BASELINE_CHANGED')
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(stage), -100, os.fsencode(target), 2 if current else 1) != 0:
        raise OSError(ctypes.get_errno(), 'PUBLIC_SWAP_FAILED')
    state['committed'] = True
    # 目标整套已提交，不因旧代清理失败回滚或恢复 reader。
    cleanup = 'none'
    if current:
        try:
            validate(stage, payload['project'], allow_direct=direct)
            shutil.rmtree(stage)
            cleanup = 'removed'
        except Exception:
            cleanup = 'retained'
    print(json.dumps({'stage': 'committed', 'generation': descriptor['generation'], 'cleanup': cleanup}))


if __name__ == '__main__':
    state = {'committed': False}
    try:
        main(state)
    except Exception:
        # 只有正常捕获且尚未交换时才给出未提交凭证，信号中断或没有凭证一律未知。
        if state.get('direct') and not state['committed']:
            print('PUBLICATION_NOT_COMMITTED', file=sys.stderr)
        else:
            print('{"stage":"unconfirmed","code":"PUBLICATION_FAILED"}', file=sys.stderr)
        raise SystemExit(1)
