"""内核级虚拟化沙箱 — Phase 3+4 插件化框架增强。

提供 gVisor (runsc)、Firecracker (microVM)、Windows Sandbox (Hyper-V) 三种
内核级隔离的统一抽象层，支持动态注册/注销后端插件。

隔离层级对比：
    LOGICAL   < PROCESS   < CONTAINER  < KERNEL
    SandboxGuard  WinHard  Docker      gVisor/Firecracker/WinSandbox

降级策略：内核级不可用时自动降级到容器级（Docker），再降级到进程级/逻辑级。

插件化架构 (Phase 3+4 增强)：
    KernelIsolationProvider 作为插件注册中心，支持：
    - register_backend()  动态注册新后端
    - unregister_backend() 动态注销后端
    - list_backends()     列出所有已注册后端
    - auto_select()       按优先级自动选择可用后端
    - health_check()      周期性后端健康检查
    - 事件钩子 (on_spawn/on_destroy/on_error/on_degrade)
    - 指标采集 (调用计数/延迟/错误率/可用性)
    - 配置热更新 (运行时修改后端优先级/参数)
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
import time
import uuid
from abc import ABC, abstractmethod
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable

from agent.core.logger import StructuredLogger

log = StructuredLogger("kernel_isolation")


class KernelIsolationType(str, Enum):
    GVISOR = "gvisor"
    FIRECRACKER = "firecracker"
    WINDOWS_SANDBOX = "windows_sandbox"


@dataclass
class KernelSandboxConfig:
    isolation_type: KernelIsolationType = KernelIsolationType.GVISOR
    memory_mb: int = 256
    cpu_count: float = 1.0
    timeout_sec: float = 30.0
    network: str = "none"
    read_only_root: bool = True
    work_dir: str | None = None
    env_vars: dict[str, str] = field(default_factory=dict)


@dataclass
class KernelSandboxResult:
    success: bool
    output: str = ""
    error: str | None = None
    exit_code: int | None = None
    duration_ms: int = 0
    isolation_type: KernelIsolationType | None = None
    vm_id: str | None = None


@dataclass
class BackendInfo:
    name: KernelIsolationType
    cls: type
    priority: int
    description: str = ""


class KernelIsolationBackend(ABC):
    @abstractmethod
    async def is_available(self) -> bool: ...

    @abstractmethod
    async def spawn(
        self,
        code: str,
        language: str,
        config: KernelSandboxConfig,
    ) -> KernelSandboxResult: ...

    @abstractmethod
    async def destroy(self, vm_id: str) -> None: ...

    @property
    def description(self) -> str:
        return self.__class__.__doc__ or ""


_LANGUAGE_IMAGE_MAP: dict[str, str] = {
    "python": "python:3.11-slim",
    "javascript": "node:20-slim",
    "js": "node:20-slim",
    "shell": "alpine:3.19",
}

_LANGUAGE_SUFFIX_MAP: dict[str, str] = {
    "python": ".py",
    "javascript": ".js",
    "js": ".js",
    "shell": ".sh",
}

_LANGUAGE_CMD_MAP: dict[str, list[str]] = {
    "python": ["python", "/tmp/code.py"],
    "javascript": ["node", "/tmp/code.js"],
    "js": ["node", "/tmp/code.js"],
    "shell": ["/bin/sh", "/tmp/code.sh"],
}


class GVisorBackend(KernelIsolationBackend):
    """gVisor 系统调用过滤沙箱 — 通过 runsc runtime 在 Docker 中运行。"""

    _available_cache: bool | None = None

    async def is_available(self) -> bool:
        if sys.platform != "linux":
            return False
        if self._available_cache is not None:
            return self._available_cache
        try:
            proc = await asyncio.create_subprocess_exec(
                "runsc", "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc.wait(), timeout=3.0)
            self._available_cache = proc.returncode == 0
        except Exception:
            self._available_cache = False
        return self._available_cache

    async def spawn(
        self,
        code: str,
        language: str,
        config: KernelSandboxConfig,
    ) -> KernelSandboxResult:
        start = time.time()
        if not await self.is_available():
            return KernelSandboxResult(
                success=False,
                error="gVisor (runsc) not available",
                isolation_type=KernelIsolationType.GVISOR,
            )

        suffix = _LANGUAGE_SUFFIX_MAP.get(language, ".sh")
        with tempfile.NamedTemporaryFile(mode="w", suffix=suffix, delete=False, encoding="utf-8") as f:
            f.write(code)
            tmp_code = f.name

        try:
            cmd = [
                "docker", "run", "--rm",
                "--runtime=runsc",
                f"--memory={config.memory_mb}m",
                f"--cpus={config.cpu_count}",
                f"--network={config.network}",
            ]
            if config.read_only_root:
                cmd.append("--read-only")
            if config.work_dir:
                cmd.extend(["-v", f"{config.work_dir}:/workspace:ro", "-w", "/workspace"])
            cmd.extend(["--tmpfs", "/tmp:size=32m"])
            cmd.extend(["-v", f"{tmp_code}:/tmp/code{suffix}:ro"])

            image = _LANGUAGE_IMAGE_MAP.get(language, "alpine:3.19")
            cmd.append(image)
            cmd.extend(_LANGUAGE_CMD_MAP.get(language, ["/bin/sh", "/tmp/code.sh"]))

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(), timeout=config.timeout_sec,
                )
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except Exception:
                    pass
                return KernelSandboxResult(
                    success=False,
                    error=f"Timeout ({config.timeout_sec}s)",
                    exit_code=-1,
                    duration_ms=int((time.time() - start) * 1000),
                    isolation_type=KernelIsolationType.GVISOR,
                )

            return KernelSandboxResult(
                success=proc.returncode == 0,
                output=stdout.decode("utf-8", errors="replace"),
                error=stderr.decode("utf-8", errors="replace") if proc.returncode != 0 else None,
                exit_code=proc.returncode,
                duration_ms=int((time.time() - start) * 1000),
                isolation_type=KernelIsolationType.GVISOR,
            )
        except Exception as exc:
            log.warning("gVisor spawn failed", error=str(exc))
            return KernelSandboxResult(
                success=False,
                error=str(exc),
                isolation_type=KernelIsolationType.GVISOR,
            )
        finally:
            try:
                Path(tmp_code).unlink()
            except Exception:
                pass

    async def destroy(self, vm_id: str) -> None:
        pass


class FirecrackerBackend(KernelIsolationBackend):
    """Firecracker microVM 沙箱 — 轻量虚拟机隔离，需 jailer + rootfs。

    执行流程：
    1. 检测 firecracker/jailer 可用性
    2. 为每次 spawn 创建独立 rootfs（基于 Alpine 最小镜像）
    3. 将用户代码写入 rootfs
    4. 生成 Firecracker VM 配置 JSON
    5. 通过 jailer 启动 microVM
    6. 收集输出，清理资源
    """

    _available_cache: bool | None = None
    _rootfs_base: str | None = None
    _active_vms: dict[str, dict[str, Any]] = {}

    async def is_available(self) -> bool:
        if sys.platform != "linux":
            return False
        if self._available_cache is not None:
            return self._available_cache
        try:
            proc = await asyncio.create_subprocess_exec(
                "firecracker", "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc.wait(), timeout=3.0)
            fc_ok = proc.returncode == 0
        except Exception:
            fc_ok = False

        jailer_ok = False
        if fc_ok:
            try:
                proc = await asyncio.create_subprocess_exec(
                    "jailer", "--version",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await asyncio.wait_for(proc.wait(), timeout=3.0)
                jailer_ok = proc.returncode == 0
            except Exception:
                jailer_ok = False

        self._available_cache = fc_ok and jailer_ok
        if self._available_cache:
            log.info("Firecracker + jailer available")
        return self._available_cache

    def _ensure_rootfs_base(self) -> str:
        if self._rootfs_base is not None and Path(self._rootfs_base).exists():
            return self._rootfs_base
        rootfs_dir = Path(tempfile.gettempdir()) / "fc_rootfs_base"
        rootfs_dir.mkdir(parents=True, exist_ok=True)
        self._rootfs_base = str(rootfs_dir)
        return self._rootfs_base

    def _create_rootfs(self, code: str, language: str, vm_id: str) -> str:
        rootfs_base = self._ensure_rootfs_base()
        vm_rootfs = Path(tempfile.gettempdir()) / f"fc_rootfs_{vm_id}"
        vm_rootfs.mkdir(parents=True, exist_ok=True)

        for subdir in ["bin", "tmp", "dev", "proc", "sys", "lib", "etc"]:
            (vm_rootfs / subdir).mkdir(parents=True, exist_ok=True)

        suffix = _LANGUAGE_SUFFIX_MAP.get(language, ".sh")
        code_file = vm_rootfs / "tmp" / f"code{suffix}"
        code_file.write_text(code, encoding="utf-8")

        entry_sh = vm_rootfs / "tmp" / "entry.sh"
        if language == "python":
            entry_sh.write_text("#!/bin/sh\npython3 /tmp/code.py\n", encoding="utf-8")
        elif language in ("javascript", "js"):
            entry_sh.write_text("#!/bin/sh\nnode /tmp/code.js\n", encoding="utf-8")
        else:
            entry_sh.write_text("#!/bin/sh\n/bin/sh /tmp/code.sh\n", encoding="utf-8")

        return str(vm_rootfs)

    def _generate_vm_config(
        self,
        vm_id: str,
        config: KernelSandboxConfig,
        rootfs_path: str,
    ) -> str:
        kernel_path = os.environ.get(
            "FC_KERNEL_PATH", "/usr/share/firecracker/vmlinux"
        )
        rootfs_file = os.environ.get(
            "FC_ROOTFS_FILE", f"{rootfs_path}/rootfs.ext4"
        )
        vm_config = {
            "boot-source": {
                "kernel_image_path": kernel_path,
                "boot_args": "console=ttyS0 reboot=k panic=1 pci=off",
            },
            "drives": [
                {
                    "drive_id": "rootfs",
                    "path_on_host": rootfs_file,
                    "is_root_device": True,
                    "is_read_only": config.read_only_root,
                }
            ],
            "machine-config": {
                "vcpu_count": max(1, int(config.cpu_count)),
                "mem_size_mib": config.memory_mb,
            },
            "network-interfaces": [],
        }
        config_path = str(Path(tempfile.gettempdir()) / f"fc_config_{vm_id}.json")
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(vm_config, f, indent=2)
        return config_path

    async def spawn(
        self,
        code: str,
        language: str,
        config: KernelSandboxConfig,
    ) -> KernelSandboxResult:
        start = time.time()
        if not await self.is_available():
            return KernelSandboxResult(
                success=False,
                error="Firecracker not available (requires firecracker + jailer on Linux)",
                isolation_type=KernelIsolationType.FIRECRACKER,
            )

        vm_id = f"fc-{uuid.uuid4().hex[:8]}"
        rootfs_path = ""
        config_path = ""

        try:
            rootfs_path = self._create_rootfs(code, language, vm_id)
            config_path = self._generate_vm_config(vm_id, config, rootfs_path)

            jailer_id = vm_id
            jailer_chroot = str(Path(tempfile.gettempdir()) / f"fc_jail_{vm_id}")

            cmd = [
                "jailer",
                "--id", jailer_id,
                "--exec-file", "/usr/bin/firecracker",
                "--jailer-root", jailer_chroot,
                "--uid", "0",
                "--gid", "0",
                "--",
                "--config-file", config_path,
            ]

            log.info("Firecracker spawning microVM", vm_id=vm_id)
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            self._active_vms[vm_id] = {
                "proc": proc,
                "rootfs": rootfs_path,
                "config": config_path,
                "jailer_chroot": jailer_chroot,
                "start": start,
            }

            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(), timeout=config.timeout_sec,
                )
            except asyncio.TimeoutError:
                await self.destroy(vm_id)
                return KernelSandboxResult(
                    success=False,
                    error=f"Timeout ({config.timeout_sec}s)",
                    exit_code=-1,
                    duration_ms=int((time.time() - start) * 1000),
                    isolation_type=KernelIsolationType.FIRECRACKER,
                    vm_id=vm_id,
                )

            duration_ms = int((time.time() - start) * 1000)
            result = KernelSandboxResult(
                success=proc.returncode == 0,
                output=stdout.decode("utf-8", errors="replace"),
                error=stderr.decode("utf-8", errors="replace") if proc.returncode != 0 else None,
                exit_code=proc.returncode,
                duration_ms=duration_ms,
                isolation_type=KernelIsolationType.FIRECRACKER,
                vm_id=vm_id,
            )

            self._cleanup_vm_files(vm_id)
            return result

        except Exception as exc:
            log.warning("Firecracker spawn failed", error=str(exc), vm_id=vm_id)
            self._cleanup_vm_files(vm_id)
            return KernelSandboxResult(
                success=False,
                error=str(exc),
                isolation_type=KernelIsolationType.FIRECRACKER,
                vm_id=vm_id,
            )

    def _cleanup_vm_files(self, vm_id: str) -> None:
        for key in ("rootfs", "config", "jailer_chroot"):
            path = self._active_vms.get(vm_id, {}).get(key, "")
            if path and Path(path).exists():
                try:
                    if Path(path).is_dir():
                        shutil.rmtree(path, ignore_errors=True)
                    else:
                        Path(path).unlink()
                except Exception:
                    pass
        self._active_vms.pop(vm_id, None)

    async def destroy(self, vm_id: str) -> None:
        vm_info = self._active_vms.get(vm_id)
        if vm_info is None:
            return
        proc = vm_info.get("proc")
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except Exception:
                pass
        self._cleanup_vm_files(vm_id)
        log.info("Firecracker VM destroyed", vm_id=vm_id)


class WindowsSandboxBackend(KernelIsolationBackend):
    """Windows Sandbox 沙箱 — Hyper-V 隔离，通过 .wsb 配置文件启动。

    执行流程：
    1. 检测 Windows Sandbox 可用性（功能启用 + Hyper-V）
    2. 生成 .wsb XML 配置文件
    3. 将用户代码写入启动脚本
    4. 启动 WindowsSandbox.exe
    5. 收集输出（通过共享文件夹中的输出文件）
    6. 清理临时资源
    """

    _available_cache: bool | None = None
    _active_sandboxes: dict[str, dict[str, Any]] = {}

    async def is_available(self) -> bool:
        if sys.platform != "win32":
            return False
        if self._available_cache is not None:
            return self._available_cache

        feature_enabled = await self._check_windows_feature()
        if not feature_enabled:
            self._available_cache = False
            return False

        try:
            proc = await asyncio.create_subprocess_exec(
                "WindowsSandbox.exe",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.sleep(1.0)
            try:
                proc.kill()
            except Exception:
                pass
            self._available_cache = True
        except Exception:
            self._available_cache = False

        return self._available_cache

    async def _check_windows_feature(self) -> bool:
        try:
            proc = await asyncio.create_subprocess_exec(
                "powershell", "-Command",
                "Get-WindowsOptionalFeature -Online -FeatureName *Sandbox* | Where-Object {$_.State -eq 'Enabled'} | Select-Object -First 1",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5.0)
            return b"Enabled" in stdout
        except Exception:
            pass
        try:
            import winreg
            key = winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WindowsSandbox.exe",
            )
            winreg.CloseKey(key)
            return True
        except Exception:
            return False

    def _generate_wsb_config(
        self,
        vm_id: str,
        config: KernelSandboxConfig,
        host_shared_dir: str,
        sandbox_shared_dir: str,
    ) -> str:
        wsb = f"""<?xml version="1.0" encoding="utf-8"?>
<Configuration>
  <VGpu>{max(1, int(config.cpu_count))}</VGpu>
  <MemoryInMB>{config.memory_mb}</MemoryInMB>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>{host_shared_dir}</HostFolder>
      <SandboxFolder>{sandbox_shared_dir}</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>{sandbox_shared_dir}\\launch.bat</Command>
  </LogonCommand>
  <Networking>{'Default' if config.network != 'none' else 'Disable'}</Networking>
</Configuration>"""
        wsb_path = str(Path(tempfile.gettempdir()) / f"wsb_{vm_id}.wsb")
        with open(wsb_path, "w", encoding="utf-8") as f:
            f.write(wsb)
        return wsb_path

    def _create_launch_script(
        self,
        code: str,
        language: str,
        shared_dir: str,
    ) -> None:
        suffix = _LANGUAGE_SUFFIX_MAP.get(language, ".py")
        code_file = Path(shared_dir) / f"code{suffix}"
        code_file.write_text(code, encoding="utf-8")

        output_file = Path(shared_dir) / "output.txt"
        error_file = Path(shared_dir) / "error.txt"
        exitcode_file = Path(shared_dir) / "exitcode.txt"

        if language == "python":
            launch_cmd = f'python code{suffix} > output.txt 2> error.txt; echo %ERRORLEVEL% > exitcode.txt'
        elif language in ("javascript", "js"):
            launch_cmd = f'node code{suffix} > output.txt 2> error.txt; echo %ERRORLEVEL% > exitcode.txt'
        else:
            launch_cmd = f'cmd /c code{suffix} > output.txt 2> error.txt; echo %ERRORLEVEL% > exitcode.txt'

        launch_bat = Path(shared_dir) / "launch.bat"
        bat_content = f"""@echo off
cd /d "{shared_dir}"
{launch_cmd}
"""
        launch_bat.write_text(bat_content, encoding="utf-8")

    async def spawn(
        self,
        code: str,
        language: str,
        config: KernelSandboxConfig,
    ) -> KernelSandboxResult:
        start = time.time()
        if not await self.is_available():
            return KernelSandboxResult(
                success=False,
                error="Windows Sandbox not available (requires Hyper-V + Windows Pro/Enterprise + Sandbox feature)",
                isolation_type=KernelIsolationType.WINDOWS_SANDBOX,
            )

        vm_id = f"wsb-{uuid.uuid4().hex[:8]}"
        shared_dir = ""

        try:
            shared_dir = str(Path(tempfile.gettempdir()) / f"wsb_shared_{vm_id}")
            Path(shared_dir).mkdir(parents=True, exist_ok=True)

            sandbox_shared = r"C:\Users\WDAGUtilityAccount\Desktop\shared"
            wsb_path = self._generate_wsb_config(vm_id, config, shared_dir, sandbox_shared)
            self._create_launch_script(code, language, shared_dir)

            log.info("WindowsSandbox spawning", vm_id=vm_id)
            proc = await asyncio.create_subprocess_exec(
                "WindowsSandbox.exe", wsb_path,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )

            self._active_sandboxes[vm_id] = {
                "proc": proc,
                "shared_dir": shared_dir,
                "wsb_path": wsb_path,
                "start": start,
            }

            output_file = Path(shared_dir) / "output.txt"
            exitcode_file = Path(shared_dir) / "exitcode.txt"
            elapsed = 0.0
            poll_interval = 0.5

            while elapsed < config.timeout_sec:
                await asyncio.sleep(poll_interval)
                elapsed += poll_interval

                if exitcode_file.exists():
                    try:
                        exit_code = int(exitcode_file.read_text(encoding="utf-8").strip())
                    except Exception:
                        exit_code = -1

                    output = ""
                    error = None
                    try:
                        output = (Path(shared_dir) / "output.txt").read_text(encoding="utf-8", errors="replace")
                    except Exception:
                        pass
                    if exit_code != 0:
                        try:
                            error = (Path(shared_dir) / "error.txt").read_text(encoding="utf-8", errors="replace")
                        except Exception:
                            pass

                    result = KernelSandboxResult(
                        success=exit_code == 0,
                        output=output,
                        error=error,
                        exit_code=exit_code,
                        duration_ms=int((time.time() - start) * 1000),
                        isolation_type=KernelIsolationType.WINDOWS_SANDBOX,
                        vm_id=vm_id,
                    )
                    await self.destroy(vm_id)
                    return result

                if proc.returncode is not None:
                    break

            await self.destroy(vm_id)
            return KernelSandboxResult(
                success=False,
                error=f"Timeout ({config.timeout_sec}s) or sandbox closed unexpectedly",
                exit_code=-1,
                duration_ms=int((time.time() - start) * 1000),
                isolation_type=KernelIsolationType.WINDOWS_SANDBOX,
                vm_id=vm_id,
            )

        except Exception as exc:
            log.warning("WindowsSandbox spawn failed", error=str(exc), vm_id=vm_id)
            self._cleanup_sandbox_files(vm_id)
            return KernelSandboxResult(
                success=False,
                error=str(exc),
                isolation_type=KernelIsolationType.WINDOWS_SANDBOX,
                vm_id=vm_id,
            )

    def _cleanup_sandbox_files(self, vm_id: str) -> None:
        info = self._active_sandboxes.pop(vm_id, {})
        for key in ("shared_dir", "wsb_path"):
            path = info.get(key, "")
            if path and Path(path).exists():
                try:
                    if Path(path).is_dir():
                        shutil.rmtree(path, ignore_errors=True)
                    else:
                        Path(path).unlink()
                except Exception:
                    pass

    async def destroy(self, vm_id: str) -> None:
        info = self._active_sandboxes.get(vm_id)
        if info is None:
            return
        proc = info.get("proc")
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
            except Exception:
                pass
        self._cleanup_sandbox_files(vm_id)
        log.info("WindowsSandbox destroyed", vm_id=vm_id)


_DEFAULT_BACKENDS: dict[KernelIsolationType, BackendInfo] = {
    KernelIsolationType.GVISOR: BackendInfo(
        name=KernelIsolationType.GVISOR,
        cls=GVisorBackend,
        priority=10,
        description="gVisor (runsc) — 系统调用过滤，Docker runtime 模式",
    ),
    KernelIsolationType.FIRECRACKER: BackendInfo(
        name=KernelIsolationType.FIRECRACKER,
        cls=FirecrackerBackend,
        priority=20,
        description="Firecracker — microVM 轻量虚拟机，jailer 隔离",
    ),
    KernelIsolationType.WINDOWS_SANDBOX: BackendInfo(
        name=KernelIsolationType.WINDOWS_SANDBOX,
        cls=WindowsSandboxBackend,
        priority=30,
        description="Windows Sandbox — Hyper-V 隔离，.wsb 配置驱动",
    ),
}


@dataclass
class BackendHealthStatus:
    backend_type: KernelIsolationType
    available: bool
    last_check_ms: float = 0.0
    consecutive_failures: int = 0
    last_error: str | None = None
    uptime_ratio: float = 1.0


@dataclass
class ProviderMetrics:
    spawn_count: int = 0
    spawn_success_count: int = 0
    spawn_error_count: int = 0
    destroy_count: int = 0
    degrade_count: int = 0
    total_spawn_ms: float = 0.0
    total_destroy_ms: float = 0.0
    backend_spawn_counts: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    backend_error_counts: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    backend_latency_ms: dict[str, list[float]] = field(default_factory=lambda: defaultdict(list))
    _max_latency_samples: int = 1000

    def record_spawn(self, backend_type: str, duration_ms: float, success: bool) -> None:
        self.spawn_count += 1
        self.total_spawn_ms += duration_ms
        self.backend_spawn_counts[backend_type] += 1
        if len(self.backend_latency_ms[backend_type]) >= self._max_latency_samples:
            self.backend_latency_ms[backend_type] = self.backend_latency_ms[backend_type][-self._max_latency_samples // 2:]
        self.backend_latency_ms[backend_type].append(duration_ms)
        if success:
            self.spawn_success_count += 1
        else:
            self.spawn_error_count += 1
            self.backend_error_counts[backend_type] += 1

    def record_destroy(self, duration_ms: float = 0.0) -> None:
        self.destroy_count += 1
        self.total_destroy_ms += duration_ms

    def record_degrade(self) -> None:
        self.degrade_count += 1

    @property
    def avg_spawn_ms(self) -> float:
        return self.total_spawn_ms / self.spawn_count if self.spawn_count else 0.0

    @property
    def error_rate(self) -> float:
        return self.spawn_error_count / self.spawn_count if self.spawn_count else 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "spawn_count": self.spawn_count,
            "spawn_success_count": self.spawn_success_count,
            "spawn_error_count": self.spawn_error_count,
            "destroy_count": self.destroy_count,
            "degrade_count": self.degrade_count,
            "avg_spawn_ms": round(self.avg_spawn_ms, 2),
            "error_rate": round(self.error_rate, 4),
            "backends": {
                k: {
                    "spawns": v,
                    "errors": self.backend_error_counts.get(k, 0),
                    "avg_latency_ms": round(
                        sum(self.backend_latency_ms.get(k, [])) / len(self.backend_latency_ms.get(k, [])), 2
                    ) if self.backend_latency_ms.get(k) else 0.0,
                }
                for k, v in self.backend_spawn_counts.items()
            },
        }


class KernelEventHooks:
    def __init__(self) -> None:
        self._on_spawn: list[Callable[..., Any]] = []
        self._on_destroy: list[Callable[..., Any]] = []
        self._on_error: list[Callable[..., Any]] = []
        self._on_degrade: list[Callable[..., Any]] = []
        self._on_health_change: list[Callable[..., Any]] = []

    def on_spawn(self, callback: Callable[..., Any]) -> None:
        self._on_spawn.append(callback)

    def on_destroy(self, callback: Callable[..., Any]) -> None:
        self._on_destroy.append(callback)

    def on_error(self, callback: Callable[..., Any]) -> None:
        self._on_error.append(callback)

    def on_degrade(self, callback: Callable[..., Any]) -> None:
        self._on_degrade.append(callback)

    def on_health_change(self, callback: Callable[..., Any]) -> None:
        self._on_health_change.append(callback)

    async def emit_spawn(self, **kwargs: Any) -> None:
        for cb in self._on_spawn:
            try:
                result = cb(**kwargs)
                if asyncio.iscoroutine(result):
                    await result
            except Exception as exc:
                log.debug("Event hook error (on_spawn)", error=str(exc))

    async def emit_destroy(self, **kwargs: Any) -> None:
        for cb in self._on_destroy:
            try:
                result = cb(**kwargs)
                if asyncio.iscoroutine(result):
                    await result
            except Exception as exc:
                log.debug("Event hook error (on_destroy)", error=str(exc))

    async def emit_error(self, **kwargs: Any) -> None:
        for cb in self._on_error:
            try:
                result = cb(**kwargs)
                if asyncio.iscoroutine(result):
                    await result
            except Exception as exc:
                log.debug("Event hook error (on_error)", error=str(exc))

    async def emit_degrade(self, **kwargs: Any) -> None:
        for cb in self._on_degrade:
            try:
                result = cb(**kwargs)
                if asyncio.iscoroutine(result):
                    await result
            except Exception as exc:
                log.debug("Event hook error (on_degrade)", error=str(exc))

    async def emit_health_change(self, **kwargs: Any) -> None:
        for cb in self._on_health_change:
            try:
                result = cb(**kwargs)
                if asyncio.iscoroutine(result):
                    await result
            except Exception as exc:
                log.debug("Event hook error (on_health_change)", error=str(exc))


class KernelIsolationProvider:
    """插件化内核隔离提供者 — 统一注册中心 (Phase 3+4 增强)。

    支持：
    - 动态注册/注销后端插件
    - 按优先级自动选择可用后端
    - 统一 spawn/destroy 接口
    - 后端信息查询
    - 健康检查 (health_check) — 周期性检测后端可用性
    - 事件钩子 (on_spawn/on_destroy/on_error/on_degrade/on_health_change)
    - 指标采集 (调用计数/延迟/错误率)
    - 配置热更新 (运行时修改后端优先级)
    """

    _registry: dict[KernelIsolationType, BackendInfo] = dict(_DEFAULT_BACKENDS)
    _instances: dict[KernelIsolationType, KernelIsolationBackend] = {}
    _metrics: ProviderMetrics = ProviderMetrics()
    _hooks: KernelEventHooks = KernelEventHooks()
    _health_status: dict[KernelIsolationType, BackendHealthStatus] = {}
    _health_check_interval_sec: float = 60.0
    _last_health_check: float = 0.0

    @classmethod
    def register_backend(
        cls,
        iso_type: KernelIsolationType,
        backend_cls: type[KernelIsolationBackend],
        priority: int = 50,
        description: str = "",
    ) -> None:
        cls._registry[iso_type] = BackendInfo(
            name=iso_type,
            cls=backend_cls,
            priority=priority,
            description=description,
        )
        if iso_type in cls._instances:
            del cls._instances[iso_type]
        log.info("Backend registered", type=iso_type.value, priority=priority)

    @classmethod
    def unregister_backend(cls, iso_type: KernelIsolationType) -> bool:
        if iso_type not in cls._registry:
            return False
        del cls._registry[iso_type]
        cls._instances.pop(iso_type, None)
        log.info("Backend unregistered", type=iso_type.value)
        return True

    @classmethod
    def list_backends(cls) -> list[BackendInfo]:
        return sorted(cls._registry.values(), key=lambda b: b.priority)

    @classmethod
    async def is_available(cls) -> bool:
        for info in cls.list_backends():
            backend = cls._instances.get(info.name)
            if backend is None:
                backend = info.cls()
                cls._instances[info.name] = backend
            if await backend.is_available():
                log.info("Kernel isolation available", type=info.name.value, priority=info.priority)
                return True
        return False

    @classmethod
    def get_backend(cls, iso_type: KernelIsolationType) -> KernelIsolationBackend:
        if iso_type not in cls._registry:
            raise ValueError(f"Unknown backend type: {iso_type.value}. Available: {[b.name.value for b in cls.list_backends()]}")
        if iso_type not in cls._instances:
            cls._instances[iso_type] = cls._registry[iso_type].cls()
        return cls._instances[iso_type]

    @classmethod
    async def auto_select(cls) -> KernelIsolationType | None:
        for info in cls.list_backends():
            backend = cls.get_backend(info.name)
            if await backend.is_available():
                return info.name
        return None

    @classmethod
    async def spawn(
        cls,
        code: str,
        language: str,
        config: KernelSandboxConfig | None = None,
    ) -> KernelSandboxResult:
        if config is None:
            config = KernelSandboxConfig()

        iso_type = config.isolation_type
        auto = await cls.auto_select()
        if auto is None:
            cls._metrics.record_spawn("none", 0.0, False)
            await cls._hooks.emit_error(
                error="No kernel isolation backend available",
                requested=iso_type.value,
            )
            return KernelSandboxResult(
                success=False,
                error="No kernel isolation backend available",
            )
        if auto != iso_type:
            cls._metrics.record_degrade()
            await cls._hooks.emit_degrade(
                requested=iso_type.value,
                actual=auto.value,
            )
            log.info("Kernel isolation degraded", requested=iso_type.value, actual=auto.value)
        iso_type = auto
        config.isolation_type = iso_type

        backend = cls.get_backend(iso_type)
        start = time.time()
        result = await backend.spawn(code, language, config)
        duration_ms = (time.time() - start) * 1000

        cls._metrics.record_spawn(iso_type.value, duration_ms, result.success)
        if result.success:
            await cls._hooks.emit_spawn(
                backend=iso_type.value,
                vm_id=result.vm_id,
                duration_ms=duration_ms,
            )
        else:
            await cls._hooks.emit_error(
                backend=iso_type.value,
                error=result.error,
                duration_ms=duration_ms,
            )

        return result

    @classmethod
    async def destroy(cls, vm_id: str) -> None:
        start = time.time()
        for info in cls.list_backends():
            backend = cls._instances.get(info.name)
            if backend is not None:
                try:
                    await backend.destroy(vm_id)
                except Exception:
                    pass
        duration_ms = (time.time() - start) * 1000
        cls._metrics.record_destroy(duration_ms)
        await cls._hooks.emit_destroy(vm_id=vm_id, duration_ms=duration_ms)

    @classmethod
    async def health_check(cls, force: bool = False) -> dict[str, BackendHealthStatus]:
        """周期性后端健康检查。

        检测每个已注册后端的可用性，更新健康状态，触发事件钩子。
        默认按 _health_check_interval_sec 间隔执行，force=True 立即执行。
        """
        now = time.time()
        if not force and (now - cls._last_health_check) < cls._health_check_interval_sec:
            return dict(cls._health_status)

        cls._last_health_check = now
        results: dict[KernelIsolationType, BackendHealthStatus] = {}

        for info in cls.list_backends():
            start = time.time()
            try:
                backend = cls.get_backend(info.name)
                available = await backend.is_available()
            except Exception as exc:
                available = False
                log.warning("Health check failed", backend=info.name.value, error=str(exc))

            check_ms = (time.time() - start) * 1000
            prev = cls._health_status.get(info.name)
            consecutive_failures = 0
            last_error = None
            uptime_ratio = 1.0

            if prev is not None:
                if not available:
                    consecutive_failures = prev.consecutive_failures + 1
                    last_error = f"unavailable (consecutive: {consecutive_failures})"
                else:
                    consecutive_failures = 0
                total_checks = prev.consecutive_failures + 1 + (1 if available else 0)
                success_checks = total_checks - consecutive_failures
                uptime_ratio = success_checks / total_checks if total_checks else 1.0
            elif not available:
                consecutive_failures = 1
                last_error = "unavailable"
                uptime_ratio = 0.0

            status = BackendHealthStatus(
                backend_type=info.name,
                available=available,
                last_check_ms=check_ms,
                consecutive_failures=consecutive_failures,
                last_error=last_error,
                uptime_ratio=uptime_ratio,
            )
            results[info.name] = status

            if prev is not None and prev.available != available:
                await cls._hooks.emit_health_change(
                    backend=info.name.value,
                    was_available=prev.available,
                    now_available=available,
                )

        cls._health_status = results
        return results

    @classmethod
    def update_backend_priority(
        cls,
        iso_type: KernelIsolationType,
        priority: int,
    ) -> bool:
        """运行时修改后端优先级 (配置热更新)。

        Args:
            iso_type: 后端类型。
            priority: 新优先级 (数值越小优先级越高)。

        Returns:
            True 如果后端存在且优先级已更新。
        """
        if iso_type not in cls._registry:
            return False
        old_priority = cls._registry[iso_type].priority
        cls._registry[iso_type] = BackendInfo(
            name=iso_type,
            cls=cls._registry[iso_type].cls,
            priority=priority,
            description=cls._registry[iso_type].description,
        )
        log.info("Backend priority updated", type=iso_type.value, old=old_priority, new=priority)
        return True

    @classmethod
    def get_metrics(cls) -> ProviderMetrics:
        """获取当前指标快照。"""
        return cls._metrics

    @classmethod
    def get_hooks(cls) -> KernelEventHooks:
        """获取事件钩子注册器。"""
        return cls._hooks

    @classmethod
    def get_health_status(cls) -> dict[str, BackendHealthStatus]:
        """获取当前健康状态快照 (按 backend 名称索引)。"""
        return {k.value: v for k, v in cls._health_status.items()}

    @classmethod
    def reset(cls) -> None:
        cls._registry = dict(_DEFAULT_BACKENDS)
        cls._instances = {}
        cls._metrics = ProviderMetrics()
        cls._hooks = KernelEventHooks()
