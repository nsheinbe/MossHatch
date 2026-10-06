import { useEffect, useState } from "react";
import { useUi } from "../store";
import { handle } from "../world/handle";
import { getOrder, orderStory, reconcileOrder, TERMINAL, type OrderView } from "../lib/orders";
import { listDomains } from "../lib/domains";
import { runHatch } from "./hatchFlow";
import { takeHandoff } from "../lib/handoff";
export function OrderReturn() {
 const { orderId,orderSession,accountOpen,set }=useUi();
 const [order,setOrder]=useState<OrderView|null>(null);
 const [error,setError]=useState(false);
 const [revision,setRevision]=useState(0);
 const [managing,setManaging]=useState(false);
 useEffect(()=>{
  if(!orderId)return;
  let active=true, timer=0, hatchTimer=0, failures=0, hatched=false;
  setOrder(null);setError(false);
  const tick=async(first:boolean)=>{
   try {
    const o=first&&orderSession?await reconcileOrder(orderId,orderSession):await getOrder(orderId);
    if(!active)return;
    setOrder(o);setError(false);failures=0;
    if(o.kind==='transfer_in'){set({orderId:null,orderSession:null,rescue:{fqdn:o.fqdn,transferId:takeHandoff(o.id),orderId:o.id}});history.replaceState(null,'','/');return;}
    const registered=o.kind!=='renew'&&['registered','capturing','captured'].includes(o.state);
    if(registered&&!hatched&&handle.world){hatched=true;handle.world.setResults([{domain:o.fqdn,available:true}]);hatchTimer=window.setTimeout(()=>{if(active)void runHatch(o.fqdn);},1600);}
    if(!TERMINAL.has(o.state))timer=window.setTimeout(()=>void tick(false),2000);
   }catch{if(!active)return;setError(true);if(++failures<=3)timer=window.setTimeout(()=>void tick(false),Math.min(15000,2000*2**failures));}
  };
  void tick(true);
  return()=>{active=false;window.clearTimeout(timer);window.clearTimeout(hatchTimer);};
 },[orderId,orderSession,revision,set]);
 if(!orderId||accountOpen)return null;
 const dismiss=()=>{set({orderId:null,orderSession:null});history.replaceState(null,'','/');};
 const manage=async()=>{
  setManaging(true);
  try{const all=await listDomains();const d=all.domains.find(d=>d.fqdn===order?.fqdn);if(d){set({domainPanel:{id:d.id,fqdn:d.fqdn},hatchPhase:'none',card:null});dismiss();}else{setError(true);}}catch{setError(true);}finally{setManaging(false);}
 };
 const registered=order&&order.kind!=='renew'&&['registered','capturing','captured'].includes(order.state);
 return <aside className="panel side" role="region" aria-label="Your order" aria-live="polite" style={{top:'auto',bottom:96}}>
  <div className="head"><h2>{order?.fqdn??'Your order'}</h2></div>
  <div className="body"><p>{order?(order.message??orderStory(order.state)):'Checking your order…'}</p>
  {error&&<div role="alert"><p>We couldn't refresh your order. This does not mean registration failed. Sign in with the account you used, then check again.</p><button className="btn secondary" onClick={()=>setRevision(x=>x+1)}>Check order again</button><button className="text-btn" onClick={()=>set({accountOpen:true})}>Sign in</button></div>}
  {order?.charged_minor&&<p className="notice">Charged {(Number(order.charged_minor)/100).toFixed(2)} USD, tax included.</p>}
  {registered&&<div className="checkout-status"><p>Your name is registered. Connect a website, review renewal settings, or publish your creature's page from the Overview's public card section.</p><button className="btn primary" disabled={managing} onClick={()=>void manage()}>{managing?'Opening…':'Set up my domain'}</button></div>}
  <div className="row-actions"><button className="btn secondary" onClick={dismiss}>Close</button><a href="/report.html">Get help</a></div></div>
 </aside>;
}
