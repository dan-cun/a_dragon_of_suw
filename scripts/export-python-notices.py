"""Include the installed Python distribution notices in the engine bundle."""
from importlib import metadata
from pathlib import Path
import shutil
import sys

output = Path(sys.argv[1]) / "_internal" / "third-party-licenses"
output.mkdir(parents=True, exist_ok=True)
summary = []
for distribution in metadata.distributions():
    name = distribution.metadata["Name"]
    version = distribution.version
    summary.append(f"{name} {version}")
    for entry in distribution.files or []:
        filename = Path(str(entry)).name.lower()
        if filename.startswith(("license", "licence", "copying", "notice")) and ".dist-info" in str(entry):
            source = Path(distribution.locate_file(entry))
            if source.is_file():
                target = output / name / str(entry).split(".dist-info/", 1)[-1]
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
python_license = Path(sys.base_prefix) / "LICENSE.txt"
if not python_license.is_file():
    raise FileNotFoundError("The CPython license was not found.")
shutil.copyfile(python_license, output / "CPython-LICENSE.txt")
(output / "versions.txt").write_text("\n".join(sorted(summary)) + "\n", encoding="utf-8")
