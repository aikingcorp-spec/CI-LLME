#!/usr/bin/env python3
"""Rebuild the README hero from the untouched owner master, without cropping it."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
MASTER = ROOT.parent.parent / "evidence/vnb-icons/owner-master.png"
OUTPUT = ROOT / "docs/readme-hero.png"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    return ImageFont.truetype(name, size)


def main() -> None:
    canvas = Image.new("RGB", (1280, 640), "#fafaf9")
    draw = ImageDraw.Draw(canvas)
    ink = "#161616"
    muted = "#616161"
    draw.rounded_rectangle((44, 44, 230, 104), radius=20, fill="white", outline="#e3e3df", width=2)
    draw.text((68, 56), "VNBot", font=font(34, True), fill=ink)
    draw.text((62, 214), "Your bots.", font=font(68, True), fill=ink)
    draw.text((62, 300), "Your machine.", font=font(68, True), fill=ink)
    draw.text((66, 418), "AI teammates you actually own.", font=font(28), fill=muted)
    draw.rounded_rectangle((64, 520, 400, 574), radius=27, fill=ink)
    draw.text((90, 534), "Meet VNBot", font=font(23, True), fill="white")
    master = Image.open(MASTER).convert("RGB")
    # Fit the complete square tile; no pixels of the owner image are cropped.
    art = master.resize((520, 520), Image.Resampling.LANCZOS)
    canvas.paste(art, (705, 60))
    canvas.save(OUTPUT, "PNG")


if __name__ == "__main__":
    main()
