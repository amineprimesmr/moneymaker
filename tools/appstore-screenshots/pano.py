from PIL import Image,ImageFilter
import numpy as np,json,sys
W,H=1320,2868;HOR=int(sys.argv[1]) if len(sys.argv)>1 else 860
im=Image.open('public/bg/panorama-src.jpg').convert('RGB').transpose(Image.FLIP_LEFT_RIGHT);s=W*6/im.width
top=round(650*s)-HOR
big=im.resize((W*6,round(im.height*s)),Image.BICUBIC).filter(ImageFilter.UnsharpMask(6,70,2))
crop=big.crop((0,top,W*6,top+H))
a=np.asarray(crop,dtype=np.float32);BG=np.array([5,5,6],np.float32)
yy=np.arange(H,dtype=np.float32)[:,None,None]
f=np.clip((yy-1250)/700,0,1);f=f*f*(3-2*f)
v=np.clip(1-(yy-560)/360,0,1)*.78
f=np.maximum(f,v)
a=a*(1-f)+BG*f
a+=np.random.default_rng(1).normal(0,1.4,a.shape).astype(np.float32)
o=Image.fromarray(a.clip(0,255).astype(np.uint8));out=[]
for i in range(6):
    p=f'public/bg/baked/{i+1}.jpg';o.crop((i*W,0,(i+1)*W,H)).save(p,quality=94);out.append({'src':p[6:],'baked':True})
p='app-store-screenshots.json';D=json.load(open(p));D['scene']['photos']=out;json.dump(D,open(p,'w'),ensure_ascii=False,indent=2)
