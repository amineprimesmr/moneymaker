from PIL import Image,ImageDraw,ImageFont
import numpy as np,json
F='/System/Library/Fonts/Supplemental/Impact.ttf';S=2;W=1320*S
def fit(t,target):
    s=20
    while ImageFont.truetype(F,s+2).getlength(t)<=target: s+=2
    return s
S1=fit('TRACK ET ANALYSE',620*S);S2=fit('TES VENTES',1100*S)
T={'mm_2':('TES VENTES',"SANS OUVRIR L'APP",2420),'mm_5':('ÉCRASE','LES AUTRES',420),'mm_3':('VOIS OÙ','ÇA PAIE',420),'mm_4':('LES CHIFFRES',"PAS D'EXCUSES",420),'mm_6':('TOUT','EN UN REGARD',420)}
p='app-store-screenshots.json';D=json.load(open(p))
for s in D['slidesByDevice'][D['device']]:
    if s['id'] not in T: continue
    a,b,y=T[s['id']];f1=ImageFont.truetype(F,int(S1*.85));f2=ImageFont.truetype(F,min(int(S2*.72),fit(b,1040*S)))
    H=440*S;m=Image.new('L',(W,H),0);d=ImageDraw.Draw(m)
    d.text((W/2,30*S+f1.getmetrics()[0]),a,font=f1,fill=255,anchor='ms')
    d.text((W/2,30*S+f1.getmetrics()[0]+14*S+f2.getbbox('H',anchor='ls')[3]-f2.getbbox('H',anchor='ls')[1]),b,font=f2,fill=255,anchor='ms')
    y0,y1=m.getbbox()[1],m.getbbox()[3]
    g=np.clip((np.arange(H)-y0)/(y1-y0),0,1)[:,None,None]
    c=(np.array([255,255,255])*(1-g)+np.array([176,182,194])*g)*np.ones((H,W,3))
    out=Image.fromarray(c.astype(np.uint8)).convert('RGBA');out.putalpha(m)
    src=f"/pops/title-{s['id']}.png";out.resize((1320,440),Image.LANCZOS).save('public'+src)
    s['headline']={'fr':''}
    els=[e for e in s.get('imageElements',[]) if e['id']!='title'];els.append({'id':'title','src':src,'transform':{'x':0,'y':y,'width':1320,'height':440,'rotation':0,'zIndex':7},'fit':'contain'})
    s['imageElements']=els
json.dump(D,open(p,'w'),ensure_ascii=False,indent=2)
