import { Buffer } from 'node:buffer';

export const VIEWER_THRESHOLD = 5_000;
export const VIEWER_ENGINE = 'vis-network-9.1.6';

export function selectViewerMode(nodeCount) {
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 0)
    throw new Error('node count must be a non-negative safe integer');
  return nodeCount <= VIEWER_THRESHOLD ? 'full' : 'community-drill';
}

const text = (...values) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
};

const edgeEndpoint = (value) => text(value && typeof value === 'object' ? value.id : value);

export function buildViewerProjection({ repository, nodes, edges }) {
  if (!Array.isArray(nodes) || !Array.isArray(edges))
    throw new Error('viewer input must contain nodes and edges arrays');
  const mode = selectViewerMode(nodes.length);
  const communityKeys = new Map();
  const communities = [];
  const ensureCommunity = (node) => {
    const key = text(node.community, node.community_id, node.cluster, 'unassigned');
    if (communityKeys.has(key)) return communityKeys.get(key);
    const index = communities.length;
    communityKeys.set(key, index);
    communities.push([key, text(node.community_name, `Community ${key}`), 0]);
    return index;
  };
  const ids = new Map();
  const projectedNodes = nodes.map((node, index) => {
    const id = text(node?.id, `node-${index}`);
    if (ids.has(id)) throw new Error(`Graphify graph contains duplicate node id: ${id}`);
    ids.set(id, index);
    const community = ensureCommunity(node ?? {});
    communities[community][2] += 1;
    return [
      id,
      text(node?.label, node?.name, id),
      text(node?.type, node?.file_type, node?._origin, 'node'),
      community,
      text(node?.source_file),
    ];
  });
  const projectedEdges = [];
  const communityEdgeWeights = new Map();
  for (const edge of edges) {
    const source = ids.get(edgeEndpoint(edge?.source));
    const target = ids.get(edgeEndpoint(edge?.target));
    if (source === undefined || target === undefined) continue;
    projectedEdges.push([source, target, text(edge?.relation, edge?.type, 'related')]);
    const sourceCommunity = projectedNodes[source][3];
    const targetCommunity = projectedNodes[target][3];
    if (sourceCommunity === targetCommunity) continue;
    const first = Math.min(sourceCommunity, targetCommunity);
    const second = Math.max(sourceCommunity, targetCommunity);
    const key = `${first}:${second}`;
    communityEdgeWeights.set(key, (communityEdgeWeights.get(key) ?? 0) + 1);
  }
  const communityEdges = [...communityEdgeWeights]
    .map(([key, weight]) => [...key.split(':').map(Number), weight])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return {
    schemaVersion: 1,
    repository,
    mode,
    threshold: VIEWER_THRESHOLD,
    stats: { nodes: projectedNodes.length, edges: projectedEdges.length },
    communities,
    communityEdges,
    nodes: projectedNodes,
    edges: projectedEdges,
  };
}

export function renderViewerData(projection) {
  const json = JSON.stringify(projection)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  return Buffer.from(`window.__OPEN4WD_GRAPH__=${json};\n`, 'utf8');
}

export function renderViewerIndex({ repository, nodeCount, edgeCount, mode }) {
  const title = repository.split('/')[1];
  const description =
    mode === 'full'
      ? 'Complete graph · all nodes and edges in one native-style interactive view'
      : 'Community overview · select a community to inspect its complete subgraph';
  return Buffer.from(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} Graphify</title>
<style>
:root{color-scheme:dark;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f0f1a;color:#e0e0e0}*{box-sizing:border-box}body{margin:0;display:flex;height:100vh;overflow:hidden;background:#0f0f1a}#graph-pane{position:relative;display:flex;flex:1;min-width:0;flex-direction:column}#toolbar{display:flex;align-items:center;gap:.6rem;padding:.55rem .75rem;border-bottom:1px solid #2a2a4e;background:#151526}h1{margin:0;font-size:14px}.meta{color:#777;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}button,input{font:inherit;color:#e0e0e0;background:#0f0f1a;border:1px solid #3a3a5e;border-radius:6px;padding:7px 10px;outline:none}button{cursor:pointer}button:hover,button:focus-visible,input:focus{border-color:#4E79A7}button[hidden]{display:none}#graph{flex:1;min-height:0}#sidebar{width:300px;border-left:1px solid #2a2a4e;background:#1a1a2e;display:flex;flex-direction:column;overflow:hidden}#search-wrap{padding:12px;border-bottom:1px solid #2a2a4e}#search{width:100%}#search-results{display:none;max-height:180px;overflow:auto;padding:4px 12px;border-bottom:1px solid #2a2a4e}.search-item{display:block;width:100%;padding:5px 7px;border:0;border-left:3px solid #555;border-radius:3px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.search-item:hover{background:#2a2a4e}#info-panel{padding:14px;border-bottom:1px solid #2a2a4e;min-height:140px}#info-panel h2,#legend-wrap h2{font-size:12px;color:#aaa;margin:0 0 9px;text-transform:uppercase;letter-spacing:.05em}#details{color:#ccc;overflow-wrap:anywhere}.field{margin-bottom:5px}.empty{color:#666;font-style:italic}#legend-wrap{flex:1;overflow:auto;padding:12px}.legend-item{display:flex;align-items:center;gap:8px;padding:4px;border-radius:4px;cursor:pointer}.legend-item:hover{background:#2a2a4e}.legend-dot{width:12px;height:12px;border-radius:50%;flex:0 0 auto}.legend-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.legend-count,#stats{font-size:11px;color:#666}#stats{padding:10px 14px;border-top:1px solid #2a2a4e}@media(max-width:760px){body{flex-direction:column}#graph-pane{min-height:60vh}#toolbar{flex-wrap:wrap}.meta{order:3;width:100%}#sidebar{width:100%;max-height:40vh;border-left:0;border-top:1px solid #2a2a4e}}
</style></head><body>
<section id="graph-pane"><div id="toolbar"><h1>${title}</h1><span class="meta">${nodeCount.toLocaleString('en-US')} nodes · ${edgeCount.toLocaleString('en-US')} edges · ${description}</span><button data-action="back" hidden>← Communities</button><button data-action="fit">Fit</button></div><div id="graph" role="application" aria-label="Interactive knowledge graph"></div></section>
<aside id="sidebar"><div id="search-wrap"><input id="search" aria-label="Search nodes" placeholder="Search nodes…" autocomplete="off"></div><div id="search-results"></div><div id="info-panel"><h2>Node info</h2><div id="details"><span class="empty">Select a node${mode === 'community-drill' ? ' or community' : ''}</span></div></div><div id="legend-wrap"><h2>Communities</h2><div id="legend"></div></div><div id="stats">${nodeCount.toLocaleString('en-US')} nodes · ${edgeCount.toLocaleString('en-US')} edges</div></aside>
<script src="viewer-data.js"></script><script src="vis-network.min.js"></script><script>
(()=>{'use strict';const data=window.__OPEN4WD_GRAPH__,container=document.querySelector('#graph'),details=document.querySelector('#details'),results=document.querySelector('#search-results'),search=document.querySelector('#search'),legend=document.querySelector('#legend'),back=document.querySelector('[data-action="back"]'),fitButton=document.querySelector('[data-action="fit"]');const colors=['#4E79A7','#F28E2B','#E15759','#76B7B2','#59A14F','#EDC948','#B07AA1','#FF9DA7','#9C755F','#BAB0AC'];let view=null;
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const degrees=new Uint32Array(data.nodes.length);for(const edge of data.edges){degrees[edge[0]]++;degrees[edge[1]]++}
function nodeView(community=null){const included=new Set();for(let i=0;i<data.nodes.length;i++)if(community===null||data.nodes[i][3]===community)included.add(i);const nodes=[...included].map(id=>{const n=data.nodes[id],color=colors[n[3]%colors.length],degree=degrees[id];return{id,label:n[1],title:n[1],shape:'dot',size:Math.max(10,Math.min(40,10+degree*2.5)),font:{size:degree>1?12:0,color:'#fff'},color:{background:color,border:color,highlight:{background:'#fff',border:color}},_kind:'node',_type:n[2],_community:n[3],_source:n[4],_degree:degree}});const edges=data.edges.filter(e=>included.has(e[0])&&included.has(e[1])).map((e,id)=>({id:'e:'+id,from:e[0],to:e[1],title:e[2],arrows:{to:{enabled:true,scaleFactor:.5}},width:2,color:{opacity:.7}}));return{kind:'nodes',community,nodes,edges}}
function communityView(){const nodes=data.communities.map((c,id)=>{const color=colors[id%colors.length];return{id:'c:'+id,label:c[1],title:c[1]+' · '+c[2].toLocaleString()+' nodes',shape:'dot',size:Math.max(14,Math.min(48,12+Math.sqrt(c[2])*2)),font:{size:13,color:'#fff'},color:{background:color,border:color,highlight:{background:'#fff',border:color}},_kind:'community',_community:id,_count:c[2]}});const edges=data.communityEdges.map((e,id)=>({id:'ce:'+id,from:'c:'+e[0],to:'c:'+e[1],title:e[2]+' cross-community edges',width:Math.max(1,Math.min(10,1+Math.log2(1+e[2]))),color:{opacity:.55}}));return{kind:'communities',community:null,nodes,edges}}
const options={physics:{enabled:true,solver:'forceAtlas2Based',forceAtlas2Based:{gravitationalConstant:-60,centralGravity:.005,springLength:120,springConstant:.08,damping:.4,avoidOverlap:.8},stabilization:{iterations:200,fit:true}},interaction:{hover:true,tooltipDelay:100,hideEdgesOnDrag:true,navigationButtons:false,keyboard:false},nodes:{shape:'dot',borderWidth:1.5},edges:{smooth:{type:'continuous',roundness:.2},selectionWidth:3}};
let nodeDataSet=new vis.DataSet();const network=new vis.Network(container,{nodes:nodeDataSet,edges:new vis.DataSet()},options);
function settle(){network.once('stabilizationIterationsDone',()=>network.setOptions({physics:{enabled:false}}))}
function setView(next){view=next;nodeDataSet=new vis.DataSet(next.nodes);network.setOptions({physics:{enabled:true}});network.setData({nodes:nodeDataSet,edges:new vis.DataSet(next.edges)});back.hidden=next.kind!=='nodes'||next.community===null;details.innerHTML='<span class="empty">'+(next.kind==='communities'?'Select a community to drill into its complete subgraph':'Select a node')+'</span>';renderLegend();settle()}
function showNode(item){if(!item)return;if(item._kind==='community'){details.innerHTML='<div class="field"><b>'+esc(item.label)+'</b></div><div class="field">'+item._count.toLocaleString()+' nodes</div><div class="field">Opening complete community subgraph…</div>';setView(nodeView(item._community));return}details.innerHTML='<div class="field"><b>'+esc(item.label)+'</b></div><div class="field">Type: '+esc(item._type)+'</div><div class="field">Community: '+esc(data.communities[item._community]?.[1]??item._community)+'</div><div class="field">Source: '+esc(item._source||'-')+'</div><div class="field">Degree: '+item._degree+'</div>'}
function focusOriginal(id){const n=data.nodes[id];if(!n)return;if(data.mode==='community-drill'&&(view.kind==='communities'||view.community!==n[3]))setView(nodeView(n[3]));setTimeout(()=>{network.focus(id,{scale:1.4,animation:true});network.selectNodes([id]);showNode(nodeDataSet.get(id))},0)}
function renderLegend(){legend.replaceChildren();for(let id=0;id<data.communities.length;id++){const c=data.communities[id],row=document.createElement('div');row.className='legend-item';row.innerHTML='<span class="legend-dot" style="background:'+colors[id%colors.length]+'"></span><span class="legend-label">'+esc(c[1])+'</span><span class="legend-count">'+c[2].toLocaleString()+'</span>';row.addEventListener('click',()=>{if(data.mode==='community-drill')setView(nodeView(id));else{const member=data.nodes.findIndex(n=>n[3]===id);if(member>=0)focusOriginal(member)}});legend.append(row)}}
network.on('click',params=>{if(params.nodes.length)showNode(nodeDataSet.get(params.nodes[0]));else details.innerHTML='<span class="empty">Select a node</span>'});
search.addEventListener('input',()=>{const term=search.value.trim().toLowerCase();results.replaceChildren();if(!term){results.style.display='none';return}const found=[];for(let i=0;i<data.nodes.length&&found.length<30;i++){const n=data.nodes[i];if((n[1]+' '+n[2]+' '+n[4]).toLowerCase().includes(term))found.push(i)}results.style.display=found.length?'block':'none';for(const id of found){const n=data.nodes[id],button=document.createElement('button');button.className='search-item';button.textContent=n[1]+' · '+n[2];button.style.borderLeftColor=colors[n[3]%colors.length];button.addEventListener('click',()=>{focusOriginal(id);results.style.display='none';search.value=''});results.append(button)}});
document.addEventListener('click',event=>{if(!results.contains(event.target)&&event.target!==search)results.style.display='none'});back.addEventListener('click',()=>setView(communityView()));fitButton.addEventListener('click',()=>network.fit({animation:true}));setView(data.mode==='full'?nodeView():communityView());
})();
</script></body></html>\n`,
    'utf8',
  );
}
