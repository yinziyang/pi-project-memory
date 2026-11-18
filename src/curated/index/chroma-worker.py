"""仅供 index owner 启动的本地 Chroma worker，不派生子进程且不允许网络。"""

import fcntl
import json
import math
import os
from pathlib import Path
import signal
import socket
import sys


def deny_network(*_args, **_kwargs):
    raise RuntimeError("INDEX_NETWORK_DISABLED")


socket.socket.connect = deny_network
socket.create_connection = deny_network
os.environ["ANONYMIZED_TELEMETRY"] = "False"
os.umask(0o077)
client = None
collection = None
lock_file = None
identity = None


def validate_vector(vector):
    if not isinstance(vector, list) or len(vector) != 384:
        raise ValueError("INDEX_VECTOR_INVALID")
    if any(isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) for value in vector):
        raise ValueError("INDEX_VECTOR_INVALID")
    if not 0.999 < math.sqrt(sum(value * value for value in vector)) < 1.001:
        raise ValueError("INDEX_VECTOR_INVALID")


def initialize(message):
    global client, collection, lock_file, identity
    if client is not None:
        raise ValueError("INDEX_PROTOCOL_INVALID")
    import chromadb
    from chromadb.config import Settings
    if chromadb.__version__ != "1.5.9":
        raise ValueError("DEPENDENCY_MISSING")
    identity = message["identity"]
    root = Path(message["directory"])
    # flock 由实际 worker 生命周期持有，不以 PID 文件猜测其他持有者是否退出。
    lock_file = (root / "worker.lock").open("a+", encoding="utf-8")
    os.chmod(root / "worker.lock", 0o600)
    fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    client = chromadb.PersistentClient(path=str(root / "chroma"), settings=Settings(anonymized_telemetry=False, allow_reset=False))
    name = message["collection"]
    if message["create"]:
        collection = client.create_collection(name=name, embedding_function=None,
                                              configuration={"hnsw": {"space": "cosine"}},
                                              metadata={"identity": json.dumps(identity, sort_keys=True)})
    else:
        collections = client.list_collections()
        if len(collections) != 1 or collections[0].name != name:
            raise ValueError("INDEX_INVALID")
        collection = client.get_collection(name=name, embedding_function=None)
    if collection.metadata != {"identity": json.dumps(identity, sort_keys=True)}:
        raise ValueError("INDEX_INVALID")
    if collection.configuration.get("hnsw", {}).get("space") != "cosine":
        raise ValueError("INDEX_INVALID")
    return {"count": collection.count()}


def execute(message):
    if message["op"] == "init":
        return initialize(message)
    if collection is None:
        raise ValueError("INDEX_PROTOCOL_INVALID")
    if message["op"] == "add":
        records, vectors = message["records"], message["vectors"]
        if not records or len(records) > 4 or len(records) != len(vectors):
            raise ValueError("INDEX_PROTOCOL_INVALID")
        for vector in vectors:
            validate_vector(vector)
        collection.add(ids=[record["id"] for record in records], embeddings=vectors,
                       metadatas=[{"ref": json.dumps(record["ref"], sort_keys=True)} for record in records])
        return {"count": collection.count()}
    if message["op"] == "verify":
        expected = {record["id"]: record["ref"] for record in message["records"]}
        if collection.count() != len(expected):
            raise ValueError("INDEX_INVALID")
        found = collection.get(include=["metadatas", "embeddings"])
        if len(found["ids"]) != len(expected) or set(found["ids"]) != set(expected):
            raise ValueError("INDEX_INVALID")
        for index, key in enumerate(found["ids"]):
            metadata = found["metadatas"][index]
            if set(metadata) != {"ref"} or json.loads(metadata["ref"]) != expected[key]:
                raise ValueError("INDEX_INVALID")
            validate_vector(found["embeddings"][index].tolist())
        return {"count": len(expected)}
    if message["op"] == "query":
        validate_vector(message["vector"])
        count = collection.count()
        if count == 0:
            return []
        top_k = message["topK"]
        if isinstance(top_k, bool) or not isinstance(top_k, int) or not 1 <= top_k <= 10:
            raise ValueError("INDEX_PROTOCOL_INVALID")
        found = collection.query(query_embeddings=[message["vector"]], n_results=min(count, top_k), include=["metadatas", "distances"])
        results = []
        for index, key in enumerate(found["ids"][0]):
            metadata = found["metadatas"][0][index]
            distance = found["distances"][0][index]
            if set(metadata) != {"ref"} or not math.isfinite(distance):
                raise ValueError("INDEX_INVALID")
            results.append({"id": key, "ref": json.loads(metadata["ref"]), "score": 1 - distance})
        return results
    raise ValueError("INDEX_PROTOCOL_INVALID")


def _interrupt(_signum, _frame):
    raise InterruptedError("INDEX_CANCELLED")


def main():
    signal.signal(signal.SIGTERM, _interrupt)
    signal.signal(signal.SIGINT, _interrupt)
    try:
        for line in sys.stdin:
            result = execute(json.loads(line))
            print(json.dumps({"ok": True, "result": result}, allow_nan=False), flush=True)
    except (ImportError, ModuleNotFoundError):
        print(json.dumps({"ok": False, "code": "DEPENDENCY_MISSING"}), flush=True)
        return 1
    except Exception:
        # 不把路径、正文或依赖原始 stderr 交给 tool/UI，父进程仅收到固定故障码。
        print(json.dumps({"ok": False, "code": "INDEX_INVALID"}), flush=True)
        return 1
    finally:
        try:
            if client is not None:
                client.close()
        finally:
            if lock_file is not None:
                lock_file.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
