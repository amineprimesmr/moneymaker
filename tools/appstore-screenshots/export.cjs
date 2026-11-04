const {chromium}=require(process.cwd()+"/node_modules/playwright");
(async()=>{const b=await chromium.launch({channel:"chrome"});const c=await b.newContext({acceptDownloads:true,viewport:{width:1600,height:1000}});const p=await c.newPage();
await p.goto("http://localhost:3210",{waitUntil:"networkidle"});await p.waitForTimeout(4000);
const [d]=await Promise.all([p.waitForEvent("download",{timeout:240000}),p.getByText("Export bundle",{exact:false}).first().click()]);
await d.saveAs("export/iphone.zip");console.log("saved");await b.close();})().catch(e=>{console.error(e.message);process.exit(1)});
