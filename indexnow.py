"""Tell Bing (and other IndexNow engines) which pages are new or changed after a deploy.

  python indexnow.py old_sitemap.xml _site/sitemap.xml

Compares the sitemap that was live before the deploy with the new one and submits the
URLs that appeared or got a newer <lastmod>. Uses only the standard library (runs in CI).
The key is public by design: IndexNow checks that web/<key>.txt is served on the site.
"""
import glob
import json
import os
import re
import sys
import urllib.request
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))


def entries(path):
    try:
        with open(path, encoding="utf-8") as f:
            xml = f.read()
    except FileNotFoundError:
        return {}
    return {m.group(1): m.group(2) or "" for m in re.finditer(
        r"<url><loc>([^<]+)</loc>(?:<lastmod>([^<]+)</lastmod>)?", xml)}  # image tags may follow


def main(old_path, new_path):
    old, new = entries(old_path), entries(new_path)
    changed = [u for u, d in new.items() if u not in old or d > old[u]]
    if not changed:
        print("IndexNow: nothing new")
        return
    key_files = [p for p in glob.glob(os.path.join(ROOT, "web", "*.txt")) if re.fullmatch(r"[0-9a-f]{32}\.txt", os.path.basename(p))]
    if not key_files:
        sys.exit("IndexNow: no key file in web/")
    key = os.path.basename(key_files[0])[:-4]
    site = os.environ.get("SITE_URL") or next(iter(new)).rsplit("/", 1)[0] + "/"
    body = {"host": urlparse(site).hostname, "key": key, "keyLocation": f"{site}{key}.txt",
            "urlList": changed[:10000]}
    req = urllib.request.Request("https://api.indexnow.org/indexnow", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json; charset=utf-8"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print(f"IndexNow: {len(changed)} URLs submitted, HTTP {r.status}")
    except Exception as e:  # never fail the deploy over this
        print(f"IndexNow: submit failed ({e})")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
