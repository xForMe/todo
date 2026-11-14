"""Run non-mutating local quality checks, stopping on the first failure."""

import subprocess
import sys
from pathlib import Path


def main() -> int:
    """Execute checks using the current project interpreter."""
    backend = Path(__file__).resolve().parents[1] / "backend"
    commands = [
        ["ruff", "check", ".", "../scripts"],
        ["ruff", "format", "--check", ".", "../scripts"],
        ["mypy"],
        ["pytest"],
    ]
    for command in commands:
        result = subprocess.run([sys.executable, "-m", *command], cwd=backend, check=False)
        if result.returncode:
            return result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
