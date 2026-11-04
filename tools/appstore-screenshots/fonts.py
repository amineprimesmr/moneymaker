from PIL import Image,ImageDraw,ImageFont,ImageFilter
import numpy as np,glob,sys
SYS='/System/Library/Fonts/';SUP=SYS+'Supplemental/'
def find(path,style):
    for i in range(30):
        try:
            f=ImageFont.truetype(path,10,index=i)
            if f.font.style==style: return i
        except OSError: break
    raise SystemExit(f'no {style} in {path}')
O=[('A  Impact',SUP+'Impact.ttf',None,0),
('B  Avenir Next Condensed',SYS+'Avenir Next Condensed.ttc','Heavy',20),
('C  DIN Condensed',SUP+'DIN Condensed Bold.ttf',None,0),
('D  Futura',SUP+'Futura.ttc','Condensed ExtraBold',8),
('E  Didot',SUP+'Didot.ttc','Bold',6),
('F  Helvetica Neue Condensed',SYS+'HelveticaNeue.ttc','Condensed Black',4)]
bg=Image.open('public/bg/baked/1.jpg').convert('RGB')
W=1320;CW,CH=660,560
sheet=Image.new('RGB',(CW*3,CH*2),(10,10,10))
for n,(lab,p,st,tr) in enumerate(O):
    idx=find(p,st) if st else 0
    def fit(txt,target):
        lo=20
        for s in range(20,420,2):
            f=ImageFont.truetype(p,s,index=idx)
            if f.getlength(txt)+tr*(len(txt)-1)*s/200>target: break
            lo=s
        return lo
    m=Image.new('L',(W,520),0);d=ImageDraw.Draw(m)
    def line(txt,sz,y):
        f=ImageFont.truetype(p,sz,index=idx);t=tr*sz/200
        w=f.getlength(txt)+t*(len(txt)-1);x=(W-w)/2
        for i,c in enumerate(txt):
            d.text((x+f.getlength(txt[:i])+i*t,y),c,font=f,fill=255)
        return f.getbbox(txt)[3]
    s1=fit('TRACK ET ANALYSE',620);s2=fit('TES VENTES',1100)
    h=line('TRACK ET ANALYSE',s1,0)
    line('TES VENTES',s2,h+6)
    x0,y0,x1,y1=m.getbbox();t=m.crop((0,y0,W,y1))
    im=bg.copy().convert('RGBA');top=860-(y1-y0)
    fl=m.crop((0,max(0,y0-20),W,y1+20));fw,fh=fl.size;ins=fw*.24;sk=fw*.09
    q=fl.transform((W,185),Image.QUAD,(-ins-sk,0,0,fh,fw,fh,fw+ins-sk,0),Image.BICUBIC).filter(ImageFilter.GaussianBlur(8))
    im.paste(Image.new('RGBA',(W,185),(0,0,0,255)),(0,960),Image.fromarray((np.asarray(q,float)*.42).astype('uint8')))
    im.paste(Image.new('RGBA',t.size,(255,255,255,255)),(0,top),t)
    c=im.convert('RGB').crop((0,400,W,1300)).resize((CW,450),Image.LANCZOS)
    cell=Image.new('RGB',(CW,CH),(10,10,10));cell.paste(c,(0,0))
    ImageDraw.Draw(cell).text((16,464),lab,font=ImageFont.truetype(SYS+'HelveticaNeue.ttc',38,index=1),fill=(255,255,255))
    sheet.paste(cell,(n%3*CW,n//3*CH))
sheet.save('export/polices.png');sheet.resize((1320,747)).save(sys.argv[1])
