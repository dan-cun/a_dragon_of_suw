"""Run the bundled proxy without opening an unrelated console window."""
import sys
from mitmproxy.tools.main import mitmweb

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    sys.stderr.reconfigure(encoding="utf-8", errors="strict")
    mitmweb()
