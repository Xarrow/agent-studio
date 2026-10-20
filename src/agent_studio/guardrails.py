"""危险动作闸门 —— 助手能起任意命令之后，这一层不能缺。

为什么在**平台层**做
------------------
AgentScope 自带权限引擎（``accept_edits`` 默认）只按"目标在不在工作目录内"判断：
工作目录里 ``rm -rf .`` 是放行的。可用户真正怕的不是"越界写文件"，而是

    rm -rf ~、dd of=/dev/sda、curl … | sh、shutdown、crontab -r、mysql DROP TABLE

这些命令即使**在**工作目录里执行，损失也不可逆。所以这里按**命令语义**再判一层：

    deny  —— 灾难性、不可逆：不执行，直接把理由回给模型（也写进工具结果）
    ask   —— 会破坏东西但有时确实需要：停下来等人点头（走平台已有的 HITL 授权条）
    allow —— 没看出问题：交给原有权限引擎按工作目录边界继续判

无人值守（定时任务、编排里跑的分派实例）**没人能点头**，所以那里的 ask 一律降级成
deny —— 挂在那里干等过期，比直接拒绝更糟：用户第二天看到的是"任务一直在跑"。

判定基于**拆分后的 shell 片段 + 词元**，不是在整串上正则 ——
``echo "rm -rf /"`` 和 ``rm -rf /`` 得分得开前者的"只是打印"，但也别忘了前者
仍可能是注入；所以"命令名不在名单里但参数里出现致命模式"仍按最坏情况处理。
"""

from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass

#: 允许 / 需要确认 / 直接拒绝
RISK_DENY = "deny"
RISK_ASK = "ask"
RISK_ALLOW = "allow"


@dataclass(frozen=True)
class Verdict:
    """一次判定的结论。``reason`` 是给**人**看的中文，会出现在授权条和工具结果里。"""

    risk: str
    reason: str
    #: 命中的规则名（排查与单测用，不进界面）
    rule: str = ""
    #: 判定时看到的命令片段（截断后给人看"是哪一段触发的"）
    snippet: str = ""

    @property
    def is_deny(self) -> bool:
        return self.risk == RISK_DENY

    @property
    def is_ask(self) -> bool:
        return self.risk == RISK_ASK


ALLOW = Verdict(RISK_ALLOW, "")


# --------------------------------------------------------------------------- #
# 词法：把一串命令拆成"片段"
# --------------------------------------------------------------------------- #
#: 这些操作符把一条命令切成几段，每段单独判（``a && rm -rf /`` 里的 rm 必须被看见）
_SPLIT = re.compile(r"\|\||&&|;;|;|\n|\|")

#: 前缀包装词：判命令名时跳过它们（``sudo rm`` 要看的是 rm）
_WRAPPERS = {"sudo", "doas", "env", "nohup", "time", "exec", "command", "builtin", "nice", "ionice", "stdbuf"}

#: 写入/删除类命令里最容易出事的那批
_SHELLS = {"sh", "bash", "zsh", "dash", "ash", "ksh", "fish", "csh", "tcsh"}
_DOWNLOADERS = {"curl", "wget", "fetch", "aria2c", "http", "https"}

#: 灾难性目标：这些路径被递归删/写，基本等于把机器或平台数据毁掉
_CATASTROPHIC_ROOTS = {
    "/", "/*", "/.", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc",
    "/sbin", "/sys", "/usr", "/var", "/opt", "/home", "/root", "~", "~/*", "$HOME",
    "${HOME}", "/srv/src/agent-studio/data", "/srv/src/agent-studio/src",
}

#: 带凭据的路径：读到就够危险了（外泄 / 被改写）
_SECRET_HINTS = (".env", ".ssh/", ".ssh", ".aws/", "credentials", ".kube/config", ".hermes/.env")

#: 系统路径：写它们要人确认（助手该在自己的工作目录里活动）
_SYSTEM_PREFIXES = ("/etc/", "/usr/", "/bin/", "/sbin/", "/boot/", "/var/", "/opt/", "/lib/", "/root/", "/srv/")


def _segments(command: str) -> list[str]:
    return [s.strip() for s in _SPLIT.split(command or "") if s.strip()]


def _tokens(segment: str) -> list[str]:
    """拆词；引号不闭合（模型常写半截命令）时退回普通切分，不要因此漏判。"""
    try:
        return shlex.split(segment, comments=False, posix=True)
    except ValueError:
        return segment.split()


def _cmd_index(tokens: list[str]) -> int:
    """跳过 ``VAR=1 sudo nice -n 5`` 这类前缀，找到真正的命令名。"""
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tok):  # 环境变量赋值
            i += 1
            continue
        base = os.path.basename(tok)
        if base in _WRAPPERS:
            i += 1
            # 包装词自己的选项：``nice -n 5`` / ``stdbuf -o0``
            while i < len(tokens) and tokens[i].startswith("-"):
                i += 1
            continue
        return i
    return -1


def _short(segment: str, limit: int = 160) -> str:
    s = " ".join(segment.split())
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _is_inside(path: str, workspace: str | None) -> bool:
    if not workspace:
        return False
    if not path.startswith("/"):
        return True  # 相对路径按"就在工作目录里"算
    try:
        return os.path.commonpath([os.path.abspath(path), os.path.abspath(workspace)]) == os.path.abspath(workspace)
    except ValueError:
        return False


def _out_of_workspace_paths(tokens: list[str], workspace: str | None) -> list[str]:
    """命令里明显指向系统目录的绝对路径（写/删/改的目标）。"""
    hits: list[str] = []
    for tok in tokens:
        if not tok.startswith("/"):
            continue
        if _is_inside(tok, workspace):
            continue
        if any(tok.startswith(p) for p in _SYSTEM_PREFIXES) or tok in _CATASTROPHIC_ROOTS:
            hits.append(tok)
    return hits


def _redirect_targets(segment: str) -> list[str]:
    """``> /etc/x`` / ``>> file`` / ``tee -a /etc/x`` 的目标。"""
    targets: list[str] = []
    for m in re.finditer(r"(?:^|\s)\d?>{1,2}\s*([^\s;|&]+)", segment):
        targets.append(m.group(1))
    m = re.search(r"\btee\b([^;|&]*)", segment)
    if m:
        targets += [t for t in _tokens(m.group(0))[1:] if not t.startswith("-")]
    return targets


# --------------------------------------------------------------------------- #
# 单段判定
# --------------------------------------------------------------------------- #
def _verdict_rm(tokens: list[str], workspace: str | None, seg: str) -> Verdict | None:
    # 先认命令名：不认的话 `echo hi > /etc/motd` 的目标会被当成"要删的东西"，
    # 授权条上就会写着"要递归删除 hi" —— 理由错了比没有理由更糟（用户无从判断）。
    name = os.path.basename(tokens[0])
    if name not in {"rm", "rmdir", "unlink", "srm", "trash"}:
        return None
    flags = " ".join(t for t in tokens if t.startswith("-"))
    recursive = bool(re.search(r"(^|\s)-[a-zA-Z]*[rR]", flags)) or "--recursive" in flags
    force = bool(re.search(r"(^|\s)-[a-zA-Z]*f", flags)) or "--force" in flags
    targets = [t for t in tokens[1:] if not t.startswith("-")]
    if not targets:
        return None
    hard = [t for t in targets if t.rstrip("/") in {c.rstrip("/") for c in _CATASTROPHIC_ROOTS}]
    if hard:
        return Verdict(
            RISK_DENY,
            f"要递归删除 {hard[0]} —— 这会把系统或平台数据一起抹掉，已拒绝执行",
            "rm-catastrophic",
            _short(seg),
        )
    secret = [t for t in targets if any(h in t for h in _SECRET_HINTS)]
    if secret:
        return Verdict(RISK_ASK, f"要删除凭据相关文件 {secret[0]}", "rm-secret", _short(seg))
    outside = [t for t in targets if t.startswith("/") and not _is_inside(t, workspace)]
    if recursive or outside:
        where = f"（工作目录外：{outside[0]}）" if outside else ""
        return Verdict(RISK_ASK, f"要递归删除 {targets[0]}{where}，删掉就找不回来", "rm-recursive", _short(seg))
    return None


def _verdict_disk(tokens: list[str], seg: str) -> Verdict | None:
    name = os.path.basename(tokens[0])
    if name.startswith("mkfs") or name in {"mke2fs", "wipefs", "fdisk", "parted", "sgdisk"}:
        return Verdict(RISK_DENY, f"要对磁盘做分区/格式化（{name}），这是在动硬件，已拒绝", "disk-format", _short(seg))
    if name == "dd":
        joined = " ".join(tokens)
        m = re.search(r"\bof=(/dev/[^\s]+|/etc/[^\s]+)", joined)
        if m:
            return Verdict(RISK_DENY, f"要直接写设备或系统文件（dd of={m.group(1)}），已拒绝", "dd-device", _short(seg))
        return Verdict(RISK_ASK, "要用 dd 写数据，容易覆盖错目标", "dd", _short(seg))
    if re.search(r">{1,2}\s*/dev/(sd|nvme|hd|vd|xvd)", seg):
        return Verdict(RISK_DENY, "要把输出直接写进裸设备，会毁掉磁盘数据，已拒绝", "raw-device-write", _short(seg))
    if name in {"shred", "truncate"}:
        return Verdict(RISK_ASK, f"要用 {name} 抹掉文件内容（不可恢复）", name, _short(seg))
    return None


def _verdict_power(tokens: list[str], seg: str) -> Verdict | None:
    name = os.path.basename(tokens[0])
    if name in {"shutdown", "reboot", "halt", "poweroff", "kexec"} or (name == "init" and len(tokens) > 1 and tokens[1] in {"0", "6"}):
        return Verdict(RISK_DENY, "要让机器关机/重启 —— 这会掐断所有正在跑的任务，已拒绝", "power", _short(seg))
    return None


def _verdict_service(tokens: list[str], seg: str) -> Verdict | None:
    name = os.path.basename(tokens[0])
    if name in {"systemctl", "service", "launchctl", "sc"}:
        words = [t for t in tokens[1:] if not t.startswith("-")]
        verb = next((w for w in words if w in {"stop", "restart", "disable", "mask", "kill", "start", "enable", "reload"}), None)
        if verb in {"stop", "restart", "disable", "mask", "kill"}:
            unit = next((w for w in words if w not in {verb}), "")
            if unit and any(k in unit for k in ("sshd", "ssh", "docker", "nginx", "postgres", "mysql", "network", "systemd")):
                return Verdict(RISK_ASK, f"要 {verb} 系统服务 {unit} —— 可能把你自己或这台机器上的服务弄下线", "service", _short(seg))
            return Verdict(RISK_ASK, f"要 {verb} 服务 {unit or ''}".strip(), "service", _short(seg))
    return None


def _verdict_perm(tokens: list[str], seg: str) -> Verdict | None:
    name = os.path.basename(tokens[0])
    if name not in {"chmod", "chown", "chgrp", "setfacl"}:
        return None
    flags = " ".join(t for t in tokens if t.startswith("-"))
    recursive = "-R" in flags or "--recursive" in flags
    targets = [t for t in tokens[1:] if not t.startswith("-")]
    hard = [t for t in targets if t.rstrip("/") in {c.rstrip("/") for c in _CATASTROPHIC_ROOTS}]
    if hard:
        return Verdict(RISK_DENY, f"要递归改 {hard[0]} 的权限，等于把整台机器交出去，已拒绝", "perm-root", _short(seg))
    if recursive or "777" in flags or any("777" in t for t in targets):
        return Verdict(RISK_ASK, f"要放宽权限（{name} {'-R' if recursive else ''} 777）", "perm-loose", _short(seg))
    return None


def _verdict_kill(tokens: list[str], seg: str) -> Verdict | None:
    name = os.path.basename(tokens[0])
    if name not in {"kill", "pkill", "killall", "xkill"}:
        return None
    if name == "kill" and ("-1" in tokens or "-9" in tokens):
        if "-1" in tokens:
            return Verdict(RISK_DENY, "要杀掉所有进程（kill -1），等于让整台机器停摆，已拒绝", "kill-all", _short(seg))
    return Verdict(RISK_ASK, f"要杀进程（{name}）—— 可能连别的东西一起带走", "kill", _short(seg))


def _verdict_pkg(tokens: list[str], seg: str) -> Verdict | None:
    name = os.path.basename(tokens[0])
    verbs = set(tokens[1:])
    if name in {"apt", "apt-get", "yum", "dnf", "apk", "pacman", "zypper", "brew", "snap"}:
        if verbs & {"install", "remove", "purge", "autoremove", "upgrade", "dist-upgrade", "-Syu", "-Rns"}:
            return Verdict(RISK_ASK, f"要改系统装的包（{name} {' '.join(sorted(verbs & {'install','remove','purge','upgrade'})) or '操作'}）", "pkg", _short(seg))
    if name in {"pip", "pip3"} and verbs & {"install", "uninstall"}:
        return Verdict(RISK_ASK, f"要装/卸 Python 包（{name}）—— 只影响环境，但会改动运行中的服务", "pip", _short(seg))
    if name in {"npm", "pnpm", "yarn"} and verbs & {"install", "add", "remove", "uninstall"} and "-g" in tokens:
        return Verdict(RISK_ASK, f"要全局装/卸 npm 包（{name} -g）", "npm-global", _short(seg))
    return None


def _verdict_git(tokens: list[str], seg: str) -> Verdict | None:
    if os.path.basename(tokens[0]) != "git":
        return None
    words = [t for t in tokens[1:] if not t.startswith("-")]
    joined = " ".join(tokens)
    if "--force" in tokens or re.search(r"\s-[a-zA-Z]*f", joined):
        if "push" in words:
            return Verdict(RISK_ASK, "要强推远端（git push --force）—— 会覆盖别人的提交", "git-force-push", _short(seg))
    if "reset" in words and "--hard" in tokens:
        return Verdict(RISK_ASK, "要 git reset --hard —— 本地未提交的改动会被丢掉", "git-reset-hard", _short(seg))
    if "clean" in words and re.search(r"-[a-zA-Z]*[fd]", joined):
        return Verdict(RISK_ASK, "要 git clean -f —— 未跟踪的文件会被删掉", "git-clean", _short(seg))
    return None


def _verdict_docker(tokens: list[str], seg: str) -> Verdict | None:
    if os.path.basename(tokens[0]) not in {"docker", "podman", "nerdctl", "kubectl"}:
        return None
    words = [t for t in tokens[1:] if not t.startswith("-")]
    if not words:
        return None
    if words[0] in {"rm", "rmi", "prune", "system"} and any(w in words for w in {"rm", "rmi", "prune"}) or "prune" in words:
        return Verdict(RISK_ASK, f"要删容器/镜像（{' '.join(words[:3])}），删掉的跑不起来", "container-rm", _short(seg))
    if words[0] == "delete":
        return Verdict(RISK_ASK, "要删集群资源（kubectl delete）", "k8s-delete", _short(seg))
    return None


def _verdict_cron(tokens: list[str], seg: str) -> Verdict | None:
    if os.path.basename(tokens[0]) != "crontab":
        return None
    if "-r" in tokens:
        return Verdict(RISK_DENY, "要清空 crontab（crontab -r）—— 定时任务会一起消失且没人告诉你，已拒绝", "cron-wipe", _short(seg))
    if "-e" in tokens:
        return Verdict(RISK_ASK, "要改 crontab（改坏了不会有报错）", "cron-edit", _short(seg))
    return None


def _verdict_db(tokens: list[str], seg: str) -> Verdict | None:
    name = os.path.basename(tokens[0])
    if name not in {"psql", "mysql", "mariadb", "sqlite3", "mongo", "mongosh", "redis-cli"}:
        return None
    text = " ".join(tokens).upper()
    if re.search(r"DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|FLUSHALL|FLUSHDB", text):
        return Verdict(RISK_ASK, "要删库/清空表（不可恢复）", "sql-drop", _short(seg))
    if re.search(r"DELETE\s+FROM\s+\w+\s*;", text):
        return Verdict(RISK_ASK, "要删整张表的数据（没有 WHERE）", "sql-delete-all", _short(seg))
    return None


def _verdict_secrets(tokens: list[str], seg: str) -> Verdict | None:
    joined = " ".join(tokens)
    hit = next((h for h in _SECRET_HINTS if h in joined), None)
    if hit:
        return Verdict(RISK_ASK, f"要碰凭据文件（{hit}）—— 里面的 key 一旦出去就收不回来", "secret-path", _short(seg))
    return None


def _verdict_redirect(seg: str, workspace: str | None) -> Verdict | None:
    targets = [t for t in _redirect_targets(seg) if t.startswith("/")]
    outside = [t for t in targets if not _is_inside(t, workspace)]
    if outside:
        return Verdict(RISK_ASK, f"要写工作目录外的文件（{outside[0]}），助手本该只动自己的目录", "write-outside", _short(seg))
    return None


def _verdict_forkbomb(seg: str) -> Verdict | None:
    if re.search(r"\(\s*\)\s*\{\s*:?\s*\|\s*:?\s*&\s*\}|\bwhile\s+true\s*;?\s*do", seg):
        return Verdict(RISK_DENY, "这是 fork 炸弹/死循环，会把这台机器拖死，已拒绝", "forkbomb", _short(seg))
    return None


def _verdict_eval(tokens: list[str], seg: str) -> Verdict | None:
    name = os.path.basename(tokens[0])
    if name in {"eval"}:
        return Verdict(RISK_ASK, "要用 eval 执行拼出来的字符串（看不出要干什么）", "eval", _short(seg))
    if name in {"find"} and "-delete" in tokens:
        return Verdict(RISK_ASK, "要用 find -delete 批量删文件", "find-delete", _short(seg))
    return None


#: 单段判定的顺序（越靠前越是"一票否决"）。
#: 统一成 ``(tokens, segment, workspace) -> Verdict | None`` 一个签名，
#: 免得每个规则各写一套参数顺序 —— 那种东西第一个 bug 就是传错参。
_SEGMENT_CHECKS = (
    lambda t, s, w: _verdict_forkbomb(s),
    lambda t, s, w: _verdict_power(t, s),
    lambda t, s, w: _verdict_disk(t, s),
    lambda t, s, w: _verdict_rm(t, w, s),
    lambda t, s, w: _verdict_perm(t, s),
    lambda t, s, w: _verdict_cron(t, s),
    lambda t, s, w: _verdict_service(t, s),
    lambda t, s, w: _verdict_kill(t, s),
    lambda t, s, w: _verdict_git(t, s),
    lambda t, s, w: _verdict_docker(t, s),
    lambda t, s, w: _verdict_db(t, s),
    lambda t, s, w: _verdict_pkg(t, s),
    lambda t, s, w: _verdict_eval(t, s),
    lambda t, s, w: _verdict_secrets(t, s),
)


# --------------------------------------------------------------------------- #
# 对外入口
# --------------------------------------------------------------------------- #
def classify_command(command: str, workspace: str | None = None) -> Verdict:
    """判一条 shell 命令。多段时取**最坏**的那一段（``ls && rm -rf /`` 必须拦）。"""
    if not (command or "").strip():
        return ALLOW
    # fork 炸弹先整串判：它自带 `|`，一拆分就认不出来了
    bomb = _verdict_forkbomb(command)
    if bomb is not None:
        return bomb
    worst = ALLOW
    segments = _segments(command)
    for idx, seg in enumerate(segments):
        tokens = _tokens(seg)
        if not tokens:
            continue
        # 前缀包装（sudo/nohup…）跳过后再判；sudo 自身单独提示
        ci = _cmd_index(tokens)
        if ci < 0:
            continue
        real = tokens[ci:]
        base = os.path.basename(real[0])

        # ``curl … | sh``：管道右侧是 shell，左侧是下载器
        if base in _SHELLS and idx > 0:
            prev_tokens = _tokens(segments[idx - 1])
            prev_ci = _cmd_index(prev_tokens) if prev_tokens else -1
            prev_name = os.path.basename(prev_tokens[prev_ci]) if prev_ci >= 0 else ""
            if prev_name in _DOWNLOADERS:
                cand = Verdict(RISK_ASK, "要把网上下载的脚本直接执行（curl | sh）—— 内容你还没看过", "curl-pipe-sh", _short(command))
                worst = _worse(worst, cand)
            continue

        if real[0] != tokens[ci] or tokens[0] in {"sudo", "doas"}:
            cand = Verdict(RISK_ASK, "要提权执行（sudo）", "sudo", _short(seg))
            worst = _worse(worst, cand)

        for check in _SEGMENT_CHECKS:
            cand = check(real, seg, workspace)
            if cand is not None:
                worst = _worse(worst, cand)
                break
        # 重定向写到工作目录外
        cand = _verdict_redirect(seg, workspace)
        if cand is not None:
            worst = _worse(worst, cand)
        if worst.risk == RISK_DENY:
            return worst
    return worst


#: 代码里出现这些词就值得从它开始截一段当命令看
_DANGER_WORD_RE = re.compile(
    r"\b(rm|rmdir|unlink|srm|trash|dd|mkfs\S*|shutdown|reboot|crontab|chmod|chown|"
    r"pkill|killall|kill|curl|wget|git)\b"
)


def classify_code(code: str, workspace: str | None = None) -> Verdict:
    """判一段 Python 代码。

    只能在**文本层**判：代码是图灵完备的，静态分析永远能绕。这里的目标不是
    "证明安全"，而是"把明显的、模型常犯的那几类（os.system 里 rm -rf、
    shutil.rmtree('/')、open('/etc/…','w')）挡住"。
    """
    text = code or ""
    if not text.strip():
        return ALLOW
    # 直接把代码当命令扫一遍：`os.system("rm -rf /")`、`subprocess.run(["rm","-rf","/"])`
    worst = classify_command(text, workspace)
    # 再逐个字符串字面量判一次 —— 上面那遍里 `os.system("rm -rf /")` 整体只是一个词元，
    # 命令名认不出来；拆出引号内容才看得见里面的 rm。
    for literal in re.findall(r"[\"']([^\"'\n]{3,400})[\"']", text):
        worst = _worse(worst, classify_command(literal, workspace))
        if worst.risk == RISK_DENY:
            return worst
    if worst.risk == RISK_DENY:
        return worst
    if re.search(r"shutil\.rmtree\s*\(\s*['\"](/|~|\$HOME)", text):
        return Verdict(RISK_DENY, "代码里要 shutil.rmtree 删系统目录，已拒绝", "py-rmtree-root", _short(text))
    # 把括号、引号、逗号抹成空格再扫一遍：`subprocess.run(["rm","-rf","./x"])` 这种
    # 逐字面量扫不出来（'rm' 后面跟的是另一个字面量 '-rf'，中间隔了引号逗号），
    # 但抹平之后就是一句完整的 `rm -rf ./x`。现场就是靠这条路绕过闸门把目录删掉的。
    flat = re.sub(r"[\[\]()'\",=]", " ", text)
    worst = _worse(worst, classify_command(flat, workspace))
    if worst.risk == RISK_DENY:
        return worst
    # 代码里危险命令前面常带着别的词（`import subprocess subprocess.run rm -rf x`），
    # 整段交给命令解析时命令名认不出来。所以按行从"危险命令名"处截一段再判。
    for line in flat.splitlines():
        m = re.search(_DANGER_WORD_RE, line)
        if m:
            worst = _worse(worst, classify_command(line[m.start() :], workspace))
            if worst.risk == RISK_DENY:
                return worst
    if re.search(r"shutil\.rmtree\s*\(", text):
        return Verdict(
            RISK_ASK,
            "代码里要递归删掉一个目录（shutil.rmtree），删掉就找不回来",
            "py-rmtree",
            _short(text),
        )
    if re.search(r"os\.(rmdir|removedirs)\s*\(", text):
        return Verdict(
            RISK_ASK, "代码里要删掉一个目录（os.rmdir），删掉就找不回来", "py-rmdir", _short(text)
        )
    if re.search(r"open\s*\(\s*['\"](/etc/|/usr/|/boot/|/root/)", text):
        return Verdict(RISK_ASK, "代码要写系统目录下的文件", "py-write-system", _short(text))
    if re.search(r"os\.(remove|unlink|rmdir)\s*\(\s*['\"](/etc/|/usr/|/boot/|/root/)", text):
        return Verdict(RISK_ASK, "代码要删系统目录下的文件", "py-remove-system", _short(text))
    return worst


#: 工具名 → 判定方式（认不出的工具不表态，交给原有权限引擎）
_COMMAND_TOOLS = {"bash", "shell", "sh", "zsh", "run_command", "terminal", "execute", "cmd", "proc_start", "procstart"}
_CODE_TOOLS = {"python", "pythonrepl", "python_repl", "py", "ipython", "notebook", "execute_code"}

#: 参数里可能是命令的键
_COMMAND_KEYS = ("command", "cmd", "script", "shell")
_CODE_KEYS = ("code", "source", "python", "script")


def classify_tool_call(name: str, tool_input: dict | None, workspace: str | None = None) -> Verdict | None:
    """判一次工具调用。返回 ``None`` 表示"没意见"（由原有权限引擎按工作目录边界继续判）。"""
    short = (name or "").split("/")[-1].split(".")[-1].lower()
    if "__" in short:
        short = short.split("__")[-1]
    data = tool_input or {}
    if not isinstance(data, dict):
        return None

    keys = _COMMAND_KEYS if short in _COMMAND_TOOLS else (_CODE_KEYS if short in _CODE_TOOLS else ())
    if not keys:
        return None
    raw = next((data[k] for k in keys if isinstance(data.get(k), str) and data[k].strip()), "")
    if not raw:
        return None
    return classify_code(raw, workspace) if short in _CODE_TOOLS else classify_command(raw, workspace)


def _worse(a: Verdict, b: Verdict) -> Verdict:
    order = {RISK_ALLOW: 0, RISK_ASK: 1, RISK_DENY: 2}
    return b if order[b.risk] > order[a.risk] else a


def downgrade_if_unattended(verdict: Verdict) -> Verdict:
    """没人看的时候，``ask`` 等于"挂到超时"，一律降成 ``deny``。"""
    if verdict.risk != RISK_ASK:
        return verdict
    return Verdict(
        RISK_DENY,
        f"这一轮没有人在看着（定时/无人值守），所以没有执行：{verdict.reason}",
        f"{verdict.rule}-unattended",
        verdict.snippet,
    )
