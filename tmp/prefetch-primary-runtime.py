#!/usr/bin/env python3
"""Prefill apps/desktop/.desktop-build/downloads with locked primary-runtime assets via CN mirrors.

Cache filename convention (from downloadPrimaryRuntimeAsset): join(cache, sha256).
"""
import hashlib
import json
import os
import sys
import urllib.request

REPO = "/Users/cloudyan/coding/claw/deepseek/deepseek-harness"
CACHE = os.path.join(REPO, "apps/desktop/.desktop-build/downloads")
lock = json.load(open(os.path.join(REPO, "apps/desktop/scripts/primary-runtime-lock.json")))
TARGET = "mac-arm64"
artifact = lock["targets"][TARGET]

python_name = "cpython-%s+%s-%s-install_only_stripped.tar.gz" % (
    lock["pythonVersion"], lock["pythonRelease"], artifact["pythonTarget"])
assets = [
    ("https://github.com/astral-sh/python-build-standalone/releases/download/%s/%s"
     % (lock["pythonRelease"], python_name), artifact["pythonSha256"],
     ["https://registry.npmmirror.com/-/binary/python-build-standalone/%s/%s"
      % (lock["pythonRelease"], python_name)]),
]
for w in list(artifact["wheels"]) + list(lock.get("wheels", [])):
    assets.append((w["url"], w["sha256"], [
        "https://pypi.tuna.tsinghua.edu.cn/packages" + w["url"].split("/packages", 1)[1],
        "https://mirrors.aliyun.com/pypi/packages" + w["url"].split("/packages", 1)[1],
    ]))

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "dsh-prefetch/1.0"})
    return urllib.request.urlopen(req, timeout=timeout)

failed = []
for url, sha, mirrors in assets:
    dest = os.path.join(CACHE, sha)
    if os.path.exists(dest):
        actual = sha256_file(dest)
        print("OK (cached) %s" % sha[:12])
        if actual != sha:
            print("  !! cached file corrupt, re-downloading")
            os.remove(dest)
        else:
            continue
        if os.path.exists(dest):
            continue
    got = False
    for candidate in mirrors + [url]:
        try:
            print("try %s" % candidate[:110])
            with fetch(candidate) as resp, open(dest + ".part", "wb") as out:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
            if sha256_file(dest + ".part") != sha:
                print("  checksum mismatch, discarding")
                os.remove(dest + ".part")
                continue
            os.rename(dest + ".part", dest)
            print("OK %s" % sha[:12])
            got = True
            break
        except Exception as e:
            print("  fail: %s" % e)
    if not got:
        failed.append(url)

if failed:
    print("\nFAILED for %d assets:" % len(failed))
    for u in failed:
        print(u)
    sys.exit(1)
print("\nAll assets cached.")
