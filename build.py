"""Builds index.html (the playable single-file page) from app.html + sim.js."""
from pathlib import Path

root = Path(__file__).parent
page = (root / "app.html").read_text(encoding="utf-8")
sim = (root / "sim.js").read_text(encoding="utf-8")
(root / "index.html").write_text(page.replace("/*__SIM__*/", sim), encoding="utf-8")
print("Built index.html")
