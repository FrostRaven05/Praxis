import { chromium, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const adbPath=path.join(process.env.LOCALAPPDATA,'Android','Sdk','platform-tools','adb.exe');
const adb=(...args)=>execFileSync(adbPath,['-s','emulator-5554',...args],{encoding:'utf8'}).trim();
const base=new URL('../docs/evidence/mobile/',import.meta.url);
const smoke=JSON.parse(await readFile(new URL('smoke.json',base),'utf8'));
let browser=await chromium.connectOverCDP('http://127.0.0.1:9223');
let page=browser.contexts()[0].pages()[0];
let dismiss=false;
const dialogs=dialog=>dismiss?dialog.dismiss():dialog.accept();
page.on('dialog',dialogs);
const route=async(name)=>{await page.getByRole('button',{name:'打开菜单',exact:true}).click();await page.getByRole('navigation',{name:'功能菜单'}).getByRole('button',{name,exact:true}).click();};
const checks=[];
try {
 await page.reload();
 await expect(page.getByRole('heading',{name:'任务清单',exact:true})).toBeVisible();
 await route('我的');
 await page.getByLabel('切换工作空间').selectOption('local');
 await expect(page.locator('.mobile-extras fieldset')).toBeEnabled();
 await route('任务清单');
 await page.getByRole('button',{name:`撤销完成：${smoke.task}`,exact:true}).click();
 await expect(page.getByRole('button',{name:`完成：${smoke.task}`,exact:true})).toBeVisible();
 await page.evaluate(()=>{
   const cap=window.Capacitor,original=cap.nativePromise;
   cap.nativePromise=async function(plugin,method,options){
     const result=await original.call(this,plugin,method,options);
     if(plugin==='CapacitorSQLite'&&method==='commitTransaction'){
       cap.nativePromise=original;
       throw new Error('验收注入：提交成功但响应丢失');
     }
     return result;
   };
 });
 await page.getByRole('button',{name:`完成：${smoke.task}`,exact:true}).click();
 await expect(page.getByRole('button',{name:'重试原操作',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'重试原操作',exact:true}).click();
 await expect(page.getByRole('button',{name:`撤销完成：${smoke.task}`,exact:true})).toBeVisible();
 checks.push('unknown commit response replays frozen operation');
 await page.getByRole('button',{name:'新建任务',exact:true}).click();
 await page.getByRole('dialog').getByLabel('名称',{exact:true}).fill('返回键保留草稿');
 dismiss=true;adb('shell','input','keyevent','4');
 await expect(page.getByRole('dialog').getByLabel('名称',{exact:true})).toHaveValue('返回键保留草稿');
 dismiss=false;await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
 checks.push('Android back cancellation preserves draft');
 await route('我的');
 await page.getByRole('button',{name:'生成完整本机 JSON',exact:true}).click();
 await expect(page.locator('.mx-json')).toHaveValue(/praxis-mobile-workspace/);
 const before=JSON.parse(await page.locator('.mx-json').inputValue());
 await page.getByRole('button',{name:'预览恢复',exact:true}).click();
 await page.getByLabel('确认恢复到新工作空间，保留当前数据',{exact:true}).check();
 await page.getByRole('button',{name:'恢复到新工作空间',exact:true}).click();
 await expect(page.getByText('恢复完成',{exact:true})).toBeVisible();
 const select=page.getByLabel('切换工作空间');
 await expect(select).not.toHaveValue('local');
 await page.getByRole('button',{name:'生成完整本机 JSON',exact:true}).click();
 await expect.poll(async()=>JSON.parse(await page.locator('.mx-json').inputValue()).workspace.id).not.toBe('local');
 const restored=JSON.parse(await page.locator('.mx-json').inputValue());
 if(restored.entities.length!==before.entities.length)throw new Error('Restore entity count mismatch');
 await select.selectOption('local');
 await expect(select).toHaveValue('local');
 checks.push('export/import creates isolated workspace and original remains selectable');
 await page.getByRole('button',{name:'生成完整本机 JSON',exact:true}).click();
 await expect.poll(async()=>JSON.parse(await page.locator('.mx-json').inputValue()).workspace.id).toBe('local');
 await page.getByRole('button',{name:'保存或分享 JSON',exact:true}).click();
 await expect.poll(()=>{try{return adb('shell','run-as','com.praxis.mobile','ls','cache/exports');}catch{return '';}}).toContain('.json');
 adb('shell','input','keyevent','4');
 checks.push('native JSON file written and Android chooser opened (no external send)');
 await page.reload();
 await expect(page.getByRole('heading',{name:'任务清单',exact:true})).toBeVisible();
 const wifi=adb('shell','settings','get','global','wifi_on');
 const data=adb('shell','settings','get','global','mobile_data');
 try {
  adb('shell','svc','wifi','disable');adb('shell','svc','data','disable');
  await browser.close();
  adb('shell','am','force-stop','com.praxis.mobile');adb('shell','am','start','-n','com.praxis.mobile/.MainActivity');
  await new Promise(r=>setTimeout(r,1500));
  const pid=adb('shell','pidof','com.praxis.mobile');adb('forward','tcp:9223',`localabstract:webview_devtools_remote_${pid}`);
  browser=await chromium.connectOverCDP('http://127.0.0.1:9223');page=browser.contexts()[0].pages()[0];
  await expect(page.getByRole('button',{name:`撤销完成：${smoke.task}`,exact:true})).toBeVisible();
  checks.push('offline force-stop/relaunch preserves tasks');
 }finally{if(wifi==='1')adb('shell','svc','wifi','enable');if(data==='1')adb('shell','svc','data','enable');}
 await page.emulateMedia({colorScheme:'dark'});
 await page.screenshot({path:new URL('tasks-dark.png',base).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});
 await page.emulateMedia({colorScheme:'light'});
 await writeFile(new URL('recovery.json',base),JSON.stringify({checks,restoredEntities:restored.entities.length},null,2));
 console.log('PASS',checks);
}catch(error){console.error((await page.locator('body').innerText()).slice(-2500));throw error;}finally{await browser.close();}
