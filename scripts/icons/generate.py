#!/usr/bin/env python3
from __future__ import annotations
import hashlib, io, json, struct, sys
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parents[2]
MASTER_PATH = ROOT / 'scripts/icons/owner-master.png'
OUT = ROOT / 'scripts/icons/approved-icons.json'

PNG_FILES = [
 'apps/desktop/assets/icon.png','apps/desktop/assets/icon-macos.png',
 'packages/ui-tokens/assets/VNBot.icon/Assets/vnbot.png',
 'apps/www/public/icon-512.png','apps/www/public/icon-192.png','apps/www/public/favicon.png','apps/www/public/favicon-16x16.png','apps/www/public/favicon-32x32.png','apps/www/public/apple-touch-icon.png',
 'apps/www/public/landing/icon-512.png','apps/www/public/landing/icon-192.png','apps/www/public/landing/favicon-16.png','apps/www/public/landing/favicon-32.png','apps/www/public/landing/apple-touch-icon.png','apps/www/public/landing/icon-maskable-192.png','apps/www/public/landing/icon-maskable-512.png',
 'apps/web/public/icon-512.png','apps/web/public/icon-192.png','apps/web/public/favicon.png','apps/web/public/favicon-16x16.png','apps/web/public/favicon-32x32.png','apps/web/public/apple-touch-icon.png','apps/web/public/icon-maskable-192.png','apps/web/public/icon-maskable-512.png',
 'apps/mobile/assets/icon.png','apps/mobile/assets/favicon.png','apps/mobile/assets/icon-background.png','apps/mobile/assets/adaptive-icon.png','apps/mobile/assets/monochrome-icon.png','apps/mobile/assets/notification-icon.png','apps/mobile/assets/splash-icon.png',
]
ICO_FILES = ['apps/desktop/assets/icon.ico','apps/www/public/favicon.ico','apps/www/public/landing/favicon.ico','apps/web/public/favicon.ico']
ICNS_FILES = ['apps/desktop/assets/icon.icns']
OWNER_COPIES = ['apps/mobile/assets/owner-avatar.png','packages/ui-web/src/assets/owner-avatar.png']

def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()

def size_of(rel: str, fallback: tuple[int,int]=(1024,1024)):
    p=ROOT/rel
    if p.exists():
        try: return Image.open(p).size
        except Exception: pass
    return fallback

def rgb_master():
    return Image.open(MASTER_PATH).convert('RGB')

def fit(im, size):
    return im.resize(size, Image.Resampling.LANCZOS)

def solid_bg(im):
    # average of the four corners, which are the owner's near-white tile/background.
    px=im.load(); n=min(12, im.width//20, im.height//20)
    pts=[]
    for box in [(0,0,n,n),(im.width-n,0,im.width,n),(0,im.height-n,n,im.height),(im.width-n,im.height-n,im.width,im.height)]:
        c=Image.Image.getbbox(im.crop(box))
        crop=im.crop(box)
        pts += list(crop.getdata())
    return tuple(round(sum(c[i] for c in pts)/len(pts)) for i in range(3))

def maskable(master, size, ratio=.8):
    bg=solid_bg(master); canvas=Image.new('RGB', size, bg)
    inner=(round(size[0]*ratio),round(size[1]*ratio))
    art=fit(master, inner)
    canvas.paste(art, ((size[0]-inner[0])//2,(size[1]-inner[1])//2))
    return canvas

def mascot_alpha(master):
    # Keep the connected artwork, not the near-white tile or its grey ghost edge.
    # Close small weave gaps before filling every enclosed hole in the silhouette.
    hsv = master.convert('HSV')
    saturated = hsv.getchannel('S').point(lambda value: 255 if value >= 28 else 0)
    connected = saturated.filter(ImageFilter.MaxFilter(15)).filter(ImageFilter.MinFilter(15))
    main = connected.copy()
    ImageDraw.floodfill(main, (master.width // 2, master.height // 2), 128, thresh=0)
    main = main.point(lambda value: 255 if value == 128 else 0)
    outside = ImageOps.invert(main)
    ImageDraw.floodfill(outside, (0, 0), 128, thresh=0)
    filled = outside.point(lambda value: 0 if value == 128 else 255)
    # The tile's grey floor shadow is attached to the feet in the source image.
    # Its low saturation is only removed below the body, where it is exterior.
    lower = Image.new('L', master.size, 255)
    saturation = hsv.getchannel('S').point(lambda value: 255 if value >= 45 else 0)
    lower.paste(saturation.crop((0, 1060, master.width, 1100)), (0, 1060))
    foot_saturation = hsv.getchannel('S').point(lambda value: 255 if value >= 130 else 0)
    lower.paste(foot_saturation.crop((0, 1100, master.width, master.height)), (0, 1100))
    filled = ImageChops.multiply(filled, lower)
    outside = ImageOps.invert(filled)
    ImageDraw.floodfill(outside, (0, 0), 128, thresh=0)
    filled = outside.point(lambda value: 0 if value == 128 else 255)
    edge = filled.filter(ImageFilter.GaussianBlur(1.2))
    return edge.point(lambda value: 0 if value < 5 else (255 if value > 245 else value))

def eye_holes(master):
    # Select the two dark eyes before dilation; the hat's dark weave is outside
    # these regions of the checked-in owner master.
    mask = Image.new('L', master.size)
    draw = ImageDraw.Draw(mask)
    for box in ((.26,.36,.39,.50),(.45,.42,.59,.57)):
        draw.ellipse(tuple(round(v * master.width) for v in box), fill=255)
    dark = ImageOps.grayscale(master).point(lambda value: 255 if value < 90 else 0)
    return ImageChops.multiply(dark, mask).filter(ImageFilter.MaxFilter(31)).filter(ImageFilter.GaussianBlur(2))

def android_art(master,size,alpha=None):
    # This mascot shape fits inside the centered circle of radius 30%.
    if alpha is None: alpha = mascot_alpha(master)
    bbox = alpha.getbbox()
    art = master.convert('RGBA').crop(bbox)
    art.putalpha(alpha.crop(bbox))
    side = round(min(size)*.50)
    art.thumbnail((side,side),Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA',size,(0,0,0,0))
    canvas.alpha_composite(art,((size[0]-art.width)//2,(size[1]-art.height)//2))
    return canvas

def adaptive(master,size):
    return android_art(master,size)

def silhouette(master,size):
    art=fit(master.convert('RGBA'),size)
    binary=fit(mascot_alpha(master),size).point(lambda value: 255 if value >= 128 else 0)
    outside=ImageOps.invert(binary)
    ImageDraw.floodfill(outside,(0,0),128,thresh=0)
    binary=outside.point(lambda value: 0 if value == 128 else 255)
    alpha=ImageChops.lighter(binary,binary.filter(ImageFilter.GaussianBlur(1)))
    interior=alpha.point(lambda value: 255 if value > 0 else 0).filter(ImageFilter.MinFilter(11))
    alpha.paste(255,mask=interior)
    art.putalpha(alpha)
    return art

def monochrome(master,size):
    alpha=ImageChops.subtract(mascot_alpha(master),eye_holes(master))
    # A narrow cut follows the hat's lower rim so the hat remains legible in one colour.
    gap=Image.new('L',master.size)
    ImageDraw.Draw(gap).line([(240,574),(330,468),(430,405),(530,383),(650,386),
        (770,412),(890,462),(1020,539),(1140,625)],fill=255,width=12,joint='curve')
    gap=gap.filter(ImageFilter.GaussianBlur(1.5))
    alpha=ImageChops.subtract(alpha,gap)
    alpha=android_art(master,size,alpha).getchannel('A')
    return Image.merge('RGBA',(Image.new('L',size,255),)*3 + (alpha,))

def write_png(rel, im):
    p=ROOT/rel; p.parent.mkdir(parents=True,exist_ok=True); im.save(p,'PNG')

def existing_size(rel):
    p=ROOT/rel
    try:return Image.open(p).size
    except Exception:return (1024,1024)

def main():
    master=rgb_master(); bg=solid_bg(master)
    for rel in OWNER_COPIES:
        p=ROOT/rel; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(MASTER_PATH.read_bytes())
    for rel in PNG_FILES:
        size=existing_size(rel)
        if rel == 'apps/desktop/assets/icon.png': im=silhouette(master,size)
        elif rel.endswith('adaptive-icon.png'): im=adaptive(master,size)
        elif rel.endswith('monochrome-icon.png') or rel.endswith('notification-icon.png'): im=monochrome(master,size)
        elif rel.endswith('icon-background.png'): im=Image.new('RGB',size,bg)
        elif rel.endswith('splash-icon.png'): im=maskable(master,size,.8).convert('RGBA')
        elif 'maskable' in rel: im=maskable(master,size,.8)
        else: im=fit(master,size)
        write_png(rel,im)
    for rel in ICO_FILES:
        p=ROOT/rel; sizes=[16,24,32,48,64,128,256] if 'desktop' in rel else [16,32,48]
        base=fit(master,(max(sizes),max(sizes))).convert('RGB'); p.parent.mkdir(parents=True,exist_ok=True); base.save(p,'ICO',sizes=[(s,s) for s in sizes])
    # Pillow writes a multi-representation ICNS when given sizes via append_images.
    p=ROOT/ICNS_FILES[0]; p.parent.mkdir(parents=True,exist_ok=True)
    frames=[fit(master,(s,s)).convert('RGBA') for s in (16,32,64,128,256,512,1024)]
    frames[0].save(p,'ICNS',append_images=frames[1:])
    # Pillow omits the legacy 16@1x and 32@1x representations.
    chunks = []
    for size, kind in [(16, b'icp4'), (32, b'icp5')]:
        png = io.BytesIO()
        fit(master,(size,size)).save(png,'PNG')
        payload = png.getvalue()
        chunks.append(kind + struct.pack('>I',len(payload)+8) + payload)
    data = p.read_bytes() + b''.join(chunks)
    p.write_bytes(data[:4] + struct.pack('>I',len(data)) + data[8:])
    approved={str(Path(rel)):sha(ROOT/rel) for rel in PNG_FILES+ICO_FILES+ICNS_FILES+OWNER_COPIES}
    approved['scripts/icons/owner-master.png']=sha(MASTER_PATH)
    OUT.write_text(json.dumps(approved,indent=2,sort_keys=True)+'\n')
    print(json.dumps({'master':approved['scripts/icons/owner-master.png'],'files':len(approved)-1},indent=2))
if __name__=='__main__': main()
