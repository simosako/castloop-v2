"""Verify an M0 publication holds its Show reservation until cache purge succeeds."""

import argparse
from json import dumps, loads
from pathlib import Path
from secrets import token_hex
from subprocess import run
from tempfile import TemporaryDirectory
from time import monotonic, sleep
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def require(condition: bool, description: str) -> None:
    if not condition:
        raise AssertionError(description)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=Path("/tmp/opencode/castloop-m0-resources.json"))
    parser.add_argument("--secrets", type=Path, default=Path("/tmp/opencode/castloop-m0/secrets.json"))
    parser.add_argument("--wrangler", type=Path, default=Path("node_modules/.bin/wrangler"))
    args = parser.parse_args()
    state = loads(args.state.read_text())
    secret = loads(args.secrets.read_text())["M0_SECRET"]
    require(all(str(state[name]).startswith("castloop-m0-") for name in ("worker", "bucket", "queue")),
            "Only dedicated M0 resources are allowed")
    require(state["url"].startswith(f"https://{state['worker']}."), "Unexpected Worker URL")
    root = token_hex(4)
    show = f"m0-release-{root}"
    episode = "episode-a"
    print("M0 release run id:", root, flush=True)

    def claim(job: str) -> int:
        request = Request(f"{state['url']}/claim", data=dumps({"show": show, "jobId": job}).encode(),
                          headers={"User-Agent": "castloop-m0-release/1.0", "X-M0-Key": secret,
                                   "Content-Type": "application/json"}, method="POST")
        try:
            response = urlopen(request, timeout=25)
        except HTTPError as error:
            response = error
        with response:
            response.read()
            return response.status

    def observe(job: str) -> dict:
        request = Request(f"{state['url']}/release?" + urlencode({"show": show, "job": job,
                                                                     "episode": episode}),
                          headers={"User-Agent": "castloop-m0-release/1.0", "X-M0-Key": secret})
        with urlopen(request, timeout=25) as response:
            return loads(response.read())

    def wait_for(job: str) -> dict:
        deadline = monotonic() + 70
        while monotonic() < deadline:
            record = observe(job)
            if record["owner"] == {"jobId": job, "state": "free"} and record["status"] == "published":
                return record
            sleep(1)
        raise AssertionError(f"M0 release did not finish: {show}/{job}")

    def public(name: str) -> tuple[int, str | None, bytes]:
        request = Request(f"{state['url']}/m0/podcasts/{show}/{name}",
                          headers={"User-Agent": "castloop-m0-release/1.0"})
        with urlopen(request, timeout=25) as response:
            return response.status, response.headers.get("Cf-Cache-Status"), response.read()

    with TemporaryDirectory(prefix="castloop-m0-release-", dir="/tmp/opencode") as directory:
        folder = Path(directory)

        def upload(key: str, value: bytes, mime: str) -> None:
            path = folder / "upload"
            path.write_bytes(value)
            process = run([str(args.wrangler), "r2", "object", "put", f"{state['bucket']}/{key}",
                           "--remote", "--file", str(path), "--content-type", mime],
                          capture_output=True, text=True, timeout=70)
            require(process.returncode == 0, f"M0 upload failed for {key}; CLI output withheld")

        def cover(color: str) -> bytes:
            path = folder / f"{color}.jpg"
            process = run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                           "-i", f"color=c={color}:s=32x32:d=1", "-frames:v", "1", "-y", str(path)],
                          capture_output=True, text=True, timeout=30)
            require(process.returncode == 0, f"Could not generate {color} JPEG")
            return path.read_bytes()

        first_cover, next_cover = cover("red"), cover("blue")
        first_feed = b'<rss version="2.0"><channel><title>Original</title></channel></rss>\n'
        show_feed = b'<rss version="2.0"><channel><title>Updated show</title></channel></rss>\n'
        episode_feed = (b'<rss version="2.0"><channel><title>Updated show</title>'
                        b'<item><guid>episode-a</guid></item></channel></rss>\n')
        old_episode = b'title = "Original episode"\n'
        next_episode = b'title = "Updated episode"\n'
        next_show = b'title = "Updated show"\nsite_url = "https://example.org"\n'
        feed_key = f"m0/public/podcasts/{show}/feed.xml"
        cover_key = f"m0/public/podcasts/{show}/cover.jpg"
        upload(feed_key, first_feed, "application/rss+xml")
        upload(cover_key, first_cover, "image/jpeg")
        upload(f"m0/public/episodes/{show}/{episode}/metadata.toml", old_episode, "application/toml")

        for name, expected in (("feed.xml", first_feed), ("cover.jpg", first_cover)):
            first, first_cache, content = public(name)
            second, second_cache, repeated = public(name)
            require(first == second == 200 and content == repeated == expected and
                    first_cache == "MISS" and second_cache == "HIT", f"Cache not warm for {name}")
        print("Initial feed and cover cached (MISS then HIT)", flush=True)

        show_job = f"purge-once-{root}"
        show_stage = f"staging/shows/{show}/{show_job}"
        require(claim(show_job) == 201, "Show update claim failed")
        upload(f"{show_stage}/show.toml", next_show, "application/toml")
        upload(f"{show_stage}/feed.xml", show_feed, "application/rss+xml")
        upload(f"{show_stage}/cover.jpg", next_cover, "image/jpeg")
        require(observe(show_job)["status"] is None, "Show published without commit marker")
        upload(f"{show_stage}/commit.json", dumps({"show": show, "jobId": show_job, "kind": "show"}).encode(),
               "application/json")
        show_result = wait_for(show_job)
        require(show_result["attempts"] == [
                    {"phase": "before-purge", "owner": "processing", "status": "processing"},
                    {"phase": "purged", "owner": "processing", "status": "processing"}],
                "Show completed before injected purge failure was retried")
        require(show_result["showMetadata"] == next_show.decode(), "Show metadata did not publish")
        for name, expected in (("feed.xml", show_feed), ("cover.jpg", next_cover)):
            first, first_cache, content = public(name)
            second, second_cache, repeated = public(name)
            require(first == second == 200 and content == repeated == expected and
                    first_cache == "MISS" and second_cache == "HIT", f"Show purge did not refresh {name}")
        print("Show: failed before purge, retried, purged feed and cover, then released", flush=True)

        episode_job = f"partial-once-{root}"
        episode_stage = f"staging/episodes/{show}/{episode}/{episode_job}"
        require(claim(episode_job) == 201, "Episode update claim failed")
        upload(f"{episode_stage}/episode.toml", next_episode, "application/toml")
        upload(f"{episode_stage}/feed.xml", episode_feed, "application/rss+xml")
        require(observe(episode_job)["status"] is None, "Episode published without commit marker")
        upload(f"{episode_stage}/commit.json", dumps({"show": show, "jobId": episode_job,
                                                      "kind": "episode", "episodeId": episode}).encode(),
               "application/json")
        episode_result = wait_for(episode_job)
        require(episode_result["attempts"] == [
                    {"phase": "after-metadata", "owner": "processing", "status": "processing"},
                    {"phase": "purged", "owner": "processing", "status": "processing"}],
                "Episode did not recover from metadata-only partial write")
        require(episode_result["episodeMetadata"] == next_episode.decode() and
                episode_result["showMetadata"] == next_show.decode(), "Current metadata mismatch")
        first, first_cache, content = public("feed.xml")
        second, second_cache, repeated = public("feed.xml")
        require(first == second == 200 and content == repeated == episode_feed and
                first_cache == "MISS" and second_cache == "HIT", "Episode feed purge failed")
        status, cover_cache, content = public("cover.jpg")
        require(status == 200 and cover_cache == "HIT" and content == next_cover,
                "Episode update modified or purged Show cover")
        print("Episode: failed after metadata, retried feed, purged it, then released", flush=True)

    print("M0 real-object publication/purge probe passed; run id:", root)


if __name__ == "__main__":
    main()
