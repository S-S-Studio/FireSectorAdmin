import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';
const supabase=createClient('https://gekvveymihsskkuxgxve.supabase.co','sb_publishable_nU5RxgAg5gq0Gr53Fb-F_w_Z6_dS3qe',{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const $=id=>document.getElementById(id);
const screens=['loading','login','denied','dashboard'];
function show(id){screens.forEach(x=>$(x).classList.add('hidden'));$(id).classList.remove('hidden')}
function err(t){$('error').textContent=t;$('error').classList.remove('hidden')}
async function load(user){
 const {data:admin,error:aerr}=await supabase.from('admin_users').select('id,display_name,is_super_admin,is_active').eq('id',user.id).maybeSingle();
 if(aerr) throw new Error('Could not verify administrator access.');
 if(!admin||!admin.is_active){show('denied');return}
 const {data:districts,error:derr}=await supabase.from('districts').select('id,code,name,description,is_active').eq('is_active',true).order('name');
 if(derr) throw new Error('Could not load district access.');
 $('adminName').textContent=admin.display_name||'FireSector Admin';$('adminEmail').textContent=user.email||'—';$('role').textContent=admin.is_super_admin?'Super Admin':'Admin';$('welcome').textContent=`Welcome, ${admin.display_name||user.email||'Administrator'}.`;$('districtCount').textContent=String((districts||[]).length);
 const sel=$('districtSelect');sel.innerHTML='';
 (districts||[]).forEach(d=>{const o=document.createElement('option');o.value=d.id;o.textContent=d.name;o.dataset.code=d.code;sel.appendChild(o)});
 const i=(districts||[]).findIndex(d=>d.code==='PETRUSBURG');if(i>=0)sel.selectedIndex=i;
 $('districtTitle').textContent=sel.options[sel.selectedIndex]?.textContent||'No district available';show('dashboard')
}
$('districtSelect').addEventListener('change',e=>$('districtTitle').textContent=e.target.options[e.target.selectedIndex]?.textContent||'District');
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('error').classList.add('hidden');$('loginBtn').disabled=true;$('loginBtn').textContent='Signing in…';const {data,error}=await supabase.auth.signInWithPassword({email:$('email').value.trim(),password:$('password').value});if(error){err('Invalid email or password.');$('loginBtn').disabled=false;$('loginBtn').textContent='Sign in';return}try{await load(data.user)}catch(x){await supabase.auth.signOut();show('login');err(x.message)}finally{$('loginBtn').disabled=false;$('loginBtn').textContent='Sign in'}});
async function out(){await supabase.auth.signOut();show('login')} $('signOut').onclick=out;$('deniedOut').onclick=out;
async function restore(){show('loading');const {data}=await supabase.auth.getSession();if(!data.session?.user){show('login');return}try{await load(data.session.user)}catch(e){await supabase.auth.signOut();show('login');err(e.message)}}
let installPrompt=null;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('installBtn').classList.remove('hidden')});$('installBtn').onclick=async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('installBtn').classList.add('hidden')};
function online(){const off=!navigator.onLine;$('offline').classList.toggle('hidden',!off);$('conn').textContent=off?'Offline — using current screen data':'Connected to FireSector backend'}window.addEventListener('online',online);window.addEventListener('offline',online);online();
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(console.warn));
restore();