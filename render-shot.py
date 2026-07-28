"""Render page 1 of a PDF to a cropped PNG (used by tracker.js for Telegram screenshots).
Usage: py render-shot.py in.pdf out.png
Crops surrounding white margin (10px pad) so the Telegram photo is just the cells.
"""
import sys
import pypdfium2 as pdfium
from PIL import Image, ImageChops

pdf = pdfium.PdfDocument(sys.argv[1])
img = pdf[0].render(scale=3).to_pil().convert("RGB")
bg = Image.new("RGB", img.size, (255, 255, 255))
bbox = ImageChops.difference(img, bg).getbbox()
if bbox:
    pad = 12
    l, t, r, b = bbox
    img = img.crop((max(0, l - pad), max(0, t - pad), min(img.width, r + pad), min(img.height, b + pad)))
img.save(sys.argv[2])
