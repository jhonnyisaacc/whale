import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

if len(sys.argv) not in (2, 3):
    sys.exit("usage: python -I scripts/hermes-scan.py <hermes-source-dir> [git-ref]")

hermes_src = Path(sys.argv[1]).resolve()
ref = sys.argv[2] if len(sys.argv) == 3 else "HEAD"
repo = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(hermes_src))

from hermes_cli.plugins_install_scan import PLUGIN_SCANNER_VERSION, scan_plugin

sha = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", f"{ref}^{{commit}}"],
                     capture_output=True, text=True, check=True).stdout.strip()

with tempfile.TemporaryDirectory() as tmp:
    clone = Path(tmp) / "whale"
    subprocess.run(["git", "clone", "--quiet", "--no-checkout", str(repo), str(clone)], check=True)
    subprocess.run(["git", "-C", str(clone), "checkout", "--quiet", "--detach", sha], check=True)
    result = scan_plugin(clone)

counts = Counter(f.severity for f in result.findings)
print(f"{PLUGIN_SCANNER_VERSION} scanned {sha}: verdict {result.verdict}, "
      f"{len(result.findings)} findings {dict(sorted(counts.items()))}")
for f in result.findings:
    if f.severity in ("high", "critical"):
        print(f"{f.severity} {f.pattern_id} {f.file}:{f.line} {f.match[:120]!r}")
sys.exit(0 if result.verdict == "safe" else 1)
