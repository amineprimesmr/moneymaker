from PIL import Image,ImageDraw,ImageFont,ImageOps
import math,json
S=4;W,H=960*S,330*S
L=Image.new('RGBA',(W//2,H),(0,0,0,0))
def bez(t):
    p0,p1,p2=(245,302),(62,235),(145,24)
    return tuple(((1-t)**2*p0[k]+2*t*(1-t)*p1[k]+t*t*p2[k])*S for k in(0,1))
def leaf(x,y,ang,ln,wd,shade):
    # feuille effilée, dégradé de la base sombre à la pointe claire
    n=40;d=ImageDraw.Draw(L);ca,sa=math.cos(ang),math.sin(ang)
    for i in range(n):
        t0,t1=i/n,(i+1)/n
        o=lambda t:wd*math.sin(math.pi*t**.75)**.9
        q=[(x+t0*ln*ca-o(t0)*sa,y+t0*ln*sa+o(t0)*ca),(x+t1*ln*ca-o(t1)*sa,y+t1*ln*sa+o(t1)*ca),(x+t1*ln*ca+o(t1)*sa,y+t1*ln*sa-o(t1)*ca),(x+t0*ln*ca+o(t0)*sa,y+t0*ln*sa-o(t0)*ca)]
        v=int(shade*(.55+.45*t0));d.polygon(q,fill=(v,v,min(255,v+3),255))
N=8
for i in range(N):
    t=(i+.3)/N;x,y=bez(t);x2,y2=bez(min(1,t+.01));tg=math.atan2(y2-y,x2-x)
    k=1-.35*t;sh=int(150+105*t)
    leaf(x,y,tg-.62,68*S*k,15*S*k,sh)   # extérieur
    leaf(x,y,tg+.5,52*S*k,12*S*k,sh)     # intérieur
x,y=bez(1);leaf(x,y,math.atan2(bez(1)[1]-bez(.97)[1],bez(1)[0]-bez(.97)[0]),40*S,7*S,255)
k=.85;Ls=L.resize((int(W/2*k),int(H*k)),Image.LANCZOS);L=Image.new('RGBA',(W//2,H),(0,0,0,0));L.alpha_composite(Ls,(int(82*S*(1-k)),int(H*(1-k)/2)))
C=Image.new('RGBA',(W,H),(0,0,0,0));C.alpha_composite(L,(0,0));C.alpha_composite(ImageOps.mirror(L),(W//2,0))
from PIL import ImageFilter
import numpy as np
F='/System/Library/Fonts/Supplemental/Impact.ttf'
M=Image.new('L',(W,H),0);d=ImageDraw.Draw(M)
def txt(s,y,sz):
    f=ImageFont.truetype(F,sz*S);w=d.textlength(s,font=f);d.text((W/2-w/2,y*S),s,font=f,fill=255)
fa=ImageFont.truetype(F,84*S);fb=ImageFont.truetype(F,68*S);wa=d.textlength('0%',font=fa);wb=d.textlength(' DE COMMISSION',font=fb);x=W/2-(wa+wb)/2;bl=88*S+fb.getmetrics()[0]
d.text((x,bl),'0%',font=fa,fill=255,anchor='ls');d.text((x+wa,bl),' DE COMMISSION',font=fb,fill=255,anchor='ls')
txt('SUR TES VENTES',170,68)
M=M.filter(ImageFilter.MinFilter(9)).filter(ImageFilter.GaussianBlur(1))
# même dégradé que les lauriers : clair en haut, argent sombre en bas
y0,y1=M.getbbox()[1],M.getbbox()[3]
g=np.clip((np.arange(H)-y0)/(y1-y0),0,1)[:,None]
v=(245*(1-g)+150*g)*np.ones((H,W))
G=Image.merge('RGB',[Image.fromarray(v.astype(np.uint8))]*3)
C.paste(G.convert('RGBA'),(0,0),M)
C.resize((960,330),Image.LANCZOS).save('public/pops/badge.png')
p='app-store-screenshots.json';D=json.load(open(p))
for e in D['slidesByDevice'][D['device']][0]['imageElements']:
    if e['id']=='badge':e['transform'].update(x=180,y=2440,width=960,height=330)
json.dump(D,open(p,'w'),ensure_ascii=False,indent=2)
