import subprocess
import sys
from pathlib import Path

PUBLISHER = Path(r"c:\Users\Administrator\.trae-cn\skills\folotoy-ai-passport-publisher\scripts\publisher.py")
COPY = Path(r"f:\Desktop\test\publish_assets\copy")
ASSETS = Path(r"f:\Desktop\test\publish_assets")
FIRMWARE = Path(r"f:\Desktop\test\tesla-offline-ble\build\tesla-offline-ble-full.bin")
SOURCE_URL = "https://github.com/chen970526/ai-passport-test"


def read(name: str) -> str:
    return (COPY / name).read_text(encoding="utf-8").strip()


def run(mode: str) -> int:
    if mode == "validate":
        cmd = [sys.executable, str(PUBLISHER), "validate",
               "--firmware", str(FIRMWARE), "--cover", str(ASSETS / "cover.jpg")]
        return subprocess.call(cmd)
    cmd = [sys.executable, str(PUBLISHER), "submit",
           "--title-zh", read("title-zh.txt"),
           "--description-zh", read("description-zh.txt"),
           "--title-en", read("title-en.txt"),
           "--description-en", read("description-en.txt"),
           "--instructions-zh-file", str(COPY / "instructions-zh.txt"),
           "--instructions-en-file", str(COPY / "instructions-en.txt"),
           "--firmware", str(FIRMWARE),
           "--cover", str(ASSETS / "cover.jpg"),
           "--image", str(ASSETS / "screen-bind.jpg"),
           "--image", str(ASSETS / "screen-vin.jpg"),
           "--source-url", SOURCE_URL]
    if mode == "auto":
        cmd.append("--auto")
    if mode == "update":
        # 更新已有玩法 1149：必须用官网「更新入口」签发的 update_once 授权码
        # （whoami 需显示 scope=update_once 且 projectId=1149），否则会误建重复玩法
        cmd += ["--project-id", "1149", "--auto"]
    return subprocess.call(cmd)


if __name__ == "__main__":
    sys.exit(run(sys.argv[1] if len(sys.argv) > 1 else "preview"))
