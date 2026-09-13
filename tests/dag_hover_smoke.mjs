import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const source = await readFile(root + '/static/dag_builder.js','utf8');
const fixture = JSON.parse(await readFile(root + '/tests/acceptance/artifacts/playwright-2026-08-31/project-fixture.json','utf8'));
const browser = await chromium.launch();
try {
 const page = await browser.newPage({viewport:{width:1964,height:1050}});
 const errors=[]; page.on('pageerror', e=>errors.push(e.message));
 await page.route('**/dag_builder.js*', route => route.fulfill({contentType:'text/javascript',body:source+'\nwindow.hoverTest={ highlightConfounderPaths, clearConfounderPathHover, minimumDagScale, zoomMap, network:()=>dagNetworkController.getNetwork(), lanes:()=>dagNetworkController.getPathLaneSegments() };'}));
 await page.goto(`${process.env.DAG_VIEWER_URL || 'http://127.0.0.1:8767'}/`);
 await page.waitForFunction(()=>window.__dagBuilderState?.variables.length>3000);
 await page.evaluate(fixture=>{
 const s=window.__dagBuilderState;
 const sig=[s.data.generated_at,s.projectStorageVariableCount??s.variables.length,s.data.default_grouping_set_id||'none'].join(':');
 localStorage.setItem('dag-builder-project-v2:'+sig,JSON.stringify({...fixture,dv_group_id:s.project.groups.find(g=>g.label==='vote').group_id,selectedUoa:'__person__',uoaFilterEnabled:true,phase:'build',workflowMode:'dag_review'}));
 },fixture);
 await page.reload();
 await page.waitForFunction(()=>window.__dagBuilderState?.visibleLinks.length>400);
 await page.locator('#toggleConfoundersOnly').click();
 await page.locator('#confounderPathLength').fill('4');
 await page.locator('#confounderPathLength').dispatchEvent('change');
 await page.locator('#fullscreenDag').click();
 await page.waitForTimeout(600);
 const groups=await page.evaluate(()=>{
 const s=window.__dagBuilderState;
 return s.project.groups.filter(g=>s.confounderGroupIds.has(g.group_id)).map(g=>({id:g.group_id,label:g.label}));
 });
 console.log('candidates',groups.length);
 for (const [index,term] of ['empirical political','motivation','political ideology'].entries()) {
 const group=groups.find(g=>g.label.includes(term)); assert.ok(group,term);
 await page.evaluate(id=>{ const t=window.hoverTest;t.network().fit({animation:false});t.highlightConfounderPaths(id);t.network().redraw(); },group.id);
 await page.waitForTimeout(200);
 await page.screenshot({path:join(tmpdir(), `dag-hover-${index}.png`)});
 console.log('checked',term,await page.evaluate(()=>window.hoverTest.lanes().length));
 }
 await page.evaluate(()=>window.hoverTest.clearConfounderPathHover());
 for(let i=0;i<30;i++) await page.locator('#dagSvgZoomOut').click();
 let scales=await page.evaluate(()=>({scale:window.hoverTest.network().getScale(),min:window.hoverTest.minimumDagScale()}));
 assert.ok(Math.abs(scales.scale-scales.min)<1e-6,JSON.stringify(scales));
 const box=await page.locator('#dagNetwork').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,2000);await page.waitForTimeout(200);
 scales=await page.evaluate(()=>({scale:window.hoverTest.network().getScale(),min:window.hoverTest.minimumDagScale()}));
 assert.ok(scales.scale>=scales.min-1e-6);
 assert.deepEqual(errors,[]);
 console.log('Button/wheel zoom floors passed; no browser errors.');
} finally {await browser.close();}
