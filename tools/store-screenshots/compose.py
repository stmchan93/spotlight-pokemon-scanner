"""Compose App Store 6.9" screenshots (1320x2868) from raw simulator captures.

Layout (matches what the top-ranked scanner apps do): headline + subline at the top,
a phone frame cropped so only the top ~62% of the screen shows (UI reads big at
thumbnail size), and one white callout that overlaps the frame edge carrying the
single number we want the eye to land on.

usage: compose.py <spec.json> <out_dir>
spec: [{"src": "...png", "out": "01.png", "head": [[["Scan any card.", "w"]], [["Instant ", "a"], ["price.", "w"]]],
        "sub": ["..."], "crop_top": 0, "callout": {"title": "...", "sub": "...", "value": "$412", "y": 1700, "side": "left"}}]
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1320, 2868
FONT = '/System/Library/Fonts/SFNS.ttf'
BG_TOP, BG_BOTTOM = (27, 12, 46), (18, 9, 34)
WHITE, ACCENT, SUB = (255, 255, 255), (178, 140, 255), (205, 198, 222)
INK, INK_SOFT = (20, 16, 30), (110, 104, 122)
MARGIN = 110
PHONE_W = 1140          # frame width on the canvas; screen is inset by the bezel
BEZEL = 22
SCREEN_RADIUS = 110
PHONE_TOP = 760         # where the phone's top edge sits
COLORS = {'w': WHITE, 'a': ACCENT}


def font(size, weight='Bold'):
    f = ImageFont.truetype(FONT, size)
    f.set_variation_by_name(weight)
    return f


def background():
    bg = Image.new('RGB', (W, H), BG_TOP)
    px = bg.load()
    for y in range(H):
        t = y / H
        c = tuple(int(BG_TOP[i] * (1 - t) + BG_BOTTOM[i] * t) for i in range(3))
        for x in range(W):
            px[x, y] = c
    # soft glow behind the headline, like the live set
    glow = Image.new('RGB', (W, H), (0, 0, 0))
    ImageDraw.Draw(glow).ellipse((-200, 150, W + 200, 1100), fill=(70, 40, 120))
    glow = glow.filter(ImageFilter.GaussianBlur(220))
    return Image.blend(bg, Image.composite(glow, bg, Image.new('L', (W, H), 90)), 0.6).convert('RGBA')


def fit_font(d, lines, size, max_width):
    while size > 70:
        f = font(size)
        if all(sum(d.textlength(t, font=f) for t, _ in segs) <= max_width for segs in lines):
            return f
        size -= 4
    return font(size)


def draw_headline(im, head, sub):
    d = ImageDraw.Draw(im)
    f = fit_font(d, head, 132, W - 2 * MARGIN)
    y = 170
    for segs in head:
        x = MARGIN
        for text, key in segs:
            d.text((x, y), text, font=f, fill=COLORS[key])
            x += d.textlength(text, font=f)
        y += f.size + 6
    y += 30
    sf = font(52, 'Regular')
    for line in sub:
        d.text((MARGIN, y), line, font=sf, fill=SUB)
        y += 68


def place_phone(im, shot_path, crop_top):
    shot = Image.open(shot_path).convert('RGBA')
    screen_w = PHONE_W - 2 * BEZEL
    scale = screen_w / shot.width
    shot = shot.resize((screen_w, int(shot.height * scale)), Image.LANCZOS)
    shot = shot.crop((0, int(crop_top * scale), screen_w, shot.height))
    frame_h = H - PHONE_TOP + 200  # runs off the bottom edge on purpose
    x0 = (W - PHONE_W) // 2
    # bezel: dark titanium rounded rect with a thin highlight
    frame = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(frame)
    fd.rounded_rectangle((x0, PHONE_TOP, x0 + PHONE_W, PHONE_TOP + frame_h), SCREEN_RADIUS + BEZEL, fill=(28, 26, 32, 255), outline=(92, 88, 100, 255), width=3)
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x0 - 10, PHONE_TOP + 30, x0 + PHONE_W + 10, PHONE_TOP + frame_h), SCREEN_RADIUS + BEZEL, fill=(0, 0, 0, 160))
    im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(40)))
    im.alpha_composite(frame)
    mask = Image.new('L', shot.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, shot.width, shot.height), SCREEN_RADIUS, fill=255)
    # square off the bottom corners: the frame runs off-canvas there
    ImageDraw.Draw(mask).rectangle((0, shot.height - SCREEN_RADIUS, shot.width, shot.height), fill=255)
    im.paste(shot, (x0 + BEZEL, PHONE_TOP + BEZEL), mask)
    # dynamic island
    ImageDraw.Draw(im).rounded_rectangle((W // 2 - 150, PHONE_TOP + BEZEL + 28, W // 2 + 150, PHONE_TOP + BEZEL + 112), 42, fill=(0, 0, 0, 255))


def draw_callout(im, co):
    d = ImageDraw.Draw(im)
    # Stacked: name line on top, the number huge underneath (FoilSnap/Double Holo
    # pattern). Nothing shares a row, so nothing can collide.
    tf, sf, vf = font(50, 'Semibold'), font(40, 'Regular'), font(150)
    pad = 52
    cw = int(max(d.textlength(co['title'], font=tf), d.textlength(co['sub'], font=sf), d.textlength(co['value'], font=vf) + (d.textlength(co.get('badge', ''), font=font(44, 'Semibold')) + 60 if co.get('badge') else 0)) + 2 * pad)
    cw = min(max(cw, 700), W - 120)
    cw = co.get('width', cw)
    ch = pad + 60 + 52 + 20 + 170 + pad - 30
    x0 = 60 if co.get('side', 'left') == 'left' else W - 60 - cw
    y0 = co['y']
    box = (x0, y0, x0 + cw, y0 + ch)
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x0 + 8, y0 + 18, x0 + cw + 8, y0 + ch + 18), 44, fill=(0, 0, 0, 130))
    im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(26)))
    d.rounded_rectangle(box, 44, fill=WHITE)
    d.text((x0 + pad, y0 + pad - 6), co['title'], font=tf, fill=INK)
    d.text((x0 + pad, y0 + pad + 58), co['sub'], font=sf, fill=INK_SOFT)
    vy = y0 + pad + 58 + 52 + 10
    d.text((x0 + pad - 4, vy), co['value'], font=vf, fill=INK)
    if co.get('badge'):
        bf = font(44, 'Semibold')
        bw = d.textlength(co['badge'], font=bf) + 40
        bx = x0 + pad + d.textlength(co['value'], font=vf) + 24
        d.rounded_rectangle((bx, vy + 70, bx + bw, vy + 140), 35, fill=(229, 244, 236))
        d.text((bx + 20, vy + 78), co['badge'], font=bf, fill=(31, 122, 77))


def main():
    spec = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    bg = background()
    for s in spec:
        im = bg.copy()
        draw_headline(im, s['head'], s.get('sub', []))
        place_phone(im, s['src'], s.get('crop_top', 0))
        if s.get('callout'):
            draw_callout(im, s['callout'])
        im.convert('RGB').save(out / s['out'])
        print(out / s['out'])


if __name__ == '__main__':
    main()
