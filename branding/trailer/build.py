#!/usr/bin/env python3
"""Build the Jumbo Surfer channel trailer (1920x1080) from the best rendered Shorts.
Run from the project root:  python3 branding/trailer/build.py
"""
import html, json, os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, 'work'); os.makedirs(WORK, exist_ok=True)
OBJ = os.path.join(ROOT, 'storage', 'objects')
CSS = 'file://' + os.path.join(ROOT, 'branding', 'src', 'common.css')
SEG = 5.0          # seconds per moment
N = 6              # moments
W, H = 1920, 1080

def chrome(html_text, out, transparent=False):
    src = os.path.join(WORK, os.path.basename(out) + '.html')
    open(src, 'w').write(html_text)
    args = ['google-chrome', '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
            f'--window-size={W},{H}', f'--screenshot={out}']
    if transparent: args.append('--default-background-color=00000000')
    subprocess.run(args + ['file://' + src], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def page(body, style='', bg=True):
    return f'''<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="{CSS}"><style>
html,body{{width:{W}px;height:{H}px;{'' if bg else 'background:transparent!important'}}}
.center{{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}}
.big{{font-size:190px;line-height:.95}} .sub{{font-family:"Ubuntu Sans",sans-serif;font-weight:700;color:#fff;letter-spacing:.14em;font-size:44px;margin-top:24px}}
{style}</style></head><body class="{'grad' if bg else ''}">{'<div class="grid"></div>' if bg else ''}{body}</body></html>'''

def ff(args):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y'] + args, check=True)

clips = [json.loads(l) for l in open(os.path.join(HERE, 'clips.jsonl')) if l.strip()][:N]

# Cards
chrome(page('<div class="center"><div class="big font"><span class="cyan">JUMBO</span> <span class="pink">SURFER</span></div>'
            '<div class="sub">🏄 THE BEST GAMING STREAM MOMENTS</div><div class="sub" style="font-size:34px;color:#ffe14d">EVERY. SINGLE. DAY.</div></div>'),
       os.path.join(WORK, 'intro.png'))
chrome(page('<div class="center"><div class="big font cyan" style="font-size:210px">SUBSCRIBE</div>'
            '<div class="sub">🔔 NEW SHORTS DAILY · FUNNY · RAGE · CLUTCH</div>'
            '<div class="font pink" style="font-size:80px;margin-top:40px">@JumboSurfer</div></div>'),
       os.path.join(WORK, 'outro.png'))
for i, c in enumerate(clips):
    title = html.escape(c['title'])
    chrome(page(f'''
<div style="position:absolute;left:60px;top:0;bottom:0;width:560px;display:flex;flex-direction:column;justify-content:center">
  <div class="font" style="font-size:92px;line-height:.95"><span class="cyan">JUMBO</span><br><span class="pink">SURFER</span></div>
  <div style="margin-top:28px;font-family:'Ubuntu Sans',sans-serif;font-weight:700;font-size:30px;letter-spacing:.12em;color:#fff">GAMING STREAM<br>HIGHLIGHTS</div>
</div>
<div style="position:absolute;right:60px;top:0;bottom:0;width:560px;display:flex;flex-direction:column;justify-content:center">
  <div style="font-family:'Ubuntu',sans-serif;font-weight:800;font-size:28px;color:#ffe14d;letter-spacing:.1em">#{i+1} MOMENT</div>
  <div style="margin-top:14px;font-family:'Ubuntu',sans-serif;font-weight:800;font-size:54px;line-height:1.08;color:#fff;text-shadow:0 4px 18px rgba(0,0,0,.6)">{title}</div>
</div>''', bg=False), os.path.join(WORK, f'panel{i}.png'), transparent=True)

# Segments (all 1920x1080 30fps, stereo 48k)
enc = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']
silence = ['-f', 'lavfi', '-t', '9', '-i', 'anullsrc=r=48000:cl=stereo']
def card(png, secs, out):
    ff(['-loop', '1', '-t', str(secs), '-i', png] + silence +
       ['-filter_complex', f"[0:v]scale={W}:{H},zoompan=z='min(zoom+0.0008,1.06)':d={int(secs*30)}:s={W}x{H}:fps=30,fade=t=in:st=0:d=0.4,fade=t=out:st={secs-0.4}:d=0.4[v]",
        '-map', '[v]', '-map', '1:a', '-t', str(secs)] + enc + [out])

segs = []
card(os.path.join(WORK, 'intro.png'), 3.2, os.path.join(WORK, 's_intro.mp4')); segs.append('s_intro.mp4')
for i, c in enumerate(clips):
    src = os.path.join(OBJ, c['key'])
    off = c['off'] if c['off'] is not None else c['dur'] / 2
    start = max(0.0, min(off - 2.5, c['dur'] - SEG))
    out = os.path.join(WORK, f's{i}.mp4')
    ff(['-ss', f'{start:.2f}', '-t', str(SEG), '-i', src, '-i', os.path.join(WORK, f'panel{i}.png'),
        '-filter_complex',
        f"[0:v]split[a][b];[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},gblur=sigma=40,eq=brightness=-0.25[bg];"
        f"[b]scale=-2:{H}[fg];[bg][fg]overlay=(W-w)/2:0[base];[base][1:v]overlay=0:0,"
        f"fade=t=in:st=0:d=0.25,fade=t=out:st={SEG-0.25}:d=0.25[v];"
        f"[0:a]afade=t=in:st=0:d=0.2,afade=t=out:st={SEG-0.3}:d=0.3[aout]",
        '-map', '[v]', '-map', '[aout]', '-t', str(SEG)] + enc + [out])
    segs.append(f's{i}.mp4')
card(os.path.join(WORK, 'outro.png'), 4.5, os.path.join(WORK, 's_outro.mp4')); segs.append('s_outro.mp4')

lst = os.path.join(WORK, 'list.txt')
open(lst, 'w').write(''.join(f"file '{s}'\n" for s in segs))
out = os.path.join(ROOT, 'branding', 'channel-trailer.mp4')
ff(['-f', 'concat', '-safe', '0', '-i', lst, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out])
print('wrote', out)
