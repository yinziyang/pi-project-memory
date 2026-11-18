"""显式恢复只续交完整已验快照或保留未验证 staging，不回滚、不删除未知内容。"""
import json
import os
from pathlib import Path
import re
import runpy
import sys
import uuid

api = runpy.run_path(str(Path(__file__).with_name('publication-swap.py')))
validate = api['validate']
inventory = api['inventory']
CATEGORIES = {'项目概况', '领域规则', '代码导航', '开发操作', '设计决策', '排障经验', '项目约定'}


def main():
    """调用方已取得私有 owner 并实际暂停 reader，完整代校验后才允许提交或清理。"""
    payload = json.loads(sys.stdin.buffer.read(8193))
    parent = Path(payload['parent'])
    if not parent.is_absolute() or parent.resolve() != parent:
        raise ValueError('RECOVERY_PARENT')
    stage = parent / '.project-memory-next'
    target = parent / '.project-memory'
    if os.path.lexists(stage):
        api['validate_root'](stage)
    generation = payload['generation']
    project = payload['project']
    current = validate(target, project) if os.path.lexists(target) else None
    if os.path.lexists(stage) and (stage / '.publication.json').exists():
        selected = validate(stage, project)
        if current and current['generation'] == generation:
            # 完整旧树只在新代已确认为当前时删除，不从旧代回滚。
            import shutil
            shutil.rmtree(stage)
            print(json.dumps({'stage': 'committed', 'generation': generation, 'cleanup': 'removed'}))
            return
        if selected['generation'] != generation:
            raise ValueError('RECOVERY_GENERATION')
        # 尚未交换的完整新代重新执行同一 install，先删的仅是已完整验证的自有 manifest。
        (stage / '.publication.json').unlink()
        swap_input = json.dumps({'parent': str(parent), 'project': project})
        import io
        sys.stdin = io.TextIOWrapper(io.BytesIO(swap_input.encode()))
        api['main']()
        return
    if not os.path.lexists(stage):
        if current and current['generation'] == generation:
            print(json.dumps({'stage': 'committed', 'generation': generation, 'cleanup': 'none'}))
            return
        raise ValueError('RECOVERY_NO_OWNED_STAGE')
    tree = inventory(stage)
    marker = stage / '.stage-owner'
    if marker.exists() and marker.read_text() != payload['token']:
        raise ValueError('RECOVERY_OWNER')
    if not marker.exists() and generation is None and tree['files']:
        raise ValueError('RECOVERY_OWNER_MISSING')
    allowed = {'.stage-owner', 'knowledge.sqlite', 'knowledge.sqlite-wal', 'knowledge.sqlite-shm', 'curated.json', '.md-export.lock'}
    for name in tree['files']:
        if name in allowed:
            continue
        parts = name.split('/')
        if len(parts) >= 2 and parts[0] in {'md', '.md-export-stage'}:
            if len(parts) == 2 and parts[1] in {'README.md', '.export-manifest.json'}:
                continue
            if len(parts) == 3 and parts[1] in CATEGORIES and re.fullmatch(r'k-[a-z0-9][a-z0-9-]{0,79}\.md', parts[2]):
                continue
        raise ValueError('RECOVERY_UNKNOWN_FILE')
    for name in tree['directories']:
        parts = name.split('/')
        if len(parts) == 1 and parts[0] in {'md', '.md-export-stage'}:
            continue
        if len(parts) == 2 and parts[0] in {'md', '.md-export-stage'} and parts[1] in CATEGORIES:
            continue
        raise ValueError('RECOVERY_UNKNOWN_DIRECTORY')
    # 部分构建无法证明内容完整，只移动保留而不删除，不能把其内容当成可发布结果。
    retained = parent / ('.project-memory-retained-' + str(uuid.uuid4()))
    os.rename(stage, retained)
    print(json.dumps({'stage': 'staging-retained', 'retained': retained.name}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"stage":"unconfirmed","code":"RECOVERY_REJECTED"}', file=sys.stderr)
        raise SystemExit(1)
