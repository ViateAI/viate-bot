import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("source_manifest", Path(__file__).with_name("source_manifest.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SourceManifestTest(unittest.TestCase):
    def test_includes_lgpl_libraries_and_exact_source_versions_not_binary_rebuild_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for package, license in [("libexample1", "License: LGPL-2.1+\n"), ("utility", "GNU General Public License version 2"), ("permissive", "License: MIT\n")]:
                (root / package).mkdir()
                (root / package / "copyright").write_text(license)
            rows = "\n".join([
                "installed\tlibexample1:arm64\t1:2.3-4+b1\texample\t1:2.3-4",
                "installed\tutility\t2.0-1\tutility-source\t2.0-1",
                "installed\tpermissive\t1.0\tpermissive\t1.0",
                "config-files\tremoved\t1\tremoved\t1",
            ])
            lines = module.source_manifest(rows, root).splitlines()
            records = {line.split("\t")[0]: line.split("\t") for line in lines if not line.startswith("#")}
            library = records["libexample1:arm64"]
            self.assertEqual(library[1:4], ["1:2.3-4+b1", "example", "1:2.3-4"])
            self.assertIn("LGPL-2.1+", library[4])
            self.assertEqual(library[5], "https://snapshot.debian.org/package/example/1%3A2.3-4/")
            self.assertIn("utility", records)
            self.assertNotIn("permissive", records)
            self.assertNotIn("removed", records)

    def test_fails_closed_when_an_installed_package_has_no_copyright_file(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                module.source_manifest("installed\tmissing\t1\tmissing\t1", Path(directory))


if __name__ == "__main__":
    unittest.main()
