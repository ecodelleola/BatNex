"""Fetch a private Windows Python runtime for the Batnex installer.

Downloads the official CPython embeddable package (no system install needed),
adds pip, installs bleak + deps, and verifies the scanner imports.
Result: vendor/python/python.exe — shipped inside the installer via
electron-builder extraResources, so end users never install Python.

Usage:  python scripts/fetch_python.py   (needs network, run once)
"""
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

PY_VERSION = "3.12.10"
EMBED_URL = f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip"
GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.normpath(os.path.join(HERE, "..", "vendor", "python"))


def download(url, dest):
    print(f"download {url}", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


def run(exe, *args):
    print(f"run: {exe} {' '.join(args)}", flush=True)
    subprocess.run([exe, *args], check=True)


def main():
    if os.path.isdir(VENDOR):
        print(f"removing old {VENDOR}")
        shutil.rmtree(VENDOR)
    os.makedirs(VENDOR)

    zpath = os.path.join(VENDOR, "embed.zip")
    download(EMBED_URL, zpath)
    with zipfile.ZipFile(zpath) as z:
        z.extractall(VENDOR)
    os.remove(zpath)

    # Enable site-packages (required for pip) in the embeddable runtime.
    pth = os.path.join(VENDOR, f"python{PY_VERSION.replace('.', '')[:3]}._pth")
    with open(pth, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()
    lines = [ln if ln.strip() != "#import site" else "import site" for ln in lines]
    if "import site" not in lines:
        lines.append("import site")
    with open(pth, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    exe = os.path.join(VENDOR, "python.exe")
    getpip = os.path.join(VENDOR, "get-pip.py")
    download(GET_PIP_URL, getpip)
    run(exe, getpip, "--no-warn-script-location")
    os.remove(getpip)
    run(exe, "-m", "pip", "install", "--upgrade", "pip")
    run(exe, "-m", "pip", "install", "bleak")
    run(exe, "-c", "import bleak, sys; print('bleak', bleak.__version__ if hasattr(bleak, '__version__') else 'ok', sys.version.split()[0])")
    print(f"private runtime ready: {exe}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FAILED: {type(e).__name__}: {e}")
        sys.exit(1)
