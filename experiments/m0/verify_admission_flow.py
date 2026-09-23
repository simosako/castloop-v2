"""Verify Show and Episode publication share one M0 admission slot."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from json import dumps, loads
from pathlib import Path
from secrets import token_hex
from subprocess import run
from tempfile import TemporaryDirectory
from threading import Barrier
from time import monotonic, sleep
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


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
    print("M0 flow run id:", root, flush=True)

    def call_claim(show: str, job: str) -> tuple[int, dict]:
        request = Request(f"{state['url']}/claim", data=dumps({"show": show, "jobId": job}).encode(),
                          headers={"User-Agent": "castloop-m0-flow/1.0", "X-M0-Key": secret,
                                   "Content-Type": "application/json"}, method="POST")
        try:
            response = urlopen(request, timeout=25)
        except HTTPError as error:
            response = error
        with response:
            return response.status, loads(response.read())

    def observe(show: str, candidate: dict) -> dict:
        query = {"show": show, "job": candidate["job"], "kind": candidate["kind"]}
        if candidate["kind"] == "episode":
            query["episode"] = candidate["episode"]
        request = Request(f"{state['url']}/flow?" + urlencode(query),
                          headers={"User-Agent": "castloop-m0-flow/1.0", "X-M0-Key": secret})
        with urlopen(request, timeout=25) as response:
            return loads(response.read())

    def wait_until(show: str, candidate: dict) -> dict:
        deadline = monotonic() + 70
        while monotonic() < deadline:
            result = observe(show, candidate)
            if result["status"] == "published" and result["owner"] == {
                    "state": "free", "jobId": candidate["job"]}:
                return result
            sleep(1)
        raise AssertionError(f"Queue did not complete {show}/{candidate['job']}")

    with TemporaryDirectory(prefix="castloop-m0-flow-", dir="/tmp/opencode") as directory:
        file = Path(directory) / "object"

        def upload(key: str, content: str) -> None:
            file.write_text(content)
            process = run([str(args.wrangler), "r2", "object", "put", f"{state['bucket']}/{key}",
                           "--remote", "--file", str(file)], capture_output=True, text=True, timeout=70)
            require(process.returncode == 0, f"M0 object upload failed for {key}; CLI output withheld")

        def stage(show: str, candidate: dict) -> None:
            job = candidate["job"]
            kind = candidate["kind"]
            prefix = (f"staging/shows/{show}/{job}" if kind == "show" else
                      f"staging/episodes/{show}/{candidate['episode']}/{job}")
            metadata = "show.toml" if kind == "show" else "episode.toml"
            upload(f"{prefix}/{metadata}", 'title = "M0 flow probe"\n')
            staged = observe(show, candidate)
            require(staged["metadataExists"] and not staged["markerExists"] and staged["status"] is None,
                    "Metadata stage unexpectedly published before commit marker")
            marker = {"show": show, "jobId": job, "kind": kind}
            if kind == "episode":
                marker["episodeId"] = candidate["episode"]
            upload(f"{prefix}/commit.json", dumps(marker) + "\n")

        for index, kinds in enumerate((("show", "episode"), ("episode", "show"),
                                       ("episode", "episode"))):
            show = f"m0-flow-{root}-{index}"
            candidates = [
                {"kind": kinds[0], "job": f"job-{root}-{index}-a", "episode": "episode-a"},
                {"kind": kinds[1], "job": f"job-{root}-{index}-b", "episode": "episode-b"},
            ]
            barrier = Barrier(2)

            def claim(candidate: dict) -> tuple[int, dict]:
                barrier.wait(timeout=20)
                return call_claim(show, candidate["job"])

            with ThreadPoolExecutor(max_workers=2) as executor:
                outcomes = list(executor.map(claim, candidates))
            require(sorted(result[0] for result in outcomes) == [201, 409],
                    "Exactly one Show/Episode claim must succeed")
            winner = candidates[next(i for i, result in enumerate(outcomes) if result[0] == 201)]
            loser = candidates[next(i for i, result in enumerate(outcomes) if result[0] == 409)]
            require(outcomes[next(i for i, result in enumerate(outcomes) if result[0] == 409)][1]["result"]
                    == "conflict", "Loser did not get admission conflict")
            before = observe(show, loser)
            require(not before["markerExists"] and not before["metadataExists"] and before["status"] is None,
                    "Losing job wrote staging or a commit marker")
            require(call_claim(show, winner["job"]) == (200, {"result": "same-job"}),
                    "Winner did not retain its job ID on retry")
            require(call_claim(show, loser["job"])[0] == 409, "Losing job entered before commit")

            stage(show, winner)
            completed = wait_until(show, winner)
            require(completed["markerExists"] and completed["metadataExists"] and
                    completed["processedKind"] == winner["kind"] and completed["visible"] == winner["job"],
                    "Winner's commit marker did not produce the expected Queue result")
            require(not observe(show, loser)["markerExists"], "Losing job created a commit marker")
            require(call_claim(show, loser["job"])[0] == 201, "Losing job could not reapply after completion")
            stage(show, loser)
            completed = wait_until(show, loser)
            require(completed["processedKind"] == loser["kind"] and completed["visible"] == loser["job"],
                    "Reapplied job did not publish its own kind")
            print(f"pair {index + 1}: {kinds[0]} vs {kinds[1]}, one winner; both processed in turn", flush=True)

        show = f"m0-flow-show-first-{root}"
        show_job = {"kind": "show", "job": f"job-{root}-show"}
        episode_job = {"kind": "episode", "job": f"job-{root}-episode", "episode": "episode-first"}
        require(call_claim(show, show_job["job"])[0] == 201, "Show-first claim failed")
        require(call_claim(show, episode_job["job"])[0] == 409, "Episode entered reserved Show")
        require(not observe(show, episode_job)["markerExists"], "Rejected Episode staged a marker")
        stage(show, show_job)
        require(wait_until(show, show_job)["processedKind"] == "show", "Show-first marker not processed")
        print("show-first: Episode rejected until Show commit was processed", flush=True)

    print("M0 shared admission-to-Queue probe passed; run id:", root)


if __name__ == "__main__":
    main()
