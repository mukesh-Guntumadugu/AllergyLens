"""OCR with boxes, one interface over several engines (DESIGN.md §7.2).

    from ocr_engines import ocr_lines
    lines, (W, H) = ocr_lines(Path("menu.png"), engine="rapidocr")   # [{text, x, y, w, h, conf}] in pixels

Engines: rapidocr (default; PaddleOCR models via ONNX, pip install rapidocr-onnxruntime),
tesseract (pip install pytesseract + the tesseract binary). RapidOCR returns text LINES
with a 4-point box each, which is what the Lens needs; Tesseract returns words, which we
group into lines the same way ocr_menu.py always did.
"""
from __future__ import annotations

from pathlib import Path


_RAPID = None


def _rapid_engine():
    """One engine per process, pinned to ONE thread: callers parallelise across processes (the gate runs
    OCR_WORKERS of them). The default ONNX runtime pool is one thread per core PER PROCESS, which with 18
    worker processes meant 5,000 threads and a load of 500 on 20 cores."""
    global _RAPID
    if _RAPID is None:
        import os
        os.environ.setdefault("OMP_NUM_THREADS", "1")
        from rapidocr_onnxruntime import RapidOCR
        n = int(os.environ.get("OCR_THREADS", "1"))
        _RAPID = RapidOCR(intra_op_num_threads=n, inter_op_num_threads=n)
    return _RAPID


def _rapid(image_path: Path):
    from PIL import Image

    img = Image.open(image_path).convert("RGB")
    engine = _rapid_engine()
    result, _ = engine(str(image_path))
    lines = []
    for box, text, conf in result or []:
        xs = [p[0] for p in box]; ys = [p[1] for p in box]
        x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
        lines.append({"text": text.strip(), "x": round(x1), "y": round(y1), "w": round(x2 - x1), "h": round(y2 - y1), "conf": round(float(conf), 3)})
    return lines, img.size


def _tesseract(image_path: Path, scale: float = 2.0):
    import pytesseract
    from PIL import Image

    img = Image.open(image_path).convert("L")
    big = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
    data = pytesseract.image_to_data(big, output_type=pytesseract.Output.DICT, config="--psm 11")
    words = []
    for i, word in enumerate(data["text"]):
        w = word.strip()
        if not w or int(float(data["conf"][i])) < 30:
            continue
        words.append({"text": w, "x": data["left"][i] / scale, "y": data["top"][i] / scale, "w": data["width"][i] / scale, "h": data["height"][i] / scale, "conf": float(data["conf"][i]) / 100})
    return group_words(words), img.size


def group_words(words):
    """Words -> visual lines: rows by vertical centre, split at wide horizontal gaps (column boundaries)."""
    if not words:
        return []
    med_h = sorted(wd["h"] for wd in words)[len(words) // 2] or 10
    words.sort(key=lambda wd: wd["y"] + wd["h"] / 2)
    rows, current = [], [words[0]]
    for wd in words[1:]:
        cy, py = wd["y"] + wd["h"] / 2, current[-1]["y"] + current[-1]["h"] / 2
        (current.append(wd) if abs(cy - py) <= med_h * 0.6 else (rows.append(current), current.clear(), current.append(wd)))
    rows.append(current)
    out = []
    for row in rows:
        row.sort(key=lambda wd: wd["x"])
        seg = [row[0]]
        for wd in row[1:]:
            prev = seg[-1]
            if wd["x"] - (prev["x"] + prev["w"]) > med_h * 2.5:
                out.append(seg); seg = [wd]
            else:
                seg.append(wd)
        out.append(seg)
    lines = []
    for seg in out:
        x1 = min(wd["x"] for wd in seg); y1 = min(wd["y"] for wd in seg)
        x2 = max(wd["x"] + wd["w"] for wd in seg); y2 = max(wd["y"] + wd["h"] for wd in seg)
        lines.append({"text": " ".join(wd["text"] for wd in seg), "x": round(x1), "y": round(y1), "w": round(x2 - x1), "h": round(y2 - y1),
                      "conf": round(sum(wd["conf"] for wd in seg) / len(seg), 3)})
    return lines


def ocr_lines(image_path: Path, engine: str = "rapidocr"):
    """Return (lines, (W, H)); lines sorted top-to-bottom, left-to-right."""
    if engine == "rapidocr":
        lines, size = _rapid(image_path)
    elif engine == "tesseract":
        lines, size = _tesseract(image_path)
    else:
        raise ValueError(engine)
    med_h = sorted(l["h"] for l in lines)[len(lines) // 2] if lines else 10
    lines.sort(key=lambda l: (round(l["y"] / max(med_h, 1)), l["x"]))
    return lines, size
