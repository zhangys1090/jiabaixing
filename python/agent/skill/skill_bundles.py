"""技能打包与分发。

技能包的打包、解包、验证与分发：
  - 将技能目录打包为可分发的 JSON/ZIP 格式
  - 技能包签名与完整性验证
  - 依赖声明与解析
  - 技能市场（hub）集成接口

集成示例::

    from agent.skill.skill_bundles import SkillBundler

    bundler = SkillBundler()
    bundle = bundler.pack("code_review", skill_dir="/skills/code_review")
    valid = bundler.verify(bundle)
    bundler.unpack(bundle, target_dir="/skills/imported")
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("skill.bundles")


class BundleFormat(Enum):
    JSON = "json"
    ZIP = "zip"


@dataclass
class SkillDependency:
    name: str = ""
    version: str = ""
    optional: bool = False


@dataclass
class SkillManifest:
    name: str = ""
    version: str = "1.0.0"
    description: str = ""
    author: str = ""
    category: str = ""
    trigger: str = ""
    tools: list[str] = field(default_factory=list)
    dependencies: list[SkillDependency] = field(default_factory=list)
    steps: list[dict[str, Any]] = field(default_factory=list)
    created_at: float = 0.0
    updated_at: float = 0.0


@dataclass
class SkillBundle:
    manifest: SkillManifest = field(default_factory=SkillManifest)
    files: dict[str, str] = field(default_factory=dict)
    signature: str = ""
    format: BundleFormat = BundleFormat.JSON


@dataclass
class VerifyResult:
    valid: bool = False
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class SkillBundler:
    """技能打包器。"""

    def __init__(self, signing_key: str = ""):
        self._signing_key = signing_key or uuid.uuid4().hex

    def pack(self, name: str, skill_dir: str = "", manifest: SkillManifest | None = None) -> SkillBundle:
        if manifest is None:
            manifest = self._load_manifest(name, skill_dir)
        files: dict[str, str] = {}
        if skill_dir and os.path.isdir(skill_dir):
            for root, _, fnames in os.walk(skill_dir):
                for fname in fnames:
                    fpath = os.path.join(root, fname)
                    rel_path = os.path.relpath(fpath, skill_dir).replace("\\", "/")
                    with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                        files[rel_path] = f.read()
        bundle = SkillBundle(
            manifest=manifest,
            files=files,
            format=BundleFormat.JSON,
        )
        bundle.signature = self._sign_bundle(bundle)
        log.info("Skill packed", name=name, files=len(files))
        return bundle

    def pack_to_json(self, bundle: SkillBundle) -> str:
        data = self._bundle_to_dict(bundle)
        return json.dumps(data, ensure_ascii=False, indent=2)

    def pack_to_zip(self, bundle: SkillBundle) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            manifest_json = json.dumps(self._manifest_to_dict(bundle.manifest), ensure_ascii=False, indent=2)
            zf.writestr("manifest.json", manifest_json)
            for rel_path, content in bundle.files.items():
                zf.writestr(rel_path, content)
            zf.writestr("signature.txt", bundle.signature)
        return buf.getvalue()

    def unpack(self, bundle: SkillBundle, target_dir: str = "") -> str:
        target = target_dir or os.path.join(os.getcwd(), "data", "skills", bundle.manifest.name)
        os.makedirs(target, exist_ok=True)
        for rel_path, content in bundle.files.items():
            fpath = os.path.join(target, rel_path)
            os.makedirs(os.path.dirname(fpath), exist_ok=True)
            with open(fpath, "w", encoding="utf-8") as f:
                f.write(content)
        manifest_path = os.path.join(target, "manifest.json")
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(self._manifest_to_dict(bundle.manifest), f, ensure_ascii=False, indent=2)
        log.info("Skill unpacked", name=bundle.manifest.name, target=target)
        return target

    def unpack_from_json(self, json_str: str) -> SkillBundle:
        data = json.loads(json_str)
        return self._dict_to_bundle(data)

    def unpack_from_zip(self, zip_bytes: bytes) -> SkillBundle:
        manifest = SkillManifest()
        files: dict[str, str] = {}
        signature = ""
        with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
            for name in zf.namelist():
                content = zf.read(name).decode("utf-8", errors="replace")
                if name == "manifest.json":
                    manifest = self._dict_to_manifest(json.loads(content))
                elif name == "signature.txt":
                    signature = content.strip()
                else:
                    files[name] = content
        return SkillBundle(manifest=manifest, files=files, signature=signature, format=BundleFormat.ZIP)

    def verify(self, bundle: SkillBundle) -> VerifyResult:
        errors = []
        warnings = []
        if not bundle.manifest.name:
            errors.append("Missing skill name")
        if not bundle.manifest.version:
            errors.append("Missing skill version")
        expected_sig = self._sign_bundle(bundle)
        if bundle.signature and not self._constant_time_compare(bundle.signature, expected_sig):
            errors.append("Signature mismatch")
        elif not bundle.signature:
            warnings.append("No signature present")
        for dep in bundle.manifest.dependencies:
            if not dep.name:
                errors.append(f"Dependency missing name: {dep}")
        return VerifyResult(
            valid=len(errors) == 0,
            errors=errors,
            warnings=warnings,
        )

    def _load_manifest(self, name: str, skill_dir: str) -> SkillManifest:
        if skill_dir:
            mpath = os.path.join(skill_dir, "manifest.json")
            if os.path.exists(mpath):
                with open(mpath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                return self._dict_to_manifest(data)
        return SkillManifest(
            name=name,
            created_at=time.time(),
            updated_at=time.time(),
        )

    def _sign_bundle(self, bundle: SkillBundle) -> str:
        payload = json.dumps({
            "name": bundle.manifest.name,
            "version": bundle.manifest.version,
            "files": sorted(bundle.files.keys()),
        }, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(
            (self._signing_key + payload).encode("utf-8")
        ).hexdigest()[:32]

    @staticmethod
    def _constant_time_compare(a: str, b: str) -> bool:
        if len(a) != len(b):
            return False
        result = 0
        for x, y in zip(a, b):
            result |= ord(x) ^ ord(y)
        return result == 0

    def _bundle_to_dict(self, bundle: SkillBundle) -> dict[str, Any]:
        return {
            "manifest": self._manifest_to_dict(bundle.manifest),
            "files": bundle.files,
            "signature": bundle.signature,
            "format": bundle.format.value,
        }

    def _dict_to_bundle(self, data: dict[str, Any]) -> SkillBundle:
        return SkillBundle(
            manifest=self._dict_to_manifest(data.get("manifest", {})),
            files=data.get("files", {}),
            signature=data.get("signature", ""),
            format=BundleFormat(data.get("format", "json")),
        )

    @staticmethod
    def _manifest_to_dict(m: SkillManifest) -> dict[str, Any]:
        return {
            "name": m.name,
            "version": m.version,
            "description": m.description,
            "author": m.author,
            "category": m.category,
            "trigger": m.trigger,
            "tools": m.tools,
            "dependencies": [{"name": d.name, "version": d.version, "optional": d.optional} for d in m.dependencies],
            "steps": m.steps,
            "createdAt": m.created_at,
            "updatedAt": m.updated_at,
        }

    @staticmethod
    def _dict_to_manifest(data: dict[str, Any]) -> SkillManifest:
        deps = []
        for d in data.get("dependencies", []):
            deps.append(SkillDependency(name=d.get("name", ""), version=d.get("version", ""), optional=d.get("optional", False)))
        return SkillManifest(
            name=data.get("name", ""),
            version=data.get("version", "1.0.0"),
            description=data.get("description", ""),
            author=data.get("author", ""),
            category=data.get("category", ""),
            trigger=data.get("trigger", ""),
            tools=data.get("tools", []),
            dependencies=deps,
            steps=data.get("steps", []),
            created_at=data.get("createdAt", 0),
            updated_at=data.get("updatedAt", 0),
        )
