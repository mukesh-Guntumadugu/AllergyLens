"""Shared quality checks: is this OCR output readable, is this "dish name" a real name?

Used by the gate (image quality), the labeller and merge (dish names) and the ingredient
researcher (what is worth a web search). Keeping them in one place means one rule set.
"""
from __future__ import annotations

import re

MIN_LONG_SIDE_PX = 700      # a 619 px thumbnail of a full menu gave OCR junk ("Jomato Basil Soup")
MIN_MEAN_CONF = 0.70        # RapidOCR per-line confidence, averaged over the image
MIN_LINES = 6

# lines that are sizes, option labels or menu scaffolding, not dishes
_SIZE_RE = re.compile(r'^\s*\d{1,2}\s*(?:"|”|in(?:ch)?|oz|lb|pc|pcs|ct|cl|ml|l)?\s*$', re.I)
_SCAFFOLD = {"small", "medium", "large", "regular", "single", "double", "triple", "half", "whole", "cup", "bowl",
             "add", "extra", "extras", "sides", "side", "toppings", "topping", "choice", "choose", "pick", "select",
             "combo", "kids", "kid's", "menu", "lunch", "dinner", "breakfast", "specials", "special", "favorites", "favorite",
             "hours", "open", "closed", "phone", "call", "order", "online", "delivery", "catering", "price", "prices", "each", "per",
             "build", "your", "own", "one", "any", "base", "meat", "protein", "sauce", "sauces", "style", "with", "and", "or", "the", "of"}


def is_junk_name(name: str, ocr_conf: float | None = None) -> bool:
    """True when a labelled 'dish' line is not usable as a dish name."""
    n = (name or "").strip()
    if len(n) < 3 or len(n) > 80:
        return True
    low = n.lower()
    if _SIZE_RE.match(n):                                   # 6"  10"  12 oz
        return True
    letters = sum(c.isalpha() for c in n)
    if letters < 0.6 * max(1, len(n.replace(" ", ""))):     # "B.Y.O.B", "$9 - 12", "kyfas0Ng [) @8"
        return True
    if not re.search(r"[aeiouy]", low):                     # no vowel: OCR fragments
        return True
    words = [w for w in re.split(r"[^a-z']+", low) if w]
    if not words or all(w in _SCAFFOLD for w in words):
        return True
    if len(words) > 10:                                     # a sentence, not a name
        return True
    if re.search(r"\$\s?\d", n):                            # price inside the name
        return True
    if ocr_conf is not None and ocr_conf < 0.55:
        return True
    return False


def image_quality(lines: list[dict], W: int, H: int) -> tuple[bool, str, float]:
    """(ok, reason, mean_conf). ok=False means: do not extract from this image, whatever the gate thinks."""
    confs = [float(l.get("conf", 1.0)) for l in lines]
    mean_conf = round(sum(confs) / len(confs), 3) if confs else 0.0
    if max(W, H) < MIN_LONG_SIDE_PX:
        return False, "low-resolution", mean_conf
    if len(lines) < MIN_LINES:
        return False, "too-little-text", mean_conf
    if mean_conf < MIN_MEAN_CONF:
        return False, "unreadable-ocr", mean_conf
    return True, "ok", mean_conf
