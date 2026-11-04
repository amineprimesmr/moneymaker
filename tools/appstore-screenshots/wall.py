from PIL import Image,ImageDraw,ImageFilter,ImageFont
import math,json
W='public/widgets/'
def load(n,w):
    im=Image.open(W+n+'.png').convert('RGBA');return im.resize((w,round(im.height*w/im.width)),Image.LANCZOS)
cv=Image.new('RGBA',(2600,2800),(0,0,0,0))
items=[('globe',260,150,900),('mrr-small',1200,150,420),('transactions',1660,150,900),
('transactions',-40,640,900),('overview-large',900,640,900),('globe',1840,640,900),
('mrr-small',440,1100,420),('mrr-small',1840,1120,420),
('globe',-20,1590,900),('transactions',900,1630,900),('mrr-small',1840,1600,420),
('mrr-small',440,2060,420),('globe',900,2120,900)]
for n,x,y,w in items:
    im=load(n,w);a=im.split()[3]
    sh=Image.new('RGBA',cv.size,(0,0,0,0));s=Image.new('RGBA',im.size,(0,0,0,190));s.putalpha(a.point(lambda v:int(v*.75)));sh.paste(s,(x+24,y+36));cv=Image.alpha_composite(cv,sh.filter(ImageFilter.GaussianBlur(26)))
    edge=a.filter(ImageFilter.MaxFilter(5));o=Image.new('RGBA',im.size,(255,255,255,0));o.putalpha(edge.point(lambda v:int(v*.28)));cv.alpha_composite(o,(x,y));cv.alpha_composite(im,(x,y))
cv=cv.resize((round(cv.width*.84),round(cv.height*.84)),Image.LANCZOS)
rot=cv.rotate(-9,Image.BICUBIC,expand=True)
cx,cy=rot.width//2,rot.height//2
out=rot.crop((cx-660,cy-1190,cx+660,cy+1190)) # 1320x2380
a=out.split()[3];f=Image.new('L',out.size,255);d=ImageDraw.Draw(f)
for y in range(1900,2380): d.line([(0,y),(1320,y)],fill=max(0,255-int((y-1900)*255/400)))
from PIL import ImageChops
out.putalpha(ImageChops.multiply(a,f));out.save('public/pops/wall.png')
