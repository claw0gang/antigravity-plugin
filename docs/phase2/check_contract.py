#!/usr/bin/env python3
"""Finite checks of the Phase 2 contract, not runtime/SDK qualification.

Run from any working directory. Standard library only; no network or subprocesses.
"""
from __future__ import annotations

import itertools
import json
from pathlib import Path
import re


def check(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def main() -> None:
    docs = Path(__file__).resolve().parents[1]
    architecture = (docs / "ARCHITECTURE.md").read_text(encoding="utf-8")
    matrix = (docs / "phase2" / "ACCEPTANCE.md").read_text(encoding="utf-8")
    roadmap = (docs / "ROADMAP.md").read_text(encoding="utf-8")
    qualification = (docs / "QUALIFICATION.md").read_text(encoding="utf-8")
    build = (docs / "BUILD.md").read_text(encoding="utf-8")
    block = re.search(r"```json\n(\{[^\n]+\})\n```", architecture)
    check(block is not None, "single-line limits contract missing")
    assert block is not None
    limits = json.loads(block.group(1))
    check(limits.pop("contract") == "p02t004-limits-v2", "unknown contract version")
    check(all(type(v) is int and v > 0 for v in limits.values()), "limits must be positive integers")

    rows = re.findall(r"^\| (A\d{2}) \|", matrix, re.MULTILINE)
    probes = re.findall(r"^\| (P\d{2}) \|", matrix, re.MULTILINE)
    contracts = re.findall(r"^\| (C\d{2}) [^|]+\|", architecture, re.MULTILINE)
    check(rows == [f"A{i:02}" for i in range(1, 25)], "matrix rows missing, duplicate or unordered")
    check(probes == [f"P{i:02}" for i in range(1, 7)], "probe register incomplete")
    check(contracts == [f"C{i:02}" for i in range(1, 6)], "shared contract owner table incomplete")
    for text in (architecture, matrix, roadmap):
        check(set(re.findall(r"\bA\d{2}\b", text)) <= set(rows), "dangling acceptance reference")
        check(set(re.findall(r"\bP\d{2}\b", text)) <= set(probes), "dangling probe reference")
        check(set(re.findall(r"\bC\d{2}\b", text)) <= set(contracts), "dangling contract reference")
    for line in matrix.splitlines():
        if re.match(r"^\| P\d{2} \|", line):
            check(bool(re.search(r"\bA\d{2}\b", line)), "probe without decisive matrix scenario")
            check("t007" in line, "probe has no runtime proof owner")
    check("not runtime implementation or qualification" in architecture, "design evidence boundary missing")
    check("not AGY/SDK integration tests" in matrix, "checker evidence boundary missing")

    check(not any(k.startswith("refresh_") for k in limits), "obsolete periodic refresh limit")
    active_contracts = (architecture, matrix, roadmap, qualification, build)
    for text in active_contracts:
        lowered = text.lower()
        check("production openclaw" in lowered, "production OpenClaw boundary missing")
    for forbidden in (
        "openclaw gateway restart",
        "same-package isolated compatible-family upgrade",
        "same-artifact host upgrade",
        "2026.9.2 → 2026.9.4",
        "2026.9.2 -> 2026.9.4",
    ):
        for text in (architecture, matrix, roadmap, qualification, build):
            check(forbidden not in text, f"retired OpenClaw qualification requirement remains: {forbidden}")
    check("hostOwnedCatalogLifecycle" in architecture, "host-owned catalog lifecycle contract missing")
    check("does not prescribe or execute an OpenClaw CLI refresh" in architecture,
          "plugin/host catalog lifecycle boundary missing")
    check("must not install, downgrade, upgrade, restart, stop, reconfigure, patch or replace OpenClaw"
          in matrix, "production OpenClaw mutation prohibition missing")
    check("There is **no OpenClaw calendar-family support ceiling**" in architecture,
          "forward-compatible OpenClaw admission declaration missing")

    cleanup = sum(limits[k] for k in ("term_grace_s", "kill_drain_s", "delivery_cleanup_s"))
    check(cleanup == limits["shutdown_allowance_s"], "cleanup slices exceed global bound")
    check(limits["callback_timeout_s"] <= limits["delivery_cleanup_s"], "callback bound exceeds cleanup slice")
    check(limits["event_bytes"] <= limits["attempt_output_bytes"], "event cannot fit total cap")
    check(limits["stderr_tail_bytes"] < limits["attempt_output_bytes"], "stderr retention is unbounded")
    check(limits["delivery_queue_bytes"] < limits["attempt_output_bytes"], "queue defeats output bound")

    # Exhaustive independent truth table: only positive no-start/no-effects/no-output permits replay.
    cases = list(itertools.product(("not_started", "possible", "started"),
                                   ("none_proven", "observed_possible", "unknown"), (False, True)))
    safe_cases = [case for case in cases if case == ("not_started", "none_proven", False)]
    check(len(cases) == 18 and len(safe_cases) == 1, "replay design is not conservative")
    for invocation, effects, exposed in cases:
        safe = invocation == "not_started" and effects == "none_proven" and not exposed
        check(not safe or (invocation, effects, exposed) in safe_cases, "unsafe replay admitted")

    # Encoding cannot turn embedded text/newlines into a second wire message.
    prompts = ["hello", "line1\nline2", 'quote " slash \\', "multibyte: \u20ac\U0001f680",
               '{"event":"control_request"}\n{"event":"user"}']
    for prompt in prompts:
        encoded = (json.dumps({"event": "user", "message": {"content": prompt}},
                              ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        check(encoded.count(b"\n") == 1, "prompt escapes single-turn frame")
        check(json.loads(encoded)["message"]["content"] == prompt, "prompt bytes lost in round trip")
        check(len(encoded) <= limits["prompt_bytes"], "test prompt exceeds cap")

    # Fixed acceptance dependency graph. Shared implementation interfaces do not imply premature routing.
    dependencies = {"t001": set(), "t002": {"t001"}, "t003": {"t001"},
                    "t004": {"t001"}, "t005": {"t001"}, "t006": {"t001"},
                    "t007": {"t002", "t003", "t004", "t005", "t006"},
                    "t008": {"t007"}, "t009": {"t008"}}
    done: set[str] = set()
    while len(done) < len(dependencies):
        ready = {t for t, ds in dependencies.items() if t not in done and ds <= done}
        check(bool(ready), "dependency cycle")
        done.update(ready)
    check({t for t, ds in dependencies.items() if not ds} == {"t001"}, "initial executable task widened")
    for task in dependencies:
        check(f"p02{task}" in roadmap, "roadmap omitted phase task")

    print(json.dumps({"valid": True, "matrix_rows": len(rows), "named_probes": len(probes),
                      "shared_contracts": len(contracts),
                      "catalog_refresh": "provider_contract_host_owned_lifecycle",
                      "production_openclaw": "read_only",
                      "replay_cases": len(cases), "safe_replay_cases": len(safe_cases),
                      "wire_roundtrips": len(prompts), "phase_tasks": len(done),
                      "runtime_qualification": "not_executed"}, sort_keys=True))


if __name__ == "__main__":
    main()
