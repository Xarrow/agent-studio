"""存储迁移的判据：搬完目标能读、记录指对、源默认还在。"""

from __future__ import annotations

import asyncio
from pathlib import Path


async def _wait_migration(client, job_id: str):
    for _ in range(200):
        rows = (await client.get("/api/knowledge/storage/migrations")).json()["items"]
        hit = next((r for r in rows if r["id"] == job_id), None)
        if hit and hit["status"] in ("done", "failed"):
            return hit
        await asyncio.sleep(0.1)
    return hit


async def test_迁移把原件搬到目标存储(client, tmp_path, monkeypatch):
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)

    src_root = Path(tmp_path) / "disk-a"
    dst_root = Path(tmp_path) / "disk-b"
    src_root.mkdir(parents=True, exist_ok=True)
    dst_root.mkdir(parents=True, exist_ok=True)

    # 目标存储（源就是默认的本地存储）
    made = await client.post(
        "/api/knowledge/storage",
        json={
            "name": "盘 B",
            "type": "local",
            "params": {"root": str(dst_root)},
            "path_template": "{sha256[:2]}/{sha256}/{name}",
            "is_default": False,
        },
    )
    assert made.status_code == 201, made.text
    to_id = made.json()["id"]

    # 上传两份文档（源=默认本地存储）
    r = await client.post(
        "/api/knowledge/documents",
        files={"files": ("迁移测试.md", b"# migrate\n\ncontent", "text/markdown")},
    )
    assert r.status_code in (200, 201), r.text
    doc = r.json()["documents"][0]
    for _ in range(60):  # 解析是异步的，等它 ready
        before = (await client.get(f"/api/knowledge/documents/{doc['id']}")).json()
        if before["status"] in ("ready", "failed"):
            break
        await asyncio.sleep(0.1)
    assert before["status"] == "ready"

    started = await client.post(
        "/api/knowledge/storage/migrate", json={"to_id": to_id, "keep_source": True}
    )
    assert started.status_code == 202, started.text
    job = await _wait_migration(client, started.json()["job"]["id"])
    assert job["status"] == "done", job
    # 整个套件共用库：之前用例的文档也会被一起搬，所以只断言"包含本文档且无失败"
    assert job["total"] >= 1 and job["moved"] >= 1 and job["failed"] == 0

    # 记录已指向目标存储
    after = (await client.get(f"/api/knowledge/documents/{doc['id']}")).json()
    assert after["storage_id"] == to_id
    assert str(dst_root) in after["storage_path"]

    # 目标盘上真有原件，且能通过接口取回
    files = [p for p in dst_root.rglob("*") if p.is_file()]
    assert files, "目标存储里没有文件"
    got = await client.get(f"/api/knowledge/documents/{doc['id']}/original")
    assert got.status_code == 200 and b"content" in got.content

    # 链接入库的 HTML 快照也要跟过来（否则「来源可复现」断在迁移上）
    src_snap = Path(before["storage_path"] + ".snapshot.html")
    if src_snap.exists():
        assert any(p.name.endswith(".snapshot.html") for p in dst_root.rglob("*"))

    # 源文件默认保留（危险动作的默认行为）：原来的路径还在
    assert Path(before["storage_path"]).exists(), "源文件被删了，默认不该删源"


async def test_源目标相同被拒(client, tmp_path, monkeypatch):
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    rows = (await client.get("/api/knowledge/storage")).json()["items"]
    sid = rows[0]["id"]
    r = await client.post("/api/knowledge/storage/migrate", json={"from_id": sid, "to_id": sid})
    assert r.status_code == 422
    r2 = await client.post("/api/knowledge/storage/migrate", json={"to_id": ""})
    assert r2.status_code == 422


async def test_迁移带着html快照一起走(client, tmp_path, monkeypatch):
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    dst_root = Path(tmp_path) / "disk-c"
    dst_root.mkdir(parents=True, exist_ok=True)

    made = await client.post(
        "/api/knowledge/storage",
        json={
            "name": "盘 C",
            "type": "local",
            "params": {"root": str(dst_root)},
            "path_template": "{sha256[:2]}/{sha256}/{name}",
            "is_default": False,
        },
    )
    to_id = made.json()["id"]

    r = await client.post(
        "/api/knowledge/documents",
        files={"files": ("带快照.md", b"# snap\n\nbody", "text/markdown")},
    )
    doc = r.json()["documents"][0]
    detail = (await client.get(f"/api/knowledge/documents/{doc['id']}")).json()
    src_path = Path(detail["storage_path"])
    # 手工补一份快照（真实场景由「加链接」生成）
    src_path.with_name(src_path.name + ".snapshot.html").write_text("<html>snapshot</html>", encoding="utf-8")

    started = await client.post("/api/knowledge/storage/migrate", json={"from_id": "", "to_id": to_id})
    job = await _wait_migration(client, started.json()["job"]["id"])
    assert job["status"] == "done", job

    snaps = [p for p in dst_root.rglob("*.snapshot.html")]
    assert snaps, "快照没跟着搬"
    assert snaps[0].read_text(encoding="utf-8") == "<html>snapshot</html>"
