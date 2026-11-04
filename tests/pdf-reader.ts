import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';

await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/reader-desktop-'));
const source = resolve('node_modules/@embedpdf/snippet/dist/demo.pdf');
const mainTitle='Offline PDF reader fixture';
const nativeTitle='Native annotations fixture with a very long paper title that must stay on one line inside a fixed width reading tab';
const extraTitles=Array.from({length:4},(_,i)=>`Reading tab fixture ${i+1} with a longer title`);
const library = new Library(join(directory, 'library'), async (_path,fileName) => ({ title: fileName==='native.pdf'?nativeTitle:fileName.startsWith('extra')?extraTitles[Number(fileName.match(/\d+/)![0])-1]:mainTitle, authors: [], year: 2025, doi: '', arxivId: '', abstract: '', firstPageText: 'fixture', pageCount: 5 }),
  async pdf => ({ metadata: localMetadata(pdf), matched: true, message: 'fixture' }));
await library.initialize();
// A tiny standards-compliant fixture with one annotation already embedded in the PDF.
const nativeSource=join(directory,'native.pdf');
const stream='BT /F1 16 Tf 72 700 Td (Original highlighted text) Tj 0 -40 Td (Add underline here) Tj ET';
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  '<< /Type /Annot /Subtype /Highlight /Rect [72 696 260 716] /QuadPoints [72 716 260 716 72 696 260 696] /C [1 1 0] /F 4 /NM (native-highlight) /Contents (Original note) /T (Fixture) >>'];
let raw='%PDF-1.7\n',offsets=[0];for(const [i,obj]of objects.entries()){offsets.push(Buffer.byteLength(raw));raw+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
const xref=Buffer.byteLength(raw);raw+=`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await writeFile(nativeSource,raw);const nativeImported=await library.importPaths([nativeSource]);await library.whenIdle();
const nativeId=nativeImported.paperIds![0],nativeOriginal=await readFile(library.pdfPath(nativeId));
for(let i=0;i<extraTitles.length;i++){const source=join(directory,`extra${i+1}.pdf`);await writeFile(source,raw+`\n% extra ${i+1}\n`);await library.importPaths([source]);await library.whenIdle();}
const imported = await library.importPaths([source]); await library.whenIdle();
const id = imported.paperIds![0], original = await readFile(library.pdfPath(id));
const env = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: directory, PAPER_TIMELINE_AI: '0' }).filter((x): x is [string, string] => typeof x[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.argv.includes('--packaged');
const launch=()=>electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'),
  ...(packaged ? {} : { args: [resolve('.')] }), env, timeout: 30000 });
let app = await launch(), page = await app.firstWindow();
await app.evaluate(({ session }) => {
  (globalThis as any).readerTestRequests = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => { (globalThis as any).readerTestRequests.push(details.url); callback({}); });
});
const errors: string[] = [], remote: string[] = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') console.log('reader console:', m.text()); });
page.on('request', r => { if (/^https?:/.test(r.url())) remote.push(r.url()); });
async function closeApp(){if(app.process().exitCode!==null)return;const exited=new Promise<void>(r=>app.process().once('exit',()=>r()));await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.close()));await exited;}
async function waitStored(check:(s:any)=>boolean){for(let i=0;i<100;i++){const s=JSON.parse(await readFile(join(library.paperDirectory(id),'annotations.json'),'utf8'));if(check(s))return s;await new Promise(r=>setTimeout(r,50));}throw new Error('Timed out waiting for reader save');}
try {
  await page.getByRole('button', { name: '打开文献库', exact: true }).click();
  await page.getByRole('button', { name: '打开 PDF', exact: true }).click();
  await page.getByRole('main', { name: 'PDF 阅读器' }).waitFor();
  await page.getByText('标注自动保存到文献库', { exact: true }).waitFor({ timeout: 30000 });
  console.log('Reader initialized offline.');
  const viewer=page.locator('embedpdf-container');
  // Zoom state updates before the SDK applies its new scroll position to the
  // rendered viewport. Measure only after both SDK and DOM metrics settle.
  async function settledViewport() {
    let previous = '', stable = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      const metrics = await viewer.evaluate(async (el: any) => {
        const registry = await el.registry;
        const viewport = registry.getPlugin('viewport').provides().getMetrics();
        const content = el.shadowRoot.querySelector('#document-content .bg-bg-app');
        return { zoom: registry.getPlugin('zoom').provides().getState().currentZoomLevel,
          top: viewport.scrollTop, left: viewport.scrollLeft, width: viewport.clientWidth, height: viewport.clientHeight,
          domTop: content.scrollTop, domLeft: content.scrollLeft, scrollHeight: content.scrollHeight, scrollWidth: content.scrollWidth };
      });
      const current = JSON.stringify(metrics);
      stable = current === previous ? stable + 1 : 0;
      if (stable >= 3) return metrics;
      previous = current;
      await page.waitForTimeout(50);
    }
    throw new Error(`Reader viewport did not settle: ${previous}`);
  }
  await viewer.getByRole('button',{name:'批注',exact:true}).click();
  await viewer.locator('img').first().waitFor();
  const box=await viewer.locator('img').first().boundingBox();assert(box);
  await viewer.getByRole('button',{name:'高亮',exact:true}).click();
  await page.mouse.move(box.x+85,box.y+85);await page.mouse.down();
  await page.mouse.move(box.x+345,box.y+105,{steps:20});await page.mouse.up();
  await page.getByText('已自动保存',{exact:true}).waitFor();
  const statePath=join(library.paperDirectory(id),'annotations.json');
  let saved=JSON.parse(await readFile(statePath,'utf8'));
  assert.equal(saved.annotations.length,1);assert.equal(saved.annotations[0].annotation.type,9);
  assert.equal(saved.annotations[0].annotation.segmentRects.length,2,'multi-line highlight has two segments');
  await viewer.getByRole('button',{name:'下划线',exact:true}).click();
  await page.waitForFunction(async()=>{const reg=await(document.querySelector('embedpdf-container') as any).registry;return reg.getPlugin('annotation').provides().getActiveTool()?.id==='underline';});
  const box2=await viewer.locator('img').first().boundingBox();assert(box2);
  await page.mouse.move(box2.x+125,box2.y+145);await page.mouse.down();
  await page.mouse.move(box2.x+380,box2.y+146,{steps:20});await page.mouse.up();
  for(let i=0;i<100;i++) {if(JSON.parse(await readFile(statePath,'utf8')).annotations.length===2)break;await new Promise(r=>setTimeout(r,50));}
  saved=JSON.parse(await readFile(statePath,'utf8'));
  assert.deepEqual(saved.annotations.map((a:any)=>a.annotation.type).sort((a:number,b:number)=>a-b),[9,10]);
  await viewer.getByRole('button',{name:'批注样式',exact:true}).last().click();
  await viewer.getByTitle('#A9D8FF',{exact:true}).click();
  await waitStored(s=>s.annotations.some((a:any)=>a.annotation.type===10&&a.annotation.strokeColor==='#A9D8FF'));
  await viewer.getByRole('button',{name:'删除选中的批注',exact:true}).click();
  await waitStored(s=>s.annotations.length===1);
  await viewer.getByRole('button',{name:'撤销',exact:true}).click();
  await waitStored(s=>s.annotations.length===2);
  await viewer.getByRole('button',{name:'放大',exact:true}).click();
  const pageInput=viewer.locator('#document-content input[inputmode="numeric"]');await pageInput.fill('3');await pageInput.press('Enter');
  saved=await waitStored(s=>s.position.page===3&&s.position.zoom>1);
  // Exercise actual Ctrl+wheel input. The SDK's original 120-pixel event shrank
  // the PDF almost to its minimum, whereas both directions now move by 5 points.
  const wheelBox=await viewer.locator('#document-content .bg-bg-app').boundingBox();assert(wheelBox);
  const focus={x:wheelBox.x+wheelBox.width*0.5,y:wheelBox.y+wheelBox.height*0.5};
  await page.mouse.move(focus.x,focus.y);
  const zoomBefore=await settledViewport();
  await page.keyboard.down('Control');
  try {
    let target=zoomBefore.zoom;
    for(const delta of [120,120,-120,-120,1200,-1200]){
      target=Math.round((target+(delta>0?-0.05:0.05))*1000)/1000;
      await page.mouse.wheel(0,delta);
      await page.waitForFunction(async(expected)=>{const r=await(document.querySelector('embedpdf-container') as any).registry;return Math.abs(r.getPlugin('zoom').provides().getState().currentZoomLevel-expected)<0.0011;},target);
      await settledViewport();
    }
  } finally {await page.keyboard.up('Control');}
  const zoomAfter=await settledViewport();
  assert(Math.abs(zoomBefore.zoom-zoomAfter.zoom)<0.0011);
  assert(Math.abs(zoomBefore.top-zoomAfter.top)<12,`reversing wheel zoom keeps the reading point within a text line despite SDK pixel rounding: ${JSON.stringify({ before: zoomBefore, after: zoomAfter })}`);
  const appZoom=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());assert.equal(appZoom,1,'Ctrl+wheel changes PDF zoom, not the application zoom');
  await page.mouse.wheel(0,120);
  await page.waitForFunction(async(top)=>{const r=await(document.querySelector('embedpdf-container') as any).registry;return r.getPlugin('viewport').provides().getMetrics().scrollTop>top+20;},zoomAfter.top);
  assert(Math.abs(await viewer.evaluate(async(el:any)=>(await el.registry).getPlugin('zoom').provides().getState().currentZoomLevel)-zoomBefore.zoom)<0.0011,'normal wheel still scrolls without zooming');
  await viewer.getByRole('button',{name:'放大',exact:true}).click();
  await page.waitForFunction(async(expected)=>{const r=await(document.querySelector('embedpdf-container') as any).registry;return Math.abs(r.getPlugin('zoom').provides().getState().currentZoomLevel-expected)<0.0011;},zoomBefore.zoom+0.05);
  await viewer.getByRole('button',{name:'缩小',exact:true}).click();
  await page.waitForFunction(async(expected)=>{const r=await(document.querySelector('embedpdf-container') as any).registry;return Math.abs(r.getPlugin('zoom').provides().getState().currentZoomLevel-expected)<0.0011;},zoomBefore.zoom);
  saved=await waitStored(s=>s.position.page===3&&Math.abs(s.position.zoom-zoomBefore.zoom)<0.0011);
  console.log(`PASS: gentle symmetric Ctrl+wheel zoom, bounded large deltas, consistent toolbar steps, preserved reading point and ordinary scrolling (${JSON.stringify({ before: zoomBefore, after: zoomAfter })}).`);
  await page.screenshot({path:resolve('test-results/pdf-reader-styles.png')});
  await page.getByRole('button',{name:'文献库',exact:true}).click();
  await page.getByRole('tab',{name:mainTitle,exact:true}).click();
  await page.getByText('标注自动保存到文献库',{exact:true}).waitFor({timeout:30000});
  const restored=await viewer.evaluate(async(el:any)=>{
    const reg=await el.registry;
    return reg.getPlugin('annotation').provides().getAnnotations().map((a:any)=>a.object);
  });
  assert.deepEqual(restored.map((a:any)=>a.type).sort((a:number,b:number)=>a-b),[9,10]);
  assert(restored.some((a:any)=>a.type===10&&a.strokeColor==='#A9D8FF'));
  const position=await viewer.evaluate(async(el:any)=>{const r=await el.registry;return{page:r.getPlugin('scroll').provides().getCurrentPage(),zoom:r.getPlugin('zoom').provides().getState().currentZoomLevel};});
  assert.deepEqual(position,saved.position);
  console.log('PASS: mouse multi-line highlight/underline, automatic save and reopen.');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: resolve('test-results/pdf-reader.png') });
  await writeFile(join(directory, 'reader-dom.txt'), await page.locator('body').innerText());
  assert.deepEqual(await readFile(library.pdfPath(id)), original);
  // Close immediately after another UI change, before the debounce expires.
  await viewer.getByRole('button',{name:'放大',exact:true}).click();
  await closeApp();
  const closed=JSON.parse(await readFile(statePath,'utf8'));assert(closed.position.zoom>position.zoom);
  app=await launch();page=await app.firstWindow();
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))remote.push(r.url());});
  await page.getByRole('button',{name:'打开文献库',exact:true}).click();
  await page.getByRole('button',{name:'打开 PDF',exact:true}).click();
  await page.getByText('标注自动保存到文献库',{exact:true}).waitFor({timeout:30000});
  const restart=await page.locator('embedpdf-container').evaluate(async(el:any)=>{const r=await el.registry;return{count:r.getPlugin('annotation').provides().getAnnotations().length,page:r.getPlugin('scroll').provides().getCurrentPage(),zoom:r.getPlugin('zoom').provides().getState().currentZoomLevel};});
  assert.deepEqual(restart,{count:2,...closed.position});
  assert.deepEqual(remote,[]);assert.deepEqual(errors,[]);assert.deepEqual(await readFile(library.pdfPath(id)),original);
  console.log('PASS: colors, delete/undo, zoom/page, close flush, restart and unchanged source PDF.');
  await page.getByRole('button',{name:'文献库',exact:true}).click();
  await page.getByRole('textbox',{name:'搜索文献',exact:true}).fill('Native annotations fixture');
  await page.getByText(nativeTitle,{exact:true}).first().click();
  await page.getByRole('button',{name:'打开 PDF',exact:true}).click();
  await page.getByText('标注自动保存到文献库',{exact:true}).waitFor({timeout:30000});
  const nativeViewer=page.locator('embedpdf-container');
  assert.equal(await page.getByRole('tab').count(),2,'a second PDF adds a tab');
  const widths=await page.locator('.reader-tab').evaluateAll(els=>els.map(e=>e.getBoundingClientRect().width));
  assert.deepEqual(widths,[200,200]);
  assert(await page.getByRole('tab',{name:nativeTitle,exact:true}).locator('.reader-tab-title').evaluate(el=>el.scrollWidth>el.clientWidth),'long paper title is truncated');
  await page.getByRole('tab',{name:mainTitle,exact:true}).click();
  await page.getByText('标注自动保存到文献库',{exact:true}).waitFor({timeout:30000});
  const originalTab=await nativeViewer.evaluate(async(el:any)=>{const r=await el.registry;return{count:r.getPlugin('annotation').provides().getAnnotations().length,page:r.getPlugin('scroll').provides().getCurrentPage(),zoom:r.getPlugin('zoom').provides().getState().currentZoomLevel};});
  assert.deepEqual(originalTab,{count:2,...closed.position},'opening another paper preserves the first tab');
  await page.getByRole('tab',{name:nativeTitle,exact:true}).click();
  await page.getByText('标注自动保存到文献库',{exact:true}).waitFor({timeout:30000});
  const nativeMarks=await nativeViewer.evaluate(async(el:any)=>{const r=await el.registry;return r.getPlugin('annotation').provides().getAnnotations().map((a:any)=>a.object);});
  assert.equal(nativeMarks.length,1);assert.equal(nativeMarks[0].type,9);
  await nativeViewer.getByRole('button',{name:'批注',exact:true}).click();
  await nativeViewer.getByRole('button',{name:'下划线',exact:true}).click();
  await nativeViewer.locator('img').first().waitFor();
  const nb=await nativeViewer.locator('img').first().boundingBox();assert(nb);
  await page.mouse.move(nb.x+80,nb.y+128);await page.mouse.down();await page.mouse.move(nb.x+200,nb.y+128,{steps:15});await page.mouse.up();
  await page.getByText('已自动保存',{exact:true}).waitFor();
  await page.getByRole('button',{name:'文献库',exact:true}).click();await page.getByRole('tab',{name:nativeTitle,exact:true}).click();
  await page.getByText('标注自动保存到文献库',{exact:true}).waitFor({timeout:30000});
  const nativeRestored=await nativeViewer.evaluate(async(el:any)=>{const r=await el.registry;return r.getPlugin('annotation').provides().getAnnotations().map((a:any)=>a.object);});
  assert.deepEqual(nativeRestored.map((a:any)=>a.type).sort((a:number,b:number)=>a-b),[9,10]);
  assert.equal(nativeRestored.find((a:any)=>a.type===9).contents,'Original note');
  assert.deepEqual(await readFile(library.pdfPath(nativeId)),nativeOriginal);
  console.log('PASS: pre-existing native highlight/comment survive edits and snapshot restoration.');
  const target=join(directory,'copied-library');await mkdir(target);
  await app.evaluate(({dialog,app},target)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[target]});app.relaunch=()=>{};},target);
  await page.getByRole('button',{name:'文献库设置',exact:true}).click();
  await page.getByRole('button',{name:/^复制当前文献库到新位置/}).click();
  const copyExit=new Promise<void>(r=>app.process().once('exit',()=>r()));
  const copyWindowClosed=page.waitForEvent('close',{timeout:10000});
  await page.getByRole('button',{name:'应用并重启',exact:true}).click();
  await copyWindowClosed;
  console.log('Copy window closed automatically.');
  // Detach Playwright's Node inspector after the app's automatic window close.
  await app.close();
  await copyExit;
  assert.deepEqual(await readFile(join(target,'papers',library.get(id).storageFolder!,'annotations.json')),await readFile(statePath));
  assert.deepEqual(await readFile(join(target,'papers',library.get(nativeId).storageFolder!,'annotations.json')),await readFile(join(library.paperDirectory(nativeId),'annotations.json')));
  app=await launch();page=await app.firstWindow();
  await page.getByRole('button',{name:'打开文献库',exact:true}).click();
  assert.equal((await page.evaluate(()=>window.paperApi!.getLibrary())).storagePath,target);
  await page.getByRole('textbox',{name:'搜索文献',exact:true}).fill('Native annotations fixture');
  await page.getByText(nativeTitle,{exact:true}).first().click();
  await page.getByRole('button',{name:'打开 PDF',exact:true}).click();
  await page.getByText('标注自动保存到文献库',{exact:true}).waitFor({timeout:30000});
  assert.equal(await page.locator('embedpdf-container').evaluate(async(el:any)=>(await el.registry).getPlugin('annotation').provides().getAnnotations().length),2);
  assert.deepEqual(await readFile(join(target,'papers',library.get(nativeId).storageFolder!,'original.pdf')),nativeOriginal);
  console.log('PASS: copy from active reader, automatic restart, portable annotations and PDF preserved.');
  // Reopen the first document from the library, then switch and close tabs independently.
  await page.getByRole('button',{name:'文献库',exact:true}).click();
  await page.getByRole('textbox',{name:'搜索文献',exact:true}).fill(mainTitle);
  await page.getByRole('button',{name:'打开 PDF：demo.pdf',exact:true}).click();
  await page.getByText('标注自动保存到文献库',{exact:true}).waitFor({timeout:30000});
  assert.equal(await page.getByRole('tab').count(),2);
  await page.getByRole('button',{name:'文献库',exact:true}).click();
  await page.getByRole('button',{name:'打开 PDF：demo.pdf',exact:true}).click();
  await page.getByText('标注自动保存到文献库',{exact:true}).waitFor({timeout:30000});
  assert.equal(await page.getByRole('tab').count(),2,'opening the same PDF reuses its tab');
  await page.getByRole('tab',{name:mainTitle,exact:true}).focus();await page.keyboard.press('ArrowLeft');
  await page.getByText('标注自动保存到文献库',{exact:true}).waitFor({timeout:30000});
  assert.equal(await page.getByRole('tab',{name:nativeTitle,exact:true}).getAttribute('aria-selected'),'true');
  await page.getByRole('button',{name:`关闭 PDF：${mainTitle}`,exact:true}).click();
  assert.equal(await page.getByRole('tab').count(),1);
  assert.equal(await page.getByRole('tab',{name:nativeTitle,exact:true}).getAttribute('aria-selected'),'true','closing background tab keeps active PDF');
  await page.getByRole('button',{name:'文献库',exact:true}).click();
  await page.getByRole('textbox',{name:'搜索文献',exact:true}).fill(mainTitle);
  await page.getByRole('button',{name:'打开 PDF：demo.pdf',exact:true}).click();
  await page.getByText('标注自动保存到文献库',{exact:true}).waitFor({timeout:30000});
  await page.getByRole('button',{name:`关闭 PDF：${mainTitle}`,exact:true}).click();
  await page.getByText('标注自动保存到文献库',{exact:true}).waitFor({timeout:30000});
  assert.equal(await page.getByRole('tab',{name:nativeTitle,exact:true}).getAttribute('aria-selected'),'true','closing active tab activates its neighbor');
  await page.getByRole('tab',{name:nativeTitle,exact:true}).focus();await page.keyboard.press('Delete');
  assert.equal(await page.getByRole('tablist',{name:'PDF 阅读标签'}).count(),0);
  await page.getByRole('textbox',{name:'搜索文献',exact:true}).waitFor();
  await page.getByRole('textbox',{name:'搜索文献',exact:true}).fill(mainTitle);
  await page.getByRole('button',{name:'打开 PDF：demo.pdf',exact:true}).click();
  await page.getByText('标注自动保存到文献库',{exact:true}).waitFor({timeout:30000});
  // A failed write must keep the current tab open and allow a retry.
  await app.evaluate(({ipcMain})=>{(globalThis as any).readerSaveHandler=(ipcMain as any)._invokeHandlers.get('reader:save');ipcMain.removeHandler('reader:save');ipcMain.handle('reader:save',()=>{throw new Error('simulated reader save failure');});});
  try {
    await page.locator('embedpdf-container').getByRole('button',{name:'放大',exact:true}).click();
    await page.getByRole('button',{name:`关闭 PDF：${mainTitle}`,exact:true}).click();
    await page.locator('.reader-error').filter({hasText:'simulated reader save failure'}).waitFor();
    assert.equal(await page.getByRole('tab',{name:mainTitle,exact:true}).getAttribute('aria-selected'),'true');
  } finally {await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('reader:save');ipcMain.handle('reader:save',(globalThis as any).readerSaveHandler);});}
  await page.getByRole('button',{name:'重试保存',exact:true}).click();await page.locator('.reader-error').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'关闭通知',exact:true}).click();
  for(const title of extraTitles){await page.getByRole('button',{name:'文献库',exact:true}).click();await page.getByRole('textbox',{name:'搜索文献',exact:true}).fill(title);await page.getByRole('button',{name:'打开 PDF',exact:true}).click();await page.getByText('标注自动保存到文献库',{exact:true}).waitFor({timeout:30000});}
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1050,800));
  await page.waitForFunction(()=>{const list=document.querySelector('.reader-tabs')!;return list.scrollWidth>list.clientWidth&&list.scrollLeft>0;});
  assert((await page.locator('.reader-tab').evaluateAll(els=>els.map(e=>e.getBoundingClientRect().width))).every(w=>w===200));
  assert.equal(await page.locator('embedpdf-container').count(),1,'only the active PDF engine is mounted');
  await page.screenshot({path:resolve('test-results/pdf-reader-tabs.png')});
  await page.getByRole('tab',{name:extraTitles.at(-1)!,exact:true}).focus();await page.keyboard.press('Home');
  await page.getByText('标注自动保存到文献库',{exact:true}).waitFor({timeout:30000});
  assert.equal(await page.getByRole('tab',{name:mainTitle,exact:true}).getAttribute('aria-selected'),'true');
  const final=await page.locator('embedpdf-container').evaluate(async(el:any)=>{const r=await el.registry;return{count:r.getPlugin('annotation').provides().getAnnotations().length,page:r.getPlugin('scroll').provides().getCurrentPage()};});
  assert.deepEqual(final,{count:2,page:3});
  console.log('PASS: multiple named fixed-width tabs, duplicate reuse, independent reading state, close/keyboard controls, save-failure recovery and horizontal overflow.');
} catch (e) {
  await page.screenshot({path:resolve('test-results/pdf-reader-failure.png')});
  console.log('Errors:', errors);
  console.log('Engine requests:', await app.evaluate(() => (globalThis as any).readerTestRequests));
  console.log('Requests:', remote);
  console.log(await page.locator('body').innerText());
  throw e;
} finally {
  await closeApp();
}
