"""Run a bounded recovery smoke test against the dedicated M0 Cloudflare resources."""

import argparse
from concurrent.futures import ThreadPoolExecutor
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

    def call(path: str, show: str, job: str | None = None) -> tuple[int, dict]:
        headers = {"User-Agent": "castloop-m0-recovery/1.0", "X-M0-Key": secret,
                   "Content-Type": "application/json"}
        data = dumps({"show": show, "jobId": job}).encode() if job else None
        endpoint = f"{state['url']}{path}"
        if job is None:
            endpoint += "?" + urlencode({"show": show})
        request = Request(endpoint, data=data, headers=headers, method="POST" if job else "GET")
        try:
            response = urlopen(request, timeout=25)
        except HTTPError as error:
            response = error
        with response:
            body = response.read()
            try:
                return response.status, loads(body)
            except ValueError:
                return response.status, {"body": body.decode("utf-8", "replace")}

    def gate(show: str, job: str) -> dict:
        endpoint = f"{state['url']}/gate?" + urlencode({"show": show, "job": job})
        request = Request(endpoint, headers={"User-Agent": "castloop-m0-recovery/1.0", "X-M0-Key": secret})
        with urlopen(request, timeout=25) as response:
            return loads(response.read())

    def wait_for(show: str, job: str, predicate, description: str) -> dict:
        deadline = monotonic() + 65
        while monotonic() < deadline:
            result = gate(show, job)
            if predicate(result):
                return result
            sleep(1)
        raise AssertionError(f"Timed out: {description}; show={show}; job={job}")

    with TemporaryDirectory(prefix="castloop-m0-", dir="/tmp/opencode") as directory:
        marker = Path(directory) / "commit.json"
        marker.write_text("{}\n")

        def upload(show: str, job: str) -> None:
            key = f"staging/shows/{show}/{job}/commit.json"
            process = run([str(args.wrangler), "r2", "object", "put", f"{state['bucket']}/{key}",
                           "--remote", "--file", str(marker)], capture_output=True, text=True, timeout=70)
            require(process.returncode == 0, f"Wrangler M0 marker upload failed for {show}/{job}")

        for index in range(4):
            show = f"m0-gate-race-{root}-{index}"
            require(call("/claim", show, "job-a")[0] == 201, "Race setup failed")
            with ThreadPoolExecutor(max_workers=2) as pool:
                begin = pool.submit(call, "/begin", show, "job-a")
                finish = pool.submit(call, "/finish", show, "job-a")
                statuses = sorted([begin.result()[0], finish.result()[0]])
            require(statuses == [200, 409], "Begin/cancel must have exactly one winner")
            owner = gate(show, "job-a")["owner"]
            if owner["state"] == "processing":
                require(call("/finish", show, "job-a")[0] == 409, "Processing cancellation succeeded")
                require(call("/complete", show, "job-a")[0] == 404, "Management completion route exists")
                require(call("/claim", show, "job-b")[0] == 409, "Other job entered processing show")
                upload(show, "job-a")
                wait_for(show, "job-a", lambda value: value["owner"] == {"state": "free", "jobId": "job-a"},
                         "Consumer completion after begin/cancel race")
            else:
                require(owner["state"] == "free", "Unexpected race result")
            print(f"CAS race {index + 1}: one winner, processing cannot be cancelled")

        show = f"m0-gate-retry-{root}"
        job = f"retry-once-{root}"
        require(call("/claim", show, job)[0] == 201, "Retry claim failed")
        upload(show, job)
        result = wait_for(show, job, lambda value: value["owner"] == {"state": "free", "jobId": job},
                          "partial write retry completed")
        require(len(result["attempts"]) == 2 and result["status"] == "published" and
                result["visible"] == job and result["immutable"] == f"snapshot-{job}",
                "Retry did not converge on same job")
        print("Partial write: same job retried, published, then released")

        show = f"m0-gate-status-{root}"
        job = f"after-status-once-{root}"
        require(call("/claim", show, job)[0] == 201, "Status claim failed")
        upload(show, job)
        result = wait_for(show, job, lambda value: value["owner"] == {"state": "free", "jobId": job},
                          "status-before-release retry completed")
        require(len(result["attempts"]) == 2 and result["status"] == "published" and
                result["visible"] == job, "Status-written retry did not complete")
        print("Status written before failure: retry released the same job")

        show = f"m0-gate-blocked-{root}"
        job = f"fail-always-{root}"
        require(call("/claim", show, job)[0] == 201, "Blocked claim failed")
        upload(show, job)
        result = wait_for(show, job, lambda value: value["dlq"] == "delivered", "DLQ arrival")
        require(len(result["attempts"]) == 3 and result["owner"] == {"state": "processing", "jobId": job}
                and result["status"].startswith("blocked") and result["visible"] is None,
                "Exhausted job was unexpectedly released or published")
        require(call("/finish", show, job)[0] == 409, "Blocked processing job was cancelled")
        require(call("/claim", show, f"next-{root}")[0] == 409, "Blocked show accepted a new job")
        print("Retry exhausted: DLQ received message and show remains blocked")

        other_show = f"m0-gate-other-{root}"
        other_job = f"other-{root}"
        require(call("/claim", other_show, other_job)[0] == 201, "Other show blocked")
        upload(other_show, other_job)
        wait_for(other_show, other_job, lambda value: value["owner"] == {"state": "free", "jobId": other_job},
                 "other show completed")
        print("Independent show completed despite blocked show")

        show = f"m0-gate-stale-{root}"
        old_job = f"old-{root}"
        new_job = f"new-{root}"
        require(call("/claim", show, old_job)[0] == 201, "Old claim failed")
        require(call("/finish", show, old_job)[0] == 200, "Reserved cancellation failed")
        require(call("/claim", show, new_job)[0] == 201, "New claim failed")
        upload(show, old_job)
        result = wait_for(show, old_job, lambda value: value["rejected"] == "not-owner", "old marker rejection")
        require(result["visible"] is None and not result["attempts"], "Stale marker published")
        upload(show, new_job)
        result = wait_for(show, new_job, lambda value: value["owner"] == {"state": "free", "jobId": new_job},
                          "replacement job completed")
        require(result["visible"] == new_job, "Old job overwrote replacement")
        print("Late old marker rejected, replacement job published")

        show = f"m0-gate-late-{root}"
        old_job = f"old-{root}"
        new_job = f"new-{root}"
        require(call("/claim", show, old_job)[0] == 201, "Late marker setup failed")
        require(call("/finish", show, old_job)[0] == 200, "Late marker cancellation failed")
        require(call("/claim", show, new_job)[0] == 201, "Late marker replacement failed")
        upload(show, new_job)
        wait_for(show, new_job, lambda value: value["owner"] == {"state": "free", "jobId": new_job},
                 "replacement before late marker")
        upload(show, old_job)
        result = wait_for(show, old_job, lambda value: value["rejected"] == "not-owner",
                          "marker after replacement completed")
        require(result["visible"] == new_job and result["status"] is None,
                "Old job changed completed replacement")
        print("Old marker arriving after replacement completion was rejected")

    print("M0 recovery probe passed; run id:", root)


if __name__ == "__main__":
    main()
