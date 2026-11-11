"""Fetch the Waqt stats block and write it between the README markers.

Used by readme-action/action.yml. Only uses the Python standard library.
"""

import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request


def env(name, default=""):
    return os.environ.get(name, default).strip()


def fail(msg):
    print(f"::error::{msg}")
    sys.exit(1)


def fetch_block():
    base = env("WAQT_URL").rstrip("/")
    if not re.match(r"^https?://", base):
        fail("Set `url` to your Waqt address, e.g. https://waqt.example.com")
    key = env("WAQT_API_KEY")
    user = "current" if key else "public"
    query = urllib.parse.urlencode({"range": env("WAQT_RANGE", "last_7_days"), "sections": env("WAQT_SECTIONS")})
    req = urllib.request.Request(f"{base}/api/v1/users/{user}/readme.md?{query}", headers={"User-Agent": "waqt-readme-action"})
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        hint = {
            401: "The API key was rejected. Check the secret you passed as `api_key`.",
            403: "Your Waqt profile is private. Turn on 'Public profile' in Settings, or pass `api_key`.",
        }.get(e.code, e.read().decode("utf-8", "replace")[:300])
        fail(f"Waqt answered {e.code}: {hint}")
    except urllib.error.URLError as e:
        fail(f"Could not reach {base}: {e.reason}")


def main():
    path = env("WAQT_README", "README.md")
    name = env("WAQT_SECTION_NAME", "waqt")
    start, end = f"<!--START_SECTION:{name}-->", f"<!--END_SECTION:{name}-->"
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        fail(f"{path} not found. Did you add actions/checkout before this step?")
    pattern = re.compile(re.escape(start) + r".*?" + re.escape(end), re.S)
    if not pattern.search(text):
        fail(f"Add these two lines to {path} where the stats should go:\n{start}\n{end}")

    block = fetch_block()
    new = pattern.sub(lambda _: f"{start}\n{block}{end}", text, count=1)

    # Ignore the "updated at" line when deciding whether anything changed.
    stamp = re.compile(r" · updated [0-9-]+ [0-9:]+ UTC")
    changed = stamp.sub("", new) != stamp.sub("", text)
    with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a", encoding="utf-8") as out:
        out.write(f"changed={'true' if changed else 'false'}\n")
    if not changed:
        print("Stats unchanged; nothing to commit.")
        return
    with open(path, "w", encoding="utf-8") as f:
        f.write(new)
    print(f"Updated {path}.")

    if env("WAQT_COMMIT", "true").lower() != "true":
        return
    run = lambda *a: subprocess.run(a, check=True)
    run("git", "config", "user.name", "github-actions[bot]")
    run("git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
    run("git", "add", path)
    run("git", "commit", "-m", env("WAQT_COMMIT_MESSAGE", "Update coding stats from Waqt"))
    run("git", "push")


if __name__ == "__main__":
    main()
