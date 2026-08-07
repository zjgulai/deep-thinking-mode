// fix-sidebar.mjs
import { readFileSync, writeFileSync } from "node:fs";

let c = readFileSync("tools/build-site.mjs", "utf8");

// 1. Insert sidebar CSS inside CSS template literal
const sidebarCSS = ".sidebar{position:fixed;left:0;top:56px;width:260px;height:calc(100vh - 56px);overflow-y:auto;background:var(--s);border-right:1px solid var(--h);padding:16px;z-index:40;font-size:.82rem;line-height:1.8}.sidebar h3{font-size:.75rem;color:var(--a);margin-bottom:8px;letter-spacing:.05em;font-weight:700}.sidebar a{display:block;color:var(--b);padding:3px 8px;border-radius:4px;text-decoration:none;transition:background .1s}.sidebar a:hover{background:var(--h);text-decoration:none}@media(max-width:1100px){.sidebar{display:none}}main.with-sidebar{margin-left:280px;max-width:860px}";
c = c.replace("@media(max-width:768px){header nav{display:none}", sidebarCSS + "@media(max-width:768px){header nav{display:none}");

// 2. Generate sidebar in chapter loop
c = c.replace('let html="";', 
  'let sb="<div class=sidebar><h3>本章模型</h3>";for(const a of arts){const aid="m-"+(a.id||(a.meta?.name||"").replace(/[\\s/\\\\:：]/g,"-").slice(0,30));sb+="<a href=#"+aid+">"+esc((a.meta?.name||"").slice(0,22))+"</a>";}sb+="</div>";html+=sb;');

// 3. Add anchor IDs to model cards
c = c.replaceAll('<article class="model-card">', '<article class="model-card" id="${"m-"+a.id||""}">');

// 4. with-sidebar on main
c = c.replace('<main id="main">', '<main id="main" class="with-sidebar">');

writeFileSync("tools/build-site.mjs", c);
console.log("OK");
