"""Read-only review of pinned upstream contracts; fixtures write only in tempfile.

Usage: python this_file.py --upstream PATH [--output evidence.json]
The upstream source must match the reviewed Git blobs before it is imported.
No compiler, model, SSH, SCP, nightly job, or production receipt append is run.
Assertions reproduce baseline defects; they are not product acceptance passes.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import pathlib
import re
import tempfile

PINNED = {
    "scripts/hive-receipts.py": "c5076787c9697d0cf6dc0ab430cc16c637245ad2",
    "scripts/fra-eval.py": "aecd23e4786d65f3a61c2a1cb6fc647188a4833b",
    "dossier-ls/decompiled.c": "7c61c5b00a778d62afa12bcc1c06325db8463128",
    "hive/receipts.jsonl": "9fcb7465a12abc80117c45c02c9d064a15ed81cf",
}


def run(root):
    checks, hashes = [], {}

    def check(name, condition):
        if not condition:
            raise AssertionError(name)
        checks.append(name)

    for name, expected in PINNED.items():
        data = (root / name).read_bytes()
        blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        check("pinned source bytes: " + name, blob == expected)
        hashes[name] = {"gitBlob": blob, "sha256": hashlib.sha256(data).hexdigest()}

    def module(name, file):
        spec = importlib.util.spec_from_file_location(name, root / file)
        result = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(result)
        return result

    def capture(fn, args=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            fn(args)
        return output.getvalue().strip()

    hive = module("review_hive", "scripts/hive-receipts.py")
    evaluator = module("review_eval", "scripts/fra-eval.py")
    hive.BUS = root / "hive/receipts.jsonl"
    raw_check = capture(hive.cmd_verify)
    raw_receipts = hive._load()
    check("committed raw receipt chain verifies", "chain INTACT" in raw_check)

    with tempfile.TemporaryDirectory(prefix="chandra-re-contract-") as temporary:
        work = pathlib.Path(temporary).resolve()
        assert work.is_relative_to(pathlib.Path(tempfile.gettempdir()).resolve())
        hive.HIVE_DIR = work
        hive.BUS = work / "receipts.jsonl"
        receipt = hive._append({"organ": "chandra", "type": "reflection", "claim": "fixture caf\u00e9", "evidence": {"z": 1, "a": 2}, "seal": ""})
        valid = capture(hive.cmd_verify)
        check("positive control generated chain verifies", "chain INTACT" in valid)
        projected_path = work / "hive_genesis.jsonl"
        capture(hive.cmd_feed_akashic, argparse.Namespace(out=str(projected_path)))
        projection = json.loads(projected_path.read_text().splitlines()[0])
        check("feed-akashic projection omits chain fields", "prev" not in projection and "self" not in projection)
        phone = work / "phone.json"
        phone.write_text(json.dumps(receipt))
        capture(hive.cmd_ingest_phone, argparse.Namespace(bundle=str(phone)))
        converted = hive._load()[-1]
        check("phone adapter reinterprets Chandra receipt as an empty phone bundle", converted["organ"] == "phone-headroom" and "0 packets" in converted["claim"])
        check("phone adapter does not preserve reflection claim", receipt["claim"] not in converted["claim"])
        records = hive._load()
        records[0]["claim"] = "tampered fixture"
        hive.BUS.write_text("\n".join(json.dumps(r) for r in records) + "\n")
        tampered = capture(hive.cmd_verify)
        check("positive control detects tampered raw receipt", "SELFSHA MISMATCH" in tampered and "chain DAMAGED" in tampered)

    c = (root / "dossier-ls/decompiled.c").read_text()
    markers = re.findall(r"^// ==== (.+?) @ (.*?) ====", c, re.M)
    blocks = evaluator.blocks(c)
    check("dossier contains 136 actual function markers", len(markers) == 136)
    check("upstream evaluator splits those into 181 fragments", len(blocks) == 181)
    check("first evaluator code field is an address, not function C", blocks[0]["c"] == markers[0][1] and blocks[0]["name"].startswith("// decompiled:"))
    check("same regex findall identifies 136 function records", len(evaluator.SPLIT.findall(c)) == 136)

    files = sorted(p for p in (root / "dossier-ls").iterdir() if p.is_file() and p.name != "dossier.seal")
    manifest = "".join(hashlib.sha256(p.read_bytes()).hexdigest() + "  " + p.name + "\n" for p in files)
    stored_seal = (root / "dossier-ls/dossier.seal").read_text().split()[0]
    candidate_seal = hashlib.sha256(manifest.encode()).hexdigest()
    build_gates = (root / "docs/BUILD-GATES.md").read_text()
    numbered_gates = re.findall(r"^\d+\. \*\*", build_gates, re.M)
    upstream_manifest = (root / "MANIFEST.md").read_text()
    spec = (pathlib.Path(__file__).resolve().parents[2] / "docs/RE-AGENT-INTEGRATION.md").read_text(encoding="utf-8")
    def pin_rows(text, column):
        result = []
        for line in text.splitlines():
            if not line.startswith("|"):
                continue
            cells = [cell.strip() for cell in line.split("|")[1:-1]]
            if len(cells) > column:
                pin = re.search(r"`([0-9a-f]{6,})(?:\.\.\.)?`", cells[column])
                if pin:
                    result.append({"tool": cells[0], "pinPrefix": pin.group(1)})
        return result
    upstream_pins = pin_rows(upstream_manifest, 1)
    planned_pins = pin_rows(spec, 2)
    pin_comparison = [{"specTool": a["tool"], "specPrefix": a["pinPrefix"], "manifestTool": b["tool"], "manifestPrefix": b["pinPrefix"], "matchesPrefix": b["pinPrefix"].startswith(a["pinPrefix"])} for a, b in zip(planned_pins, upstream_pins)]
    return {
        "upstreamRef": "2f75cee7f54a4aa6bae219ec9241fc44f980c36b",
        "safety": "Pinned upstream definitions only; append/export fixtures confined to checked temporary directory; no execution of binaries, compiler, models, or network jobs",
        "checks": checks, "assertionCount": len(checks), "sources": hashes,
        "rawReceipts": {"count": len(raw_receipts), "verificationOutput": raw_check},
        "fixtureReceipt": receipt, "positiveChainOutput": valid, "tamperedOutput": tampered,
        "akashicProjectionKeys": list(projection),
        "phoneAdapterResult": {key: converted[key] for key in ["organ", "type", "claim"]},
        "compileRateParser": {"actualFunctionMarkers": len(markers), "evaluatorFragments": len(blocks), "firstFragment": {key: value[:140] for key, value in blocks[0].items()}, "correctRegexMatches": len(evaluator.SPLIT.findall(c)), "compilerRun": False},
        "sealRecomputation": {"filesAvailable": [p.name for p in files], "stored": stored_seal, "candidateFromAvailableFiles": candidate_seal, "matches": candidate_seal == stored_seal, "verdict": "NOT_VERIFIED: complete original sealed file set and canonical manifest required; mismatch alone does not establish tampering"},
        "sourceInventory": {"numberedBuildGates": len(numbered_gates), "specClaimsBuildGates": 19, "pinComparison": pin_comparison, "archiveBytesIndependentlyHashed": False},
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run(pathlib.Path(args.upstream).resolve())
    if args.output:
        pathlib.Path(args.output).write_text(json.dumps(result, indent=2, ensure_ascii=True) + "\n")
        print(json.dumps({"assertionCount": result["assertionCount"], "output": str(pathlib.Path(args.output).resolve())}))
    else:
        print(json.dumps(result, indent=2, ensure_ascii=True))
