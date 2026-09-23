"""Reconcile an M0 job's admission, commit marker, R2 status and DLQ record."""

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
    print("M0 diagnostics run id:", root, flush=True)

    def request(path: str, show: str, job: str | None = None) -> tuple[int, dict]:
        endpoint = f"{state['url']}{path}"
        if path == "/diagnose":
            endpoint += "?" + urlencode({"show": show, "job": job})
        data = dumps({"show": show, "jobId": job}).encode() if path != "/diagnose" else None
        query = Request(endpoint, data=data, method="GET" if path == "/diagnose" else "POST",
                        headers={"User-Agent": "castloop-m0-diagnostics/1.0", "X-M0-Key": secret,
                                 "Content-Type": "application/json"})
        try:
            response = urlopen(query, timeout=25)
        except HTTPError as error:
            response = error
        with response:
            return response.status, loads(response.read())

    def inspect(show: str, job: str) -> dict:
        status, result = request("/diagnose", show, job)
        require(status == 200, "Diagnostic endpoint failed")
        return result

    def wait_for(show: str, job: str, diagnosis: str) -> dict:
        deadline = monotonic() + 80
        while monotonic() < deadline:
            result = inspect(show, job)
            if result["diagnosis"] == diagnosis:
                return result
            sleep(1)
        raise AssertionError(f"Timed out waiting for {diagnosis}: {show}/{job}")

    with TemporaryDirectory(prefix="castloop-m0-diagnostics-", dir="/tmp/opencode") as directory:
        file = Path(directory) / "commit.json"
        file.write_text("{}\n")

        def commit(show: str, job: str) -> None:
            key = f"staging/shows/{show}/{job}/commit.json"
            process = run([str(args.wrangler), "r2", "object", "put", f"{state['bucket']}/{key}",
                           "--remote", "--file", str(file)], capture_output=True, text=True, timeout=70)
            require(process.returncode == 0, f"Commit marker upload failed: {show}/{job}")

        show = f"m0-diag-reserved-{root}"
        job = f"reserved-{root}"
        require(request("/claim", show, job)[0] == 201, "Reserved claim failed")
        result = inspect(show, job)
        require(result["diagnosis"] == "reserved-no-commit" and result["owner"] == {
                    "state": "held", "jobId": job} and result["status"] is None and
                result["dlq"] is None and not result["commitExists"], "CLI stop not diagnosable")
        require(request("/claim", show, f"later-{root}")[0] == 409, "Incomplete job did not block Show")
        print("Reserved without commit: Show blocked, administrator can identify missing marker", flush=True)

        show = f"m0-diag-invalid-{root}"
        job = f"invalid-{root}"
        require(request("/claim", show, job)[0] == 201, "Invalid-job claim failed")
        commit(show, job)
        result = wait_for(show, job, "failed-before-processing")
        require(result["commitExists"] and result["owner"] == {"state": "held", "jobId": job}
                and 'state = "failed"' in result["status"] and
                'reason = "invalid staged input"' in result["status"] and result["dlq"] is None,
                "Permanent error status inconsistent")
        require(request("/finish", show, job)[0] == 200, "Reserved invalid job cannot be cancelled")
        require(request("/claim", show, f"replacement-{root}")[0] == 201,
                "Invalid input remained blocked after explicit cancellation")
        print("Permanent input error: R2 failure reason, no DLQ, explicit reserved cancellation", flush=True)

        show = f"m0-diag-retry-{root}"
        job = f"fail-with-status-{root}"
        require(request("/claim", show, job)[0] == 201, "Retrying-job claim failed")
        commit(show, job)
        result = wait_for(show, job, "blocked-dlq")
        require(result["commitExists"] and result["attempts"] == 3 and
                result["owner"] == {"state": "processing", "jobId": job} and
                'state = "retrying"' in result["status"] and
                'reason = "injected R2 failure"' in result["status"] and result["dlq"],
                "R2 retry status and DLQ did not reconcile")
        require(request("/claim", show, f"later-{root}")[0] == 409, "DLQ job was released")
        print("Retries exhausted: DLQ and stale retrying status visible, Show remains blocked", flush=True)

        show = f"m0-diag-no-status-{root}"
        job = f"fail-no-status-{root}"
        require(request("/claim", show, job)[0] == 201, "No-status claim failed")
        commit(show, job)
        result = wait_for(show, job, "blocked-dlq-status-missing")
        require(result["attempts"] == 3 and result["status"] is None and result["dlq"] and
                result["commitExists"] and result["owner"] == {"state": "processing", "jobId": job},
                "Missing status was mistaken for an absent job")
        require(request("/finish", show, job)[0] == 409, "Processing job was cancelled")
        print("Status write absent: commit, ownership and DLQ identify blocked job", flush=True)

        show = f"m0-diag-success-{root}"
        job = f"success-{root}"
        require(request("/claim", show, job)[0] == 201, "Successful-job claim failed")
        commit(show, job)
        result = wait_for(show, job, "published")
        require(result["commitExists"] and result["attempts"] == 1 and result["dlq"] is None and
                'state = "published"' in result["status"] and result["owner"] == {
                    "state": "free", "jobId": job}, "Published job records did not match")
        print("Published job: matching commit, R2 status, free reservation, no DLQ", flush=True)

    print("M0 job diagnostics probe passed; run id:", root)


if __name__ == "__main__":
    main()
