from PIL import Image,ImageDraw,ImageFont,ImageFilter
import json
S=2;W,H=1320*S,740*S
F='/System/Library/Fonts/Supplemental/Impact.ttf'
def fit(txt,target):
    s=20
    while ImageFont.truetype(F,s+2).getlength(txt)<=target: s+=2
    return ImageFont.truetype(F,s)
tw,th=W,420*S;m=Image.new('L',(tw,th),0);d=ImageDraw.Draw(m)
f1=fit('TRACK ET ANALYSE',620*S);f2=fit('TES VENTES',1100*S)
h=f1.getbbox('TRACK ET ANALYSE')[3]
d.text(((tw-f1.getlength('TRACK ET ANALYSE'))/2,0),'TRACK ET ANALYSE',font=f1,fill=255)
d.text(((tw-f2.getlength('TES VENTES'))/2,h+6*S),'TES VENTES',font=f2,fill=255)
y0=m.getbbox()[1];y1=m.getbbox()[3]
base=380*S  # sol, dans le PNG
out=Image.new('RGBA',(W,H),(0,0,0,0))
# ombre au sol : texte retourné, couché, élargi vers le spectateur
import numpy as np
fl=m.crop((0,max(0,y0-20*S),tw,y1+20*S))
sy=480*S;sh_h=185*S
fw,fh=fl.size;ins=fw*.24;sk=fw*.09
q=fl.transform((W,sh_h),Image.QUAD,(-ins-sk,0,0,fh,fw,fh,fw+ins-sk,0),Image.BICUBIC).filter(ImageFilter.GaussianBlur(8*S))
al=np.asarray(q,dtype=np.float32)*.42
sh=Image.fromarray(al.astype(np.uint8))
out.paste(Image.new('RGBA',(W,sh_h),(0,0,0,255)),(0,sy),sh)
# extrusion puis face
top=base-(y1-y0)-8*S
txt=m.crop((0,y0,tw,y1))
for k in []:
    v=int(38+ (22-k)*3);layer=Image.new('RGBA',txt.size,(v,v,v+4,255))
    out.paste(layer,(k*S//2,top+k*S//1),txt)
g=np.linspace(0,1,txt.size[1])[:,None,None]
grad=(np.array([255,255,255])*(1-g)+np.array([176,182,194])*g)*np.ones((txt.size[1],txt.size[0],3))
out.paste(Image.fromarray(grad.astype(np.uint8)).convert('RGBA'),(0,top),txt)
out=out.resize((1320,740),Image.LANCZOS);out.save('public/pops/title3d.png')
p='app-store-screenshots.json';D=json.load(open(p));s=D['slidesByDevice'][D['device']][0]
s['headline']={'fr':''}
els=[e for e in s['imageElements'] if e['id']!='title3d']
Y=870-380
els.append({'id':'title3d','src':'/pops/title3d.png','transform':{'x':0,'y':Y,'width':1320,'height':740,'rotation':0,'zIndex':2},'fit':'contain'})
s['imageElements']=els
json.dump(D,open(p,'w'),ensure_ascii=False,indent=2)
