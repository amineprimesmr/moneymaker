from PIL import Image
import glob
fs=sorted(glob.glob('export/ios/iphone/1320x2868/fr/*.png'));h=700;w=int(h*1320/2868);o=Image.new('RGB',(len(fs)*(w+10),h),'black')
for i,f in enumerate(fs):o.paste(Image.open(f).convert('RGB').resize((w,h)),(i*(w+10),0))
o.save('export/apercu.png')
