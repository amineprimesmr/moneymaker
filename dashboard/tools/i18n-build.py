#!/usr/bin/env python3
"""Reconstruit dashboard/public/i18n-en.js à partir de dashboard/tools/i18n-en.json (français → anglais)."""
import json, pathlib
here = pathlib.Path(__file__).parent
d = json.loads((here / "i18n-en.json").read_text())
body = json.dumps(dict(sorted(d.items())), ensure_ascii=False, separators=(",", ":"))
(here.parent / "public" / "i18n-en.js").write_text("MM_I18N_START(" + body + ");\n")
print(len(d), "textes")
