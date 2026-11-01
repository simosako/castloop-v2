# Verification for private castloop live trials (see design/live-trial.md).
#
# Mode "pre-upload": before any content upload, confirm the Worker script
# subdomain settings (workers.dev enabled, preview URLs disabled) and that
# anonymous requests to the planned public route shapes are redirected to
# Cloudflare Access.
#
# Mode "post-publication": compare every committed R2 audio and cover object
# with the local originals byte-for-byte, and re-check anonymous denial
# (GET/HEAD/conditional/Range) across the real route shapes plus management
# and hidden-path denial.
#
# Usage:
#   python3 scripts/live-trial-verify.py pre-upload EVIDENCE_DIR SHOW_ID
#   python3 scripts/live-trial-verify.py post-publication EVIDENCE_DIR
#
# Environment:
#   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN - both modes
#   CASTLOOP_TRIAL_ASSETS - post-publication only; the local trial-data root
#     containing "normal/<episode_id>.mp3" and "normal/cover.jpg" originals
#
# Requires Python 3.11+ (tomllib). Requests must use an identifying
# User-Agent: the default Python UA is rejected with 403 by Cloudflare
# Browser Integrity Check.
import glob
import hashlib
import json
import os
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "castloop-private-trial/1.0"
API = "https://api.cloudflare.com/client/v4"
RESULTS_GLOB = "episode-*-publish.json"


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(2)


def save(evid, name, obj):
    with open(os.path.join(evid, name), "w") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)


def http(url, headers=None, method="GET"):
    merged = {"User-Agent": USER_AGENT}
    merged.update(headers or {})
    req = urllib.request.Request(url, headers=merged, method=method)

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()


class Checks:
    def __init__(self, evid):
        self.evid = evid
        self.checks = []

    def run(self, name, ok, detail):
        self.checks.append({"name": name, "ok": bool(ok), "detail": detail})
        print(("PASS" if ok else "FAIL"), name, "-", detail)

    def finish(self, name):
        save(self.evid, name, {"checks": self.checks})
        passed = sum(1 for c in self.checks if c["ok"])
        failed = sum(1 for c in self.checks if not c["ok"])
        print(f"SUMMARY: {passed} passed, {failed} failed")
        sys.exit(0 if not failed else 1)


def load_workspace(evid, account):
    path = os.path.join(evid, "workspace", "castloop.toml")
    try:
        with open(path, "rb") as f:
            config = tomllib.load(f)
    except OSError:
        fail(f"workspace service config not found: {path}")
    if config.get("account_id") != account:
        fail("workspace castloop.toml account_id differs from CLOUDFLARE_ACCOUNT_ID")
    return config


def access_redirect(headers):
    location = headers.get("location", "")
    return "cloudflareaccess.com" in location


def probe(denial, host, path, method="GET", extra=None):
    headers = {}
    headers.update(extra or {})
    status, response_headers, _ = http("https://" + host + path, headers, method)
    ok = status == 302 and access_redirect(response_headers)
    denial.append({"path": path, "method": method, "status": status, "access_redirect": ok})
    return ok


def pre_upload(evid, show, account, token):
    config = load_workspace(evid, account)
    host = urllib.parse.urlparse(config["workers_dev_base_url"]).netloc
    worker = config["worker_name"]
    checks = Checks(evid)

    # workers.dev settings live on the per-script subdomain API; the account
    # level /workers/subdomain response does not report previews_enabled.
    status, _, body = http(f"{API}/accounts/{account}/workers/scripts/{worker}/subdomain",
                           {"Authorization": "Bearer " + token})
    subdomain = json.loads(body)
    save(evid, "script-subdomain.json", subdomain)
    result = subdomain.get("result", {}) if status == 200 else {}
    subdomain_ok = result.get("enabled") is True and result.get("previews_enabled") is False
    checks.run("script subdomain enabled without previews", subdomain_ok, worker)

    # Content does not exist yet; Access must cover the whole /podcasts prefix,
    # so representative shapes with placeholder IDs are sufficient here.
    paths = [f"/podcasts/{show}/", f"/podcasts/{show}/feed.xml", f"/podcasts/{show}/cover.jpg",
             f"/podcasts/{show}/page/1/", f"/podcasts/{show}/episodes/sample/",
             f"/podcasts/{show}/episodes/sample/7cdd7ad1-9bde-4ca2-bed2-9880f13a502f.mp3"]
    denial = []
    all_ok = True
    for path in paths:
        all_ok &= probe(denial, host, path)
    save(evid, "anonymous-before-upload.json", denial)
    checks.run("anonymous denial before upload (302 to Access)", all_ok,
               f"{sum(1 for d in denial if d['access_redirect'])}/{len(denial)}")
    checks.finish("pre-upload-summary.json")


def post_publication(evid, account, token, assets):
    config = load_workspace(evid, account)
    host = urllib.parse.urlparse(config["workers_dev_base_url"]).netloc
    bucket = config["bucket_name"]

    publishes = sorted(glob.glob(os.path.join(evid, RESULTS_GLOB)))
    if not publishes:
        fail(f"no {RESULTS_GLOB} files in {evid}")
    episodes = {}
    show = None
    for path in publishes:
        with open(path) as f:
            result = json.load(f)["result"]
        show = show or result["show_id"]
        if result["show_id"] != show:
            fail("episode publish evidence contains multiple Shows")
        episodes[result["episode_id"]] = result["revision_id"]
    checks = Checks(evid)

    # 1) R2 inventory and full-content verification of audio and cover
    items, cursor = [], None
    for _ in range(100):
        q = "?per_page=1000" + ("&cursor=" + urllib.parse.quote(cursor, safe="") if cursor else "")
        status, _, data = http(f"{API}/accounts/{account}/r2/buckets/{bucket}/objects" + q,
                               {"Authorization": "Bearer " + token})
        value = json.loads(data)
        items.extend(value["result"])
        cursor = (value.get("result_info") or {}).get("cursor")
        if not cursor:
            break
    save(evid, "published-object-inventory.json", items)

    audio_objects = {x["key"]: x for x in items if x["key"].startswith(f"public/podcasts/{show}/audio/")}
    cover_objects = [x for x in items if x["key"].startswith(f"public/podcasts/{show}/covers/")]
    checks.run(f"r2 audio objects {len(episodes)}", len(audio_objects) == len(episodes),
               sorted(k.rsplit("/", 1)[-1] for k in audio_objects))
    checks.run("r2 cover object 1", len(cover_objects) == 1, len(cover_objects))

    def get_object(item):
        path = f"{API}/accounts/{account}/r2/buckets/{bucket}/objects/" + urllib.parse.quote(item["key"], safe="/")
        status, _, data = http(path, {"Authorization": "Bearer " + token})
        assert status == 200 and len(data) == item["size"], (item["key"], status, len(data))
        return data

    source = os.path.join(assets, "normal")
    mp3_results = []
    for episode in episodes:
        with open(os.path.join(source, episode + ".mp3"), "rb") as f:
            original_hash = hashlib.sha256(f.read()).hexdigest()
        expected_key = f"public/podcasts/{show}/audio/{original_hash}.mp3"
        matched = False
        if expected_key in audio_objects:
            stored = get_object(audio_objects[expected_key])
            matched = hashlib.sha256(stored).hexdigest() == original_hash
        mp3_results.append({"episode": episode, "expected_key": expected_key, "full_content_match": matched})
    save(evid, "mp3-hash-verification.json", mp3_results)
    checks.run(f"all {len(episodes)} mp3 stored at sha256 key with full-content match",
               all(r["full_content_match"] for r in mp3_results),
               json.dumps([r["full_content_match"] for r in mp3_results]))

    with open(os.path.join(source, "cover.jpg"), "rb") as f:
        original_cover_hash = hashlib.sha256(f.read()).hexdigest()
    cover_ok = any(hashlib.sha256(get_object(o)).hexdigest() == original_cover_hash for o in cover_objects)
    checks.run("cover full-content matches original sha256", cover_ok, original_cover_hash[:16])
    checks.run("system toml present", any(x["key"] == "system/service.toml" for x in items), "system/service.toml")

    # 2) Anonymous denial over the real route shapes
    origin_paths = [f"/podcasts/{show}/", f"/podcasts/{show}/feed.xml", f"/podcasts/{show}/cover.jpg",
                    f"/podcasts/{show}/page/1/"]
    for episode in episodes:
        site_id = hashlib.sha256(episode.encode()).hexdigest()[:16]
        origin_paths.append(f"/podcasts/{show}/{site_id}/")
        origin_paths.append(f"/podcasts/{show}/episodes/{episode}/{episodes[episode]}.mp3")
    denial = []
    all_ok = True
    for path in origin_paths:
        all_ok &= probe(denial, host, path)
        all_ok &= probe(denial, host, path, "HEAD")
        all_ok &= probe(denial, host, path, "GET", {"If-None-Match": "*"})
    for episode in episodes:
        all_ok &= probe(denial, host, f"/podcasts/{show}/episodes/{episode}/{episodes[episode]}.mp3",
                        "GET", {"Range": "bytes=0-31"})
    save(evid, "anonymous-after-publication.json", denial)
    checks.run("anonymous denial all requests (302 to Access)", all_ok,
               f"{sum(1 for d in denial if d['access_redirect'])}/{len(denial)}")

    # 3) Management auth and hidden path denial without a key.
    neg = []
    for path, expected in [("/admin/sqlite-service/health", 401), ("/", 404),
                           ("/system/test", 404), ("/staging/test", 404)]:
        status, _, _ = http("https://" + host + path)
        neg.append({"path": path, "status": status, "expected": expected})
        checks.run(f"negative path {path}", status == expected, status)
    # Anonymous /podcasts sits inside the Access app covering the /podcasts
    # prefix, so a 302 to the Access login is expected here (404 after
    # authentication); a plain 404 is also acceptable. Both deny content.
    status, response_headers, _ = http("https://" + host + "/podcasts")
    ok = status == 404 or status == 302 and access_redirect(response_headers)
    neg.append({"path": "/podcasts", "status": status, "expected": "404 or 302 to Access"})
    checks.run("negative path /podcasts", ok, status)
    save(evid, "negative-paths.json", neg)
    checks.finish("verification-summary.json")


def main():
    args = sys.argv[1:]
    if len(args) == 3 and args[0] == "pre-upload":
        evid, show = args[1], args[2]
    elif len(args) == 2 and args[0] == "post-publication":
        evid, show = args[1], None
    else:
        fail("usage: live-trial-verify.py pre-upload EVIDENCE_DIR SHOW_ID | post-publication EVIDENCE_DIR")
    if not os.path.isdir(evid):
        fail(f"evidence directory not found: {evid}")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not account or not token:
        fail("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set")
    if show is not None:
        pre_upload(evid, show, account, token)
        return
    assets = os.environ.get("CASTLOOP_TRIAL_ASSETS")
    if not assets or not os.path.isdir(os.path.join(assets, "normal")):
        fail("CASTLOOP_TRIAL_ASSETS must point at the trial-data root containing normal/")
    post_publication(evid, account, token, assets)


if __name__ == "__main__":
    main()
