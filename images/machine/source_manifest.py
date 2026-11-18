"""Record installed Debian copyleft packages and version-pinned source locations."""

import re
import subprocess
from pathlib import Path
from urllib.parse import quote


def source_manifest(rows: str, doc_root: Path) -> str:
    lines = [
        "# viate-bot machine image: Debian GPL/LGPL source inventory",
        "# Generated from installed dpkg metadata and package copyright files.",
        "# Conservative inclusion: a GPL/LGPL reference includes the package, even for a license alternative or an embedded component.",
        "# Licenses are copyright-file identifiers/references, not a legal determination of each file's license.",
        "# Source URLs select the exact Debian source package version, including Debian patches and build rules.",
        "# This is a source-location inventory, not a source archive or a written source offer.",
        "Package\tBinary-Version\tSource-Package\tSource-Version\tLicenses\tSource-URL\tCopyright",
    ]
    for row in sorted(rows.splitlines()):
        status, binary, version, source, source_version = row.split("\t")
        if status != "installed":
            continue
        name = binary.split(":", 1)[0]
        copyright_path = doc_root / name / "copyright"
        text = copyright_path.read_text(encoding="utf-8", errors="replace")
        references = set(re.findall(r"\b(?:A?GPL|LGPL)(?:[- ]?(?:v)?[123](?:\.[0-9])?)?(?:\+|-only|-or-later)?\b", text, re.IGNORECASE))
        if re.search(r"GNU (?:Library|Lesser) General Public License", text, re.IGNORECASE):
            references.add("LGPL")
        if re.search(r"GNU General Public License", text, re.IGNORECASE):
            references.add("GPL")
        if not references:
            continue
        identifiers = set(re.findall(r"^License:\s*(.+)$", text, re.MULTILINE))
        licenses = "; ".join(sorted(identifiers | references))
        source = source or name
        source_version = source_version or version
        url = f"https://snapshot.debian.org/package/{quote(source, safe='')}/{quote(source_version, safe='')}/"
        lines.append("\t".join((binary, version, source, source_version, licenses, url, f"/usr/share/doc/{name}/copyright")))
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    result = subprocess.run(
        ["dpkg-query", "-W", "-f=${db:Status-Status}\t${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n"],
        check=True, capture_output=True, text=True,
    )
    output = Path("/usr/share/doc/viate-bot/SOURCES.txt")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(source_manifest(result.stdout, Path("/usr/share/doc")), encoding="utf-8")
