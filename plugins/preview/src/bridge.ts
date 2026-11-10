import { MAX_TWEAK_CONTROLS, MAX_TWEAK_GROUPS, TWEAK_SET_MESSAGE, TWEAKS_MESSAGE } from "./tweaks.ts";
import { MAX_STATE } from "./types.ts";

/** 与回复内自适应高度共用测量，避免把视口自身误当内容高度。 */
export const MEASURE_HEIGHT = `function(){
var b=document.body,d=document.documentElement;if(!b||!d)return 0;
var scroll=Math.max(b.scrollHeight,d.scrollHeight);if(scroll>d.clientHeight+2)return scroll;
var box=b.getBoundingClientRect();var own=Math.ceil(Math.max(box.bottom+(parseFloat(getComputedStyle(b).marginBottom)||0),box.top+b.scrollHeight));
if(box.height>0&&own<d.clientHeight)return own;
var keep=[[b,b.style.height,b.style.minHeight],[d,d.style.height,d.style.minHeight]];
b.style.height="auto";b.style.minHeight="0";d.style.height="auto";d.style.minHeight="0";
var natural=Math.max(b.scrollHeight,b.offsetHeight);
for(var i=0;i<keep.length;i++){keep[i][0].style.height=keep[i][1];keep[i][0].style.minHeight=keep[i][2];}return natural;
}`;

/*
 * 应用不在前台时把页面停在当前这一帧。
 *
 * 窗口关了后台节流（主窗口的 backgroundThrottling），被别的应用挡住甚至藏起来时，页面照样按满帧率画：一张 WebGL、
 * canvas 循环的页面让 GPU 进程常驻三分之一个核。滚出视野时 Chromium 自己会停，被挡住时不会。攒住而不是丢掉：
 * 这期间要的 rAF 回调在回来后的第一帧一起跑，循环接着原来的地方走，卡片里留着最后一帧而不是一片空白；CSS 和
 * Web Animations 一起暂停。什么时候停由卡片说（`preview: "pause"`，按 `document.hasFocus()` 判）；焦点从页面里
 * 直接离开应用时外面的窗口收不到事件，由页面自己的 blur 接住。
 */
const HOLD_FRAMES = `if(parent!==window&&window.requestAnimationFrame){
var raf=window.requestAnimationFrame.bind(window),caf=window.cancelAnimationFrame.bind(window),held=null,moved={},seq=0,stilled=[];
window.requestAnimationFrame=function(f){if(!held)return raf(f);var id=-(++seq);held[id]=f;return id};
window.cancelAnimationFrame=function(id){if(held&&id in held)delete held[id];else caf(id in moved?moved[id]:id)};
function still(on){
if(on){if(held)return;held={};stilled=document.getAnimations?document.getAnimations().filter(function(a){return a.playState==="running"}):[];stilled.forEach(function(a){a.pause()});return}
if(!held)return;var q=held;held=null;moved={};for(var id in q)moved[id]=raf(q[id]);stilled.forEach(function(a){try{a.play()}catch(x){}});stilled=[];
}
addEventListener("blur",function(){still(true)});addEventListener("focus",function(){still(false)});
addEventListener("message",function(e){if(e.source===parent&&e.data&&e.data.preview==="pause"&&typeof e.data.value==="boolean")still(e.data.value)});
}`;

export function withBridge(html: string): string {
	const bridge = `<style id="plume-preview-theme"></style><style>html.plume-preview-inline,html.plume-preview-inline body{overflow:hidden!important}html{scrollbar-width:none}</style><script>(function(){
var params=new URLSearchParams(location.hash.slice(1)),saved=null,theme=null;
try{saved=JSON.parse(params.get("state")||"null");theme=JSON.parse(params.get("theme")||"null")}catch(e){}
if(params.has("inline"))document.documentElement.classList.add("plume-preview-inline");
function post(data){if(parent!==window)parent.postMessage(data,"*")}
function wear(t){
 if(!t||!t.vars)return;
 var style=document.getElementById("plume-preview-theme"),vars=":root{color-scheme:"+(t.scheme==="dark"?"dark":"light")+";";
 for(var k in t.vars)if(/^--[a-z0-9-]+$/.test(k))vars+=k+":"+String(t.vars[k]).replace(/[;{}<>]/g,"")+";";
 style.textContent=vars+"}html{color:var(--foreground);font-family:var(--font-sans);font-size:var(--font-size);line-height:1.5}html:not(.plume-preview-inline){background:var(--background)}body{margin:0}code,pre{font-family:var(--font-mono)}";
}
wear(theme);if(parent===window&&theme)document.documentElement.style.background="var(--background)";
var gestureEvent=null,lastSend=0;
function gesture(e){if(e.isTrusted)gestureEvent=e}
addEventListener("click",gesture,true);addEventListener("submit",gesture,true);
window.plume={send:function(t){if(!params.has("inline")||!gestureEvent||!gestureEvent.eventPhase||Date.now()-lastSend<1500||typeof t!=="string"||!t.trim()||t.trim().length>2000)return false;lastSend=Date.now();post({preview:"send",text:t.trim()});return true},state:saved,setState:function(value){
 var json;try{json=JSON.stringify(value===undefined?null:value)}catch(e){return false}
 if(typeof json!=="string"||new TextEncoder().encode(json).length>${MAX_STATE})return false;
 window.plume.state=JSON.parse(json);post({preview:"state",value:window.plume.state});return parent!==window;
}};
var groups=[],queued=false;
function postTweaks(){queued=false;try{parent.postMessage({${JSON.stringify(TWEAKS_MESSAGE)}:groups.map(function(g){return{label:g.label,controls:g.controls.map(function(c){var o=c.opts;return{id:c.id,kind:c.kind,label:c.label,value:c.obj[c.key],min:o.min,max:o.max,step:o.step,unit:o.unit,options:o.options}})}})},"*")}catch(e){}}
window.plume.tweak=function(o){o=o||{};var g={label:String(o.label||""),onChange:typeof o.onChange==="function"?o.onChange:null,controls:[]},api={};
if(groups.length<${MAX_TWEAK_GROUPS})groups.push(g);
function add(kind){return function(obj,key,opts){opts=opts&&typeof opts==="object"?opts:{};if(obj&&typeof obj==="object"&&groups.indexOf(g)>=0&&g.controls.length<${MAX_TWEAK_CONTROLS}){g.controls.push({id:groups.indexOf(g)+"."+g.controls.length,kind:kind,obj:obj,key:String(key),label:String(opts.label||key),opts:opts});if(!queued&&parent!==window){queued=true;Promise.resolve().then(postTweaks)}}return api}}
api.slider=add("slider");api.color=add("color");api.toggle=add("toggle");api.select=add("select");return api};
addEventListener("message",function(e){var d=e.data;if(e.source!==parent||parent===window||!d||typeof d!=="object"||!Array.isArray(d[${JSON.stringify(TWEAK_SET_MESSAGE)}]))return;
var touched=[];d[${JSON.stringify(TWEAK_SET_MESSAGE)}].forEach(function(s){groups.forEach(function(g){g.controls.forEach(function(c){if(s&&c.id===s.id){c.obj[c.key]=s.value;if(touched.indexOf(g)<0)touched.push(g)}})})});
touched.forEach(function(g){if(g.onChange)try{g.onChange()}catch(x){console.error(x)}});});
addEventListener("message",function(e){if(e.source!==parent||parent===window||!e.data)return;if(e.data.preview==="theme")wear(e.data.value)});
${HOLD_FRAMES}
addEventListener("click",function(e){
 if(!e.isTrusted||e.defaultPrevented||e.button!==0)return;
 var a=e.target.closest&&e.target.closest("a[href]");if(!a)return;
 var u;try{u=new URL(a.href)}catch(x){return}
 if(!/^(https?|mailto):$/.test(u.protocol))return;e.preventDefault();post({preview:"open",url:u.href});
});
addEventListener("error",function(e){post({preview:"error",message:String(e.message||"Page error").slice(0,1000)})});
addEventListener("unhandledrejection",function(e){post({preview:"error",message:String(e.reason).slice(0,1000)})});
var measure=${MEASURE_HEIGHT},last=0,width=0;
function report(){var h=Math.ceil(measure())+2,w=document.documentElement.clientWidth;if(h>2&&(Math.abs(h-last)>2||w!==width)){last=h;width=w;post({preview:"height",height:h,width:w})}}
addEventListener("load",report);addEventListener("resize",report);
new ResizeObserver(report).observe(document.documentElement);
setTimeout(report,50);setTimeout(report,200);setTimeout(report,500);setTimeout(report,1200);
})();</script>`;
	const head = html.match(/<head(?:\s[^>]*)?>/i);
	if (head) return html.replace(head[0], () => head[0] + bridge);
	const doctype = html.match(/^\s*<!doctype[^>]*>/i);
	return doctype ? html.replace(doctype[0], () => doctype[0] + bridge) : bridge + html;
}
