const SUPABASE_URL='https://gekvveymihsskkuxgxve.supabase.co';
const SUPABASE_KEY='sb_publishable_nU5RxgAg5gq0Gr53Fb-F_w_Z6_dS3qe';
const STARTUP_TIMEOUT_MS=8000;
const REQUEST_TIMEOUT_MS=10000;

const $=id=>document.getElementById(id);
const screens=['loading','startupError','login','denied','dashboard'];

let accessToken=null;
let currentUser=null;
let installPrompt=null;

function show(id){
  screens.forEach(x=>$(x).classList.add('hidden'));
  $(id).classList.remove('hidden');
}

function showLoginError(message){
  $('error').textContent=message;
  $('error').classList.remove('hidden');
}

function clearLoginError(){
  $('error').textContent='';
  $('error').classList.add('hidden');
}

function withTimeout(promise,ms,message){
  return Promise.race([
    promise,
    new Promise((_,reject)=>setTimeout(()=>reject(new Error(message)),ms))
  ]);
}

async function apiFetch(path,options={}){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);

  const headers={
    apikey:SUPABASE_KEY,
    ...options.headers
  };

  if(accessToken){
    headers.Authorization=`Bearer ${accessToken}`;
  }

  try{
    const response=await fetch(`${SUPABASE_URL}${path}`,{
      ...options,
      headers,
      signal:controller.signal
    });

    const text=await response.text();
    let body=null;
    try{body=text?JSON.parse(text):null}catch(_){body=text}

    if(!response.ok){
      const message=
        body?.msg||
        body?.message||
        body?.error_description||
        body?.error||
        `Request failed (${response.status})`;
      throw new Error(message);
    }

    return body;
  }finally{
    clearTimeout(timeout);
  }
}

async function signIn(email,password){
  const body=await apiFetch('/auth/v1/token?grant_type=password',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email,password})
  });

  if(!body?.access_token||!body?.user){
    throw new Error('Invalid login response.');
  }

  accessToken=body.access_token;
  currentUser=body.user;
  return body.user;
}

function clearSession(){
  accessToken=null;
  currentUser=null;
}

async function restSelect(table,query){
  return apiFetch(`/rest/v1/${table}?${query}`,{
    method:'GET',
    headers:{
      Accept:'application/json'
    }
  });
}

async function loadAdminContext(user){
  const admins=await restSelect(
    'admin_users',
    `select=id,display_name,is_super_admin,is_active&id=eq.${encodeURIComponent(user.id)}`
  );

  const admin=Array.isArray(admins)?admins[0]:null;

  if(!admin||!admin.is_active){
    show('denied');
    return;
  }

  const districts=await restSelect(
    'districts',
    'select=id,code,name,description,is_active&is_active=eq.true&order=name.asc'
  );

  populateDashboard(user,admin,Array.isArray(districts)?districts:[]);
  show('dashboard');
}

function populateDashboard(user,admin,districts){
  $('adminName').textContent=admin.display_name||'FireSector Admin';
  $('adminEmail').textContent=user.email||'—';
  $('role').textContent=admin.is_super_admin?'Super Admin':'Admin';
  $('welcome').textContent=`Welcome, ${admin.display_name||user.email||'Administrator'}.`;
  $('districtCount').textContent=String(districts.length);

  const sel=$('districtSelect');
  sel.innerHTML='';

  if(districts.length===0){
    const o=document.createElement('option');
    o.value='';
    o.textContent='No districts assigned';
    sel.appendChild(o);
    sel.disabled=true;
    return;
  }

  sel.disabled=false;

  districts.forEach(d=>{
    const o=document.createElement('option');
    o.value=d.id;
    o.textContent=d.name;
    o.dataset.code=d.code||'';
    sel.appendChild(o);
  });

  const i=districts.findIndex(d=>d.code==='PETRUSBURG');
  if(i>=0)sel.selectedIndex=i;

}


const togglePassword=$('togglePassword');
const passwordEyeOpen=$('passwordEyeOpen');
const passwordEyeClosed=$('passwordEyeClosed');

togglePassword.addEventListener('mousedown',event=>{
  event.preventDefault();
});

togglePassword.addEventListener('click',()=>{
  const input=$('password');
  const willShow=input.type==='password';

  input.type=willShow?'text':'password';

  passwordEyeOpen.classList.toggle('hidden',willShow);
  passwordEyeClosed.classList.toggle('hidden',!willShow);

  togglePassword.setAttribute('aria-pressed',String(willShow));
  togglePassword.setAttribute(
    'aria-label',
    willShow?'Hide password':'Show password'
  );

  input.focus({preventScroll:true});
  const len=input.value.length;
  try{input.setSelectionRange(len,len)}catch(_){}
});

['email','password'].forEach(id=>{
  $(id).addEventListener('input',()=>{
    clearLoginError();
  });
});

$('loginForm').addEventListener('submit',async e=>{
  e.preventDefault();
  clearLoginError();

  const btn=$('loginBtn');
  btn.disabled=true;
  btn.textContent='Signing in…';

  try{
    clearSession();

    const user=await signIn(
      $('email').value.trim(),
      $('password').value
    );

    await loadAdminContext(user);
    $('password').value='';
  }catch(error){
    clearSession();

    const message=String(error?.message||'').toLowerCase();

    if(
      message.includes('invalid login')||
      message.includes('invalid credentials')||
      message.includes('email or password')
    ){
      showLoginError('Incorrect email or password.');
    }else{
      showLoginError(error.message||'Could not connect to FireSector.');
    }
  }finally{
    btn.disabled=false;
    btn.textContent='Sign in';
  }
});

function lockToLogin(){
  clearSession();
  $('password').value='';
  show('login');
}

$('signOut').addEventListener('click',lockToLogin);
$('deniedOut').addEventListener('click',lockToLogin);

async function startup(){
  show('loading');
  clearSession();

  try{
    await withTimeout(
      fetch(`${SUPABASE_URL}/auth/v1/health`,{
        method:'GET',
        headers:{apikey:SUPABASE_KEY},
        cache:'no-store'
      }).then(r=>{
        if(!r.ok)throw new Error(`Backend health check failed (${r.status}).`);
      }),
      STARTUP_TIMEOUT_MS,
      'Connection timed out.'
    );

    show('login');
  }catch(error){
    $('startupErrorText').textContent=error.message||'Unable to reach FireSector backend.';
    $('startupErrorText').classList.remove('hidden');
    show('startupError');
  }
}

$('retryStartup').addEventListener('click',startup);

function updateOnlineState(){
  const offline=!navigator.onLine;
  $('offline').classList.toggle('hidden',!offline);

}

window.addEventListener('online',updateOnlineState);
window.addEventListener('offline',updateOnlineState);
updateOnlineState();

window.addEventListener('beforeinstallprompt',e=>{
  e.preventDefault();
  installPrompt=e;
  $('installBtn').classList.remove('hidden');
});

$('installBtn').addEventListener('click',async()=>{
  if(!installPrompt)return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt=null;
  $('installBtn').classList.add('hidden');
});

window.addEventListener('appinstalled',()=>{
  installPrompt=null;
  $('installBtn').classList.add('hidden');
});

if('serviceWorker'in navigator){
  window.addEventListener('load',async()=>{
    try{
      const reg=await navigator.serviceWorker.register('./service-worker.js',{
        updateViaCache:'none'
      });
      await reg.update();
    }catch(error){
      console.warn('Service worker registration failed:',error);
    }
  });
}

window.addEventListener('pageshow',event=>{
  if(event.persisted){
    lockToLogin();
  }
});

startup();
