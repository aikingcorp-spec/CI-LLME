#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, sys
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[2]
MASTER_PATH = ROOT.parent.parent / 'evidence/vnb-icons/owner-master.png'
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

def adaptive(master,size):
    # Expo Android foreground: transparent and 66% safe zone.
    canvas=Image.new('RGBA', size, (0,0,0,0)); inner=(round(size[0]*.66),round(size[1]*.66))
    art=fit(master,inner).convert('RGBA'); canvas.alpha_composite(art,((size[0]-inner[0])//2,(size[1]-inner[1])//2)); return canvas

def monochrome(master,size):
    art=fit(master,size).convert('RGBA'); alpha=art.getchannel('A')
    # Keep silhouette visible while remaining a native monochrome alpha asset.
    return Image.merge('RGBA',(Image.new('L',size,255),)*3 + (alpha,))

def write_png(rel, im):
    p=ROOT/rel; p.parent.mkdir(parents=True,exist_ok=True); im.save(p,'PNG')

def existing_size(rel):
    p=ROOT/rel
    try:return Image.open(p).size
    except Exception:return (1024,1024)

def main():
    master=rgb_master(); bg=solid_bg(master)
    for rel in PNG_FILES:
        size=existing_size(rel)
        if rel.endswith('adaptive-icon.png'): im=adaptive(master,size)
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
    approved={str(Path(rel)):sha(ROOT/rel) for rel in PNG_FILES+ICO_FILES+ICNS_FILES}
    approved['evidence/vnb-icons/owner-master.png']=sha(MASTER_PATH)
    OUT.write_text(json.dumps(approved,indent=2,sort_keys=True)+'\n')
    print(json.dumps({'master':approved['evidence/vnb-icons/owner-master.png'],'files':len(approved)-1},indent=2))
if __name__=='__main__': main()
