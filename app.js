/* FireSector Admin app.js V018 */
const SUPABASE_URL='https://gekvveymihsskkuxgxve.supabase.co';
const SUPABASE_KEY='sb_publishable_nU5RxgAg5gq0Gr53Fb-F_w_Z6_dS3qe';
const STARTUP_TIMEOUT_MS=8000;
const REQUEST_TIMEOUT_MS=10000;

const $=id=>document.getElementById(id);
const screens=['openFireSector','loading','startupError','login','denied','dashboard'];

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
  stopTemporaryAccessLiveSync();
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
  await refreshActiveTemporaryAccess();
  startTemporaryAccessLiveSync();
}

function populateDashboard(user,admin,districts){
  $('adminName').textContent=admin.is_super_admin
    ?'FireSector Master Administrator'
    :'FireSector Admin';
  $('adminEmail').textContent=user.email||'—';
  $('role').textContent=admin.is_super_admin?'Master Administrator':'Admin';

  const signedInDisplayName=admin.is_super_admin
    ?'FireSector Master Administrator'
    :'FireSector Admin';

  $('welcome').textContent=`Welcome, ${signedInDisplayName}.`;
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


let generatedTemporaryAccess=null;
let selectedTempLocation=null;
let activeTemporaryAccess=null;
let activeAccessCountdownTimer=null;
let activeAccessPollTimer=null;
let activeAccessRefreshRunning=false;

let mapDataPayload=null;
let mapDataPermanentMarkers=[];
let mapDataFirePoints=[];
let mapDataActiveAccess=null;
let mapDataEditing=null;
let mapDataSelectedLocation=null;
let mapDataLoadRunning=false;
let mapDataInitialCenterSet=false;
let mapDataFarms=[];
let mapDataFarmSearchQuery='';

const tempMap={
  centerLat:-28.95,
  centerLon:25.70,
  zoom:11,
  dragging:false,
  moved:false,
  startX:0,
  startY:0,
  startCenterWorld:null
};

let extendAccessLocation=null;
const extendAccessMap={
  centerLat:-28.95,
  centerLon:25.70,
  zoom:13,
  dragging:false,
  moved:false,
  startX:0,
  startY:0,
  startCenterWorld:null
};

async function rpcCall(functionName,payload){
  return apiFetch(`/rest/v1/rpc/${functionName}`,{
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      Accept:'application/json'
    },
    body:JSON.stringify(payload)
  });
}

function selectedArea(){
  const select=$('districtSelect');
  const option=select?.options?.[select.selectedIndex];

  return {
    id:option?.value||'',
    name:option?.textContent||'Area'
  };
}


function normaliseSharedAccessCode(value){
  const raw=String(value||'')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g,'')
    .slice(0,10);

  if(raw.length!==10||!raw.startsWith('FS')){
    return null;
  }

  return `${raw.slice(0,2)}-${raw.slice(2,6)}-${raw.slice(6,10)}`;
}

function buildFireSectorSchemeLink(accessCode){
  const code=normaliseSharedAccessCode(accessCode);
  if(!code)return '';

  return `firesector://access?code=${encodeURIComponent(code)}`;
}

function buildFireSectorShareLink(accessCode){
  const code=normaliseSharedAccessCode(accessCode);
  if(!code)return '';

  const url=new URL(window.location.href);
  url.search='';
  url.hash='';
  url.searchParams.set('open','firesector');
  url.hash=new URLSearchParams({code}).toString();
  return url.toString();
}

function sharedAccessCodeFromLocation(){
  const url=new URL(window.location.href);
  if(url.searchParams.get('open')!=='firesector'){
    return null;
  }

  const hash=new URLSearchParams(
    url.hash.replace(/^#/,'')
  );

  return normaliseSharedAccessCode(hash.get('code'));
}

function updateGeneratedAccessLink(){
  const code=generatedTemporaryAccess?.access_code;
  const link=buildFireSectorShareLink(code);
  const anchor=$('generatedAccessLink');

  if(!anchor){
    return link;
  }

  if(link){
    anchor.href=link;
    anchor.textContent=link;
  }else{
    anchor.removeAttribute('href');
    anchor.textContent='—';
  }

  return link;
}

function formatDateTime(value){
  if(!value)return '—';

  const date=new Date(value);

  if(Number.isNaN(date.getTime())){
    return '—';
  }

  return date.toLocaleString();
}

function formatRemaining(expiresAt){
  if(!expiresAt)return '—';

  const end=new Date(expiresAt).getTime();

  if(!Number.isFinite(end)){
    return '—';
  }

  let totalSeconds=Math.max(
    0,
    Math.floor((end-Date.now())/1000)
  );

  const days=Math.floor(totalSeconds/86400);
  totalSeconds-=days*86400;

  const hours=Math.floor(totalSeconds/3600);
  totalSeconds-=hours*3600;

  const minutes=Math.floor(totalSeconds/60);
  const seconds=totalSeconds-minutes*60;

  const hh=String(hours).padStart(2,'0');
  const mm=String(minutes).padStart(2,'0');
  const ss=String(seconds).padStart(2,'0');

  return days>0
    ?`${days}d ${hh}:${mm}:${ss}`
    :`${hh}:${mm}:${ss}`;
}

function activeAccessScopeText(access){
  if(!access)return '—';

  const area=selectedArea();

  if(access.scope_type==='radius'){
    const radius=Number(access.radius_km);
    return Number.isFinite(radius)
      ?`${radius} km radius`
      :'Radius';
  }

  return area.name;
}

function renderActiveTemporaryAccess(){
  const hasActive=Boolean(activeTemporaryAccess);

  $('tempAccessCreateState')
    .classList
    .toggle('hidden',hasActive);

  $('tempAccessActiveState')
    .classList
    .toggle('hidden',!hasActive);

  if(!hasActive){
    return;
  }

  $('activeAccessCreated').textContent=
    formatDateTime(
      activeTemporaryAccess.created_at
    );

  $('activeAccessExpires').textContent=
    formatDateTime(
      activeTemporaryAccess.expires_at
    );

  $('activeAccessCountdown').textContent=
    formatRemaining(
      activeTemporaryAccess.expires_at
    );

  $('activeAccessScope').textContent=
    activeAccessScopeText(
      activeTemporaryAccess
    );
}

function tickAdminAccessCountdown(){
  if(!activeTemporaryAccess){
    return;
  }

  $('activeAccessCountdown').textContent=
    formatRemaining(
      activeTemporaryAccess.expires_at
    );

  const expiry=
    new Date(
      activeTemporaryAccess.expires_at
    ).getTime();

  if(
    Number.isFinite(expiry) &&
    Date.now()>=expiry
  ){
    activeTemporaryAccess=null;
    renderActiveTemporaryAccess();

    if(isMapDataWorkspaceOpen()){
      refreshMapData({quiet:true});
    }
  }
}

async function refreshActiveTemporaryAccess(){
  if(
    activeAccessRefreshRunning ||
    !accessToken
  ){
    return;
  }

  const previousAccessId=activeTemporaryAccess?.access_code_id||null;
  const area=selectedArea();

  if(!area.id){
    activeTemporaryAccess=null;
    renderActiveTemporaryAccess();
    return;
  }

  activeAccessRefreshRunning=true;

  try{
    const result=await rpcCall(
      'get_active_temporary_access',
      {
        p_district_id:area.id
      }
    );

    activeTemporaryAccess=
      Array.isArray(result) &&
      result.length>0
        ?result[0]
        :null;

    renderActiveTemporaryAccess();

    const nextAccessId=activeTemporaryAccess?.access_code_id||null;
    if(previousAccessId!==nextAccessId && isMapDataWorkspaceOpen()){
      await refreshMapData({quiet:true});
    }
  }catch(error){
    console.warn(
      'Could not refresh active Temporary Access:',
      error
    );
  }finally{
    activeAccessRefreshRunning=false;
  }
}

function startTemporaryAccessLiveSync(){
  stopTemporaryAccessLiveSync();

  activeAccessCountdownTimer=setInterval(
    tickAdminAccessCountdown,
    1000
  );

  activeAccessPollTimer=setInterval(
    ()=>{
      refreshActiveTemporaryAccess();
    },
    5000
  );
}

function stopTemporaryAccessLiveSync(){
  if(activeAccessCountdownTimer){
    clearInterval(activeAccessCountdownTimer);
    activeAccessCountdownTimer=null;
  }

  if(activeAccessPollTimer){
    clearInterval(activeAccessPollTimer);
    activeAccessPollTimer=null;
  }

  activeTemporaryAccess=null;
}

async function revokeCurrentTemporaryAccess(){
  if(!activeTemporaryAccess){
    return;
  }

  const confirmed=window.confirm(
    'Revoke this Temporary Access? Anyone currently using this access will be signed out when their device is online.'
  );

  if(!confirmed){
    return;
  }

  const button=$('revokeActiveAccess');
  button.disabled=true;
  button.textContent='Revoking…';

  try{
    await rpcCall(
      'revoke_temporary_access',
      {
        p_access_code_id:
          activeTemporaryAccess
            .access_code_id
      }
    );

    activeTemporaryAccess=null;
    renderActiveTemporaryAccess();
    setTempAccessView(false);
  }catch(error){
    window.alert(
      error.message||
      'Could not revoke Temporary Access.'
    );
  }finally{
    button.disabled=false;
    button.textContent='Revoke Access';
  }
}

function normaliseLongitude(lon){
  let value=lon;

  while(value<-180)value+=360;
  while(value>180)value-=360;

  return value;
}

function clampLatitude(lat){
  return Math.max(
    -85.05112878,
    Math.min(85.05112878,lat)
  );
}

function latLonToWorld(lat,lon,zoom){
  const scale=256*Math.pow(2,zoom);
  const x=
    (normaliseLongitude(lon)+180)/
    360*scale;

  const safeLat=clampLatitude(lat);
  const sin=Math.sin(
    safeLat*Math.PI/180
  );

  const y=
    (
      0.5-
      Math.log(
        (1+sin)/(1-sin)
      )/(4*Math.PI)
    )*scale;

  return {x,y};
}

function worldToLatLon(x,y,zoom){
  const scale=256*Math.pow(2,zoom);
  const lon=x/scale*360-180;
  const n=Math.PI-2*Math.PI*y/scale;
  const lat=
    180/Math.PI*
    Math.atan(Math.sinh(n));

  return {
    lat:clampLatitude(lat),
    lon:normaliseLongitude(lon)
  };
}

function parseCoordinates(value){
  const parts=String(value||'')
    .trim()
    .replace(/[°]/g,'')
    .split(/[,\s]+/)
    .filter(Boolean);

  if(parts.length<2){
    return null;
  }

  const lat=Number(parts[0]);
  const lon=Number(parts[1]);

  if(
    !Number.isFinite(lat)||
    !Number.isFinite(lon)||
    lat<-90||
    lat>90||
    lon<-180||
    lon>180
  ){
    return null;
  }

  return {lat,lon};
}

function formatCoordinates(point){
  return (
    `${point.lat.toFixed(7)}, `+
    `${point.lon.toFixed(7)}`
  );
}

function mapRadiusPixels(lat,radiusKm,zoom){
  const metresPerPixel=
    156543.03392*
    Math.max(0.01,Math.cos(lat*Math.PI/180))/
    Math.pow(2,zoom);

  return Math.max(1,(radiusKm*1000)/metresPerPixel);
}

function setSelectedTempLocation(
  point,
  {recenter=true}={}
){
  selectedTempLocation={
    lat:point.lat,
    lon:point.lon
  };

  $('tempCoordinates').value=
    formatCoordinates(
      selectedTempLocation
    );

  if(recenter){
    tempMap.centerLat=point.lat;
    tempMap.centerLon=point.lon;
  }

  renderTempMap();
}

function renderTempMap(){
  const map=$('coordinateMap');
  const tiles=$('mapTiles');

  if(!map||!tiles){
    return;
  }

  const width=map.clientWidth;
  const height=map.clientHeight;

  if(width<10||height<10){
    return;
  }

  const z=tempMap.zoom;
  const center=latLonToWorld(
    tempMap.centerLat,
    tempMap.centerLon,
    z
  );

  const left=center.x-width/2;
  const top=center.y-height/2;

  const minTileX=
    Math.floor(left/256);

  const maxTileX=
    Math.floor(
      (left+width)/256
    );

  const minTileY=
    Math.floor(top/256);

  const maxTileY=
    Math.floor(
      (top+height)/256
    );

  const tileCount=
    Math.pow(2,z);

  const fragment=
    document.createDocumentFragment();

  for(
    let ty=minTileY;
    ty<=maxTileY;
    ty++
  ){
    if(
      ty<0||
      ty>=tileCount
    ){
      continue;
    }

    for(
      let tx=minTileX;
      tx<=maxTileX;
      tx++
    ){
      const wrappedX=
        (
          (tx%tileCount)+
          tileCount
        )%tileCount;

      const img=
        document.createElement('img');

      img.className='map-tile';
      img.alt='';
      img.draggable=false;

      img.src=
        `https://tile.openstreetmap.org/`+
        `${z}/${wrappedX}/${ty}.png`;

      img.style.left=
        `${tx*256-left}px`;

      img.style.top=
        `${ty*256-top}px`;

      fragment.appendChild(img);
    }
  }

  tiles.replaceChildren(fragment);

  const radiusOverlay=$('mapRadiusOverlay');
  const radiusKm=Number($('tempRadiusKm')?.value);
  const radiusVisible=
    $('tempAccessScope')?.value==='radius' &&
    selectedTempLocation &&
    Number.isFinite(radiusKm) &&
    radiusKm>0;

  if(radiusOverlay){
    if(radiusVisible){
      const rp=latLonToWorld(
        selectedTempLocation.lat,
        selectedTempLocation.lon,
        z
      );
      const radiusPx=mapRadiusPixels(
        selectedTempLocation.lat,
        radiusKm,
        z
      );
      radiusOverlay.style.left=`${rp.x-left-radiusPx}px`;
      radiusOverlay.style.top=`${rp.y-top-radiusPx}px`;
      radiusOverlay.style.width=`${radiusPx*2}px`;
      radiusOverlay.style.height=`${radiusPx*2}px`;
      radiusOverlay.classList.remove('hidden');
    }else{
      radiusOverlay.classList.add('hidden');
    }
  }

  const marker=
    $('mapSelectionMarker');

  if(selectedTempLocation){
    const p=latLonToWorld(
      selectedTempLocation.lat,
      selectedTempLocation.lon,
      z
    );

    marker.style.left=
      `${p.x-left}px`;

    marker.style.top=
      `${p.y-top}px`;

    marker.classList.remove(
      'hidden'
    );
  }else{
    marker.classList.add(
      'hidden'
    );
  }
}

function tempMapPointFromEvent(
  event
){
  const map=
    $('coordinateMap');

  const rect=
    map.getBoundingClientRect();

  const center=
    latLonToWorld(
      tempMap.centerLat,
      tempMap.centerLon,
      tempMap.zoom
    );

  return worldToLatLon(
    center.x+
      (
        event.clientX-
        rect.left-
        rect.width/2
      ),
    center.y+
      (
        event.clientY-
        rect.top-
        rect.height/2
      ),
    tempMap.zoom
  );
}

function initialiseTempMap(){
  const map=$('coordinateMap');

  map.addEventListener(
    'pointerdown',
    event=>{
      if(
        event.target.closest(
          '.map-zoom-controls'
        )
      ){
        return;
      }

      tempMap.dragging=true;
      tempMap.moved=false;
      tempMap.startX=
        event.clientX;

      tempMap.startY=
        event.clientY;

      tempMap.startCenterWorld=
        latLonToWorld(
          tempMap.centerLat,
          tempMap.centerLon,
          tempMap.zoom
        );

      map.setPointerCapture(
        event.pointerId
      );
    }
  );

  map.addEventListener(
    'pointermove',
    event=>{
      if(!tempMap.dragging){
        return;
      }

      const dx=
        event.clientX-
        tempMap.startX;

      const dy=
        event.clientY-
        tempMap.startY;

      if(
        Math.abs(dx)+
        Math.abs(dy)>5
      ){
        tempMap.moved=true;
      }

      const next=
        worldToLatLon(
          tempMap
            .startCenterWorld
            .x-dx,
          tempMap
            .startCenterWorld
            .y-dy,
          tempMap.zoom
        );

      tempMap.centerLat=
        next.lat;

      tempMap.centerLon=
        next.lon;

      renderTempMap();
    }
  );

  map.addEventListener(
    'pointerup',
    event=>{
      if(!tempMap.dragging){
        return;
      }

      tempMap.dragging=false;

      if(!tempMap.moved){
        setSelectedTempLocation(
          tempMapPointFromEvent(
            event
          ),
          {
            recenter:false
          }
        );
      }
    }
  );

  map.addEventListener(
    'wheel',
    event=>{
      event.preventDefault();

      tempMap.zoom=
        Math.max(
          4,
          Math.min(
            18,
            tempMap.zoom+
              (
                event.deltaY<0
                  ?1
                  :-1
              )
          )
        );

      renderTempMap();
    },
    {
      passive:false
    }
  );

  $('mapZoomIn')
    .addEventListener(
      'click',
      ()=>{
        tempMap.zoom=
          Math.min(
            18,
            tempMap.zoom+1
          );

        renderTempMap();
      }
    );

  $('mapZoomOut')
    .addEventListener(
      'click',
      ()=>{
        tempMap.zoom=
          Math.max(
            4,
            tempMap.zoom-1
          );

        renderTempMap();
      }
    );
}

function setTempAccessView(open){
  $('dashboardHome')
    .classList
    .toggle('hidden',open);

  $('tempAccessWorkspace')
    .classList
    .toggle('hidden',!open);

  $('mapDataWorkspace')
    ?.classList
    .add('hidden');

  document
    .querySelectorAll(
      'nav .nav'
    )
    .forEach(
      item=>
        item.classList.remove(
          'active'
        )
    );

  if(open){
    $('temporaryAccessNav')
      .classList
      .add('active');
  }else{
    $('dashboardNav')
      .classList
      .add('active');
  }
}

function resetTempAccessForm(){
  const area=selectedArea();

  $('tempAccessWorkspaceTitle').textContent='Create Temporary Access';

  $('tempAccessAreaLabel')
    .textContent=area.name;

  $('tempAccessScope')
    .value='district';

  $('radiusFields')
    .classList
    .add('hidden');

  $('tempCoordinates').value='';
  $('tempRadiusKm').value='10';
  $('tempValidity').value='1440';
  $('locationStatus').textContent='';
  $('tempAccessError').textContent='';

  $('tempAccessError')
    .classList
    .add('hidden');

  $('tempAccessFormView')
    .classList
    .remove('hidden');

  $('tempAccessResultView')
    .classList
    .add('hidden');

  $('copyStatus').textContent='';

  $('copyStatus')
    .classList
    .add('hidden');

  generatedTemporaryAccess=null;
  selectedTempLocation=null;

  tempMap.centerLat=-28.95;
  tempMap.centerLon=25.70;
  tempMap.zoom=11;

  syncTempValidityPlacement();
}

function openTempAccessWorkspace(){
  const area=selectedArea();

  if(!area.id){
    alert(
      'Select an area first.'
    );
    return;
  }

  if(activeTemporaryAccess){
    setTempAccessView(false);

    document
      .getElementById(
        'temporaryAccessCard'
      )
      ?.scrollIntoView({
        behavior:'smooth',
        block:'start'
      });

    return;
  }

  resetTempAccessForm();
  setTempAccessView(true);

  requestAnimationFrame(
    renderTempMap
  );
}

function closeTempAccessWorkspace(){
  setTempAccessView(false);
}

function syncTempValidityPlacement(){
  const section=$('tempValiditySection');
  const defaultSlot=$('tempValidityDefaultSlot');
  const locationControls=document.querySelector('#radiusFields .location-controls');

  if(!section || !defaultSlot || !locationControls){
    return;
  }

  const radius=$('tempAccessScope')?.value==='radius';

  if(radius){
    locationControls.appendChild(section);
    section.classList.add('temp-validity-inline');
  }else{
    defaultSlot.appendChild(section);
    section.classList.remove('temp-validity-inline');
  }
}

function initialiseTemporaryAccess(){
  const requiredIds=[
    'dashboardHome',
    'tempAccessWorkspace',
    'dashboardNav',
    'createAccessBtn',
    'temporaryAccessNav',
    'temporaryAccessCard',
    'tempAccessCreateState',
    'tempAccessActiveState',
    'activeAccessCreated',
    'activeAccessExpires',
    'activeAccessCountdown',
    'activeAccessScope',
    'revokeActiveAccess',
    'closeTempAccess',
    'cancelTempAccess',
    'tempAccessScope',
    'radiusFields',
    'coordinateMap',
    'mapTiles',
    'mapSelectionMarker',
    'mapRadiusOverlay',
    'mapZoomIn',
    'mapZoomOut',
    'tempCoordinates',
    'applyCoordinates',
    'tempRadiusKm',
    'tempValidity',
    'tempValiditySection',
    'tempValidityDefaultSlot',
    'useCurrentLocation',
    'locationStatus',
    'generateTempAccess',
    'tempAccessError',
    'tempAccessFormView',
    'tempAccessResultView',
    'tempAccessAreaLabel',
    'generatedAccessCode',
    'generatedAccessArea',
    'generatedAccessExpiry',
    'generatedAccessLink',
    'copyStatus',
    'returnToDashboard',
    'copyAccessCode',
    'copyAccessLink',
    'shareAccessWhatsApp'
  ];

  const missing=
    requiredIds.filter(
      id=>!$(id)
    );

  if(missing.length){
    console.error(
      'Temporary Access UI could not initialise. Missing:',
      missing
    );
    return;
  }

  initialiseTempMap();

  $('createAccessBtn').disabled=false;

  $('dashboardNav')
    .addEventListener(
      'click',
      closeTempAccessWorkspace
    );

  $('createAccessBtn')
    .addEventListener(
      'click',
      openTempAccessWorkspace
    );

  $('temporaryAccessNav')
    .addEventListener(
      'click',
      openTempAccessWorkspace
    );

  $('closeTempAccess')
    .addEventListener(
      'click',
      closeTempAccessWorkspace
    );

  $('cancelTempAccess')
    .addEventListener(
      'click',
      closeTempAccessWorkspace
    );

  $('revokeActiveAccess')
    .addEventListener(
      'click',
      revokeCurrentTemporaryAccess
    );

  $('districtSelect')
    .addEventListener(
      'change',
      async()=>{
        closeTempAccessWorkspace();
        closeMapDataWorkspace();
        await refreshActiveTemporaryAccess();
      }
    );

  $('tempAccessScope')
    .addEventListener(
      'change',
      ()=>{
        const radius=
          $('tempAccessScope')
            .value==='radius';

        $('radiusFields')
          .classList
          .toggle(
            'hidden',
            !radius
          );

        syncTempValidityPlacement();

        if(radius){
          requestAnimationFrame(
            renderTempMap
          );
        }
      }
    );

  $('tempRadiusKm')
    .addEventListener(
      'input',
      ()=>{
        if($('tempAccessScope').value==='radius'){
          renderTempMap();
        }
      }
    );

  $('applyCoordinates')
    .addEventListener(
      'click',
      ()=>{
        const point=
          parseCoordinates(
            $('tempCoordinates')
              .value
          );

        if(!point){
          $('locationStatus')
            .textContent=
              'Paste coordinates like -28.9624455, 25.7132135';

          return;
        }

        $('locationStatus')
          .textContent=
            'Location selected.';

        setSelectedTempLocation(
          point
        );
      }
    );

  $('tempCoordinates')
    .addEventListener(
      'keydown',
      event=>{
        if(
          event.key==='Enter'
        ){
          event.preventDefault();

          $('applyCoordinates')
            .click();
        }
      }
    );

  $('useCurrentLocation')
    .addEventListener(
      'click',
      ()=>{
        if(
          !navigator.geolocation
        ){
          $('locationStatus')
            .textContent=
              'Location is not available in this browser.';

          return;
        }

        const button=
          $('useCurrentLocation');

        button.disabled=true;

        $('locationStatus')
          .textContent=
            'Getting location…';

        navigator
          .geolocation
          .getCurrentPosition(
            position=>{
              tempMap.zoom=15;

              setSelectedTempLocation({
                lat:
                  position
                    .coords
                    .latitude,
                lon:
                  position
                    .coords
                    .longitude
              });

              $('locationStatus')
                .textContent=
                  'Current location selected.';

              button.disabled=false;
            },
            error=>{
              $('locationStatus')
                .textContent=
                  error.code===1
                    ?'Location permission was not allowed.'
                    :'Could not get current location.';

              button.disabled=false;
            },
            {
              enableHighAccuracy:true,
              timeout:12000,
              maximumAge:0
            }
          );
      }
    );

  syncTempValidityPlacement();

  $('generateTempAccess')
    .addEventListener(
      'click',
      async()=>{
        const area=selectedArea();

        const scope=
          $('tempAccessScope')
            .value;

        const validity=
          Number(
            $('tempValidity')
              .value
          );

        let latitude=null;
        let longitude=null;
        let radius=null;

        $('tempAccessError')
          .textContent='';

        $('tempAccessError')
          .classList
          .add('hidden');

        if(scope==='radius'){
          const typed=
            parseCoordinates(
              $('tempCoordinates')
                .value
            );

          if(typed){
            selectedTempLocation=
              typed;
          }

          radius=
            Number(
              $('tempRadiusKm')
                .value
            );

          if(
            !selectedTempLocation||
            !Number.isFinite(
              radius
            )||
            radius<=0
          ){
            $('tempAccessError')
              .textContent=
                'Select a location on the map or paste coordinates, then enter a valid radius.';

            $('tempAccessError')
              .classList
              .remove('hidden');

            return;
          }

          latitude=
            selectedTempLocation.lat;

          longitude=
            selectedTempLocation.lon;
        }

        const button=
          $('generateTempAccess');

        button.disabled=true;
        button.textContent=
          'Creating…';

        try{
          const result=
            await rpcCall(
              'generate_temporary_access_code',
              {
                p_district_id:
                  area.id,
                p_scope_type:
                  scope,
                p_center_latitude:
                  latitude,
                p_center_longitude:
                  longitude,
                p_radius_km:
                  radius,
                p_valid_minutes:
                  validity
              }
            );

          const created=
            Array.isArray(
              result
            )
              ?result[0]
              :null;

          if(
            !created
              ?.access_code
          ){
            throw new Error(
              'No access code was returned.'
            );
          }

          generatedTemporaryAccess={
            ...created,
            areaName:area.name
          };

          $('generatedAccessCode')
            .textContent=
              created
                .access_code;

          $('generatedAccessArea')
            .textContent=
              scope==='district'
                ?area.name
                :`${radius} km radius from ${formatCoordinates(selectedTempLocation)}`;

          $('generatedAccessExpiry')
            .textContent=
              new Date(
                created
                  .expires_at
              )
              .toLocaleString();

          updateGeneratedAccessLink();

          $('tempAccessFormView')
            .classList
            .add('hidden');

          $('tempAccessResultView')
            .classList
            .remove('hidden');

          await refreshActiveTemporaryAccess();
        }catch(error){
          $('tempAccessError')
            .textContent=
              error.message||
              'Could not create temporary access.';

          $('tempAccessError')
            .classList
            .remove('hidden');
        }finally{
          button.disabled=false;
          button.textContent=
            'Create Temporary Access';
        }
      }
    );

  $('returnToDashboard')
    .addEventListener(
      'click',
      closeTempAccessWorkspace
    );

  $('copyAccessCode')
    .addEventListener(
      'click',
      async()=>{
        if(
          !generatedTemporaryAccess
        ){
          return;
        }

        try{
          await navigator
            .clipboard
            .writeText(
              generatedTemporaryAccess
                .access_code
            );

          $('copyStatus')
            .textContent=
              'Access code copied.';
        }catch(_){
          $('copyStatus')
            .textContent=
              'Could not copy automatically. Select and copy the code above.';
        }

        $('copyStatus')
          .classList
          .remove('hidden');
      }
    );

  $('copyAccessLink')
    .addEventListener(
      'click',
      async()=>{
        if(!generatedTemporaryAccess){
          return;
        }

        const link=updateGeneratedAccessLink();

        if(!link){
          return;
        }

        try{
          await navigator.clipboard.writeText(link);
          $('copyStatus').textContent='FireSector link copied.';
        }catch(_){
          $('copyStatus').textContent='Could not copy automatically. Select and copy the link above.';
        }

        $('copyStatus').classList.remove('hidden');
      }
    );

  $('shareAccessWhatsApp')
    .addEventListener(
      'click',
      ()=>{
        if(
          !generatedTemporaryAccess
        ){
          return;
        }

        const access=
          generatedTemporaryAccess;

        const scope=
          access
            .scope_type===
            'district'
              ?access.areaName
              :`${access.radius_km} km radius`;

        const shareLink=buildFireSectorShareLink(access.access_code);

        const message=[
          'FireSector Temporary Access',
          '',
          `Access Code: ${access.access_code}`,
          `Area: ${scope}`,
          `Valid until: ${new Date(access.expires_at).toLocaleString()}`,
          '',
          shareLink
            ?`Open FireSector: ${shareLink}`
            :'Open FireSector and enter the access code.'
        ].join('\n');

        window.open(
          `https://wa.me/?text=${encodeURIComponent(message)}`,
          '_blank',
          'noopener'
        );
      }
    );

  window.addEventListener(
    'resize',
    ()=>{
      if(
        !$(
          'tempAccessWorkspace'
        )
        .classList
        .contains('hidden')
      ){
        renderTempMap();
      }
    }
  );
}



// ============================================================
// V016 - TEMPORARY ACCESS RE-SHARE / EXTEND
// ============================================================

function populateTemporaryAccessShareView(access){
  const area=selectedArea();
  generatedTemporaryAccess={
    ...access,
    areaName:access.areaName||area.name
  };

  $('generatedAccessCode').textContent=
    access.access_code||'—';

  $('generatedAccessArea').textContent=
    access.scope_type==='district'
      ?generatedTemporaryAccess.areaName
      :`${access.radius_km} km radius from ${formatCoordinates({
          lat:Number(access.center_latitude),
          lon:Number(access.center_longitude)
        })}`;

  $('generatedAccessExpiry').textContent=
    formatDateTime(access.expires_at);

  updateGeneratedAccessLink();

  $('tempAccessFormView').classList.add('hidden');
  $('tempAccessResultView').classList.remove('hidden');
  $('copyStatus').textContent='';
  $('copyStatus').classList.add('hidden');
  $('tempAccessWorkspaceTitle').textContent='Temporary Access Details';

  setTempAccessView(true);
}

async function shareCurrentTemporaryAccess(){
  if(!activeTemporaryAccess){
    return;
  }

  const button=$('shareActiveAccess');
  button.disabled=true;
  button.textContent='Loading…';

  try{
    const result=await rpcCall(
      'get_temporary_access_share_details',
      {
        p_access_code_id:
          activeTemporaryAccess.access_code_id
      }
    );

    const details=Array.isArray(result)
      ?result[0]
      :result;

    if(!details){
      throw new Error('Temporary Access is no longer active.');
    }

    if(!details.access_code){
      window.alert(
        'This Temporary Access was created before secure re-sharing was enabled, so its original access code cannot be recovered. Revoke it and create a new Temporary Access if the code must be shared again.'
      );
      return;
    }

    populateTemporaryAccessShareView({
      ...details,
      areaName:selectedArea().name
    });
  }catch(error){
    window.alert(
      error.message||
      'Could not load Temporary Access details.'
    );
  }finally{
    button.disabled=false;
    button.textContent='Share Access Details';
  }
}

function setExtendAccessLocation(point,{recenter=true}={}){
  extendAccessLocation={
    lat:point.lat,
    lon:point.lon
  };

  $('extendAccessCoordinates').value=
    formatCoordinates(extendAccessLocation);

  if(recenter){
    extendAccessMap.centerLat=point.lat;
    extendAccessMap.centerLon=point.lon;
  }

  renderExtendAccessMap();
}

function renderExtendAccessMap(){
  const map=$('extendAccessMap');
  const tiles=$('extendAccessMapTiles');

  if(!map||!tiles||$('extendRadiusFields').classList.contains('hidden')){
    return;
  }

  const width=map.clientWidth;
  const height=map.clientHeight;

  if(width<10||height<10){
    return;
  }

  const z=extendAccessMap.zoom;
  const center=latLonToWorld(
    extendAccessMap.centerLat,
    extendAccessMap.centerLon,
    z
  );

  const left=center.x-width/2;
  const top=center.y-height/2;
  const minTileX=Math.floor(left/256);
  const maxTileX=Math.floor((left+width)/256);
  const minTileY=Math.floor(top/256);
  const maxTileY=Math.floor((top+height)/256);
  const tileCount=Math.pow(2,z);
  const fragment=document.createDocumentFragment();

  for(let ty=minTileY;ty<=maxTileY;ty++){
    if(ty<0||ty>=tileCount)continue;

    for(let tx=minTileX;tx<=maxTileX;tx++){
      const wrappedX=((tx%tileCount)+tileCount)%tileCount;
      const img=document.createElement('img');
      img.className='map-tile';
      img.alt='';
      img.draggable=false;
      img.src=`https://tile.openstreetmap.org/${z}/${wrappedX}/${ty}.png`;
      img.style.left=`${tx*256-left}px`;
      img.style.top=`${ty*256-top}px`;
      fragment.appendChild(img);
    }
  }

  tiles.replaceChildren(fragment);

  const radiusOverlay=$('extendAccessRadiusOverlay');
  const radiusKm=Number($('extendAccessRadiusKm').value);

  if(
    extendAccessLocation&&
    Number.isFinite(radiusKm)&&
    radiusKm>0
  ){
    const rp=latLonToWorld(
      extendAccessLocation.lat,
      extendAccessLocation.lon,
      z
    );
    const radiusPx=mapRadiusPixels(
      extendAccessLocation.lat,
      radiusKm,
      z
    );

    radiusOverlay.style.left=`${rp.x-left-radiusPx}px`;
    radiusOverlay.style.top=`${rp.y-top-radiusPx}px`;
    radiusOverlay.style.width=`${radiusPx*2}px`;
    radiusOverlay.style.height=`${radiusPx*2}px`;
    radiusOverlay.classList.remove('hidden');
  }else{
    radiusOverlay.classList.add('hidden');
  }

  const marker=$('extendAccessSelectionMarker');

  if(extendAccessLocation){
    const p=latLonToWorld(
      extendAccessLocation.lat,
      extendAccessLocation.lon,
      z
    );
    marker.style.left=`${p.x-left}px`;
    marker.style.top=`${p.y-top}px`;
    marker.classList.remove('hidden');
  }else{
    marker.classList.add('hidden');
  }
}

function extendAccessMapPointFromEvent(event){
  const map=$('extendAccessMap');
  const rect=map.getBoundingClientRect();
  const center=latLonToWorld(
    extendAccessMap.centerLat,
    extendAccessMap.centerLon,
    extendAccessMap.zoom
  );

  return worldToLatLon(
    center.x+(event.clientX-rect.left-rect.width/2),
    center.y+(event.clientY-rect.top-rect.height/2),
    extendAccessMap.zoom
  );
}

function initialiseExtendAccessMap(){
  const map=$('extendAccessMap');

  map.addEventListener('pointerdown',event=>{
    if(event.target.closest('.map-zoom-controls')){
      return;
    }

    extendAccessMap.dragging=true;
    extendAccessMap.moved=false;
    extendAccessMap.startX=event.clientX;
    extendAccessMap.startY=event.clientY;
    extendAccessMap.startCenterWorld=latLonToWorld(
      extendAccessMap.centerLat,
      extendAccessMap.centerLon,
      extendAccessMap.zoom
    );
    map.setPointerCapture(event.pointerId);
  });

  map.addEventListener('pointermove',event=>{
    if(!extendAccessMap.dragging){
      return;
    }

    const dx=event.clientX-extendAccessMap.startX;
    const dy=event.clientY-extendAccessMap.startY;

    if(Math.abs(dx)+Math.abs(dy)>5){
      extendAccessMap.moved=true;
    }

    const next=worldToLatLon(
      extendAccessMap.startCenterWorld.x-dx,
      extendAccessMap.startCenterWorld.y-dy,
      extendAccessMap.zoom
    );

    extendAccessMap.centerLat=next.lat;
    extendAccessMap.centerLon=next.lon;
    renderExtendAccessMap();
  });

  map.addEventListener('pointerup',event=>{
    if(!extendAccessMap.dragging){
      return;
    }

    extendAccessMap.dragging=false;

    if(!extendAccessMap.moved){
      setExtendAccessLocation(
        extendAccessMapPointFromEvent(event),
        {recenter:false}
      );
      $('extendAccessLocationStatus').textContent='Access centre selected.';
    }
  });

  map.addEventListener(
    'wheel',
    event=>{
      event.preventDefault();
      extendAccessMap.zoom=Math.max(
        4,
        Math.min(18,extendAccessMap.zoom+(event.deltaY<0?1:-1))
      );
      renderExtendAccessMap();
    },
    {passive:false}
  );

  $('extendAccessZoomIn').addEventListener('click',()=>{
    extendAccessMap.zoom=Math.min(18,extendAccessMap.zoom+1);
    renderExtendAccessMap();
  });

  $('extendAccessZoomOut').addEventListener('click',()=>{
    extendAccessMap.zoom=Math.max(4,extendAccessMap.zoom-1);
    renderExtendAccessMap();
  });

  $('extendAccessRadiusKm').addEventListener('input',renderExtendAccessMap);

  $('setExtendAccessCoordinates').addEventListener('click',()=>{
    const point=parseCoordinates($('extendAccessCoordinates').value);

    if(!point){
      $('extendAccessLocationStatus').textContent=
        'Enter coordinates like -28.9624455, 25.7132135';
      return;
    }

    setExtendAccessLocation(point);
    $('extendAccessLocationStatus').textContent='Access centre selected.';
  });

  $('extendAccessCoordinates').addEventListener('keydown',event=>{
    if(event.key==='Enter'){
      event.preventDefault();
      $('setExtendAccessCoordinates').click();
    }
  });

  $('useExtendCurrentLocation').addEventListener('click',()=>{
    if(!navigator.geolocation){
      $('extendAccessLocationStatus').textContent=
        'Location is not available in this browser.';
      return;
    }

    const button=$('useExtendCurrentLocation');
    button.disabled=true;
    $('extendAccessLocationStatus').textContent='Getting location…';

    navigator.geolocation.getCurrentPosition(
      position=>{
        extendAccessMap.zoom=15;
        setExtendAccessLocation({
          lat:position.coords.latitude,
          lon:position.coords.longitude
        });
        $('extendAccessLocationStatus').textContent='Current location selected.';
        button.disabled=false;
      },
      error=>{
        $('extendAccessLocationStatus').textContent=
          error.code===1
            ?'Location permission was not allowed.'
            :'Could not get current location.';
        button.disabled=false;
      },
      {
        enableHighAccuracy:true,
        timeout:12000,
        maximumAge:0
      }
    );
  });
}

function openExtendAccessModal(){
  if(!activeTemporaryAccess){
    return;
  }

  $('extendCurrentExpiry').textContent=
    formatDateTime(activeTemporaryAccess.expires_at);
  $('extendAccessMinutes').value='1440';
  $('extendAccessError').textContent='';
  $('extendAccessError').classList.add('hidden');
  $('extendAccessLocationStatus').textContent='';

  const isRadius=activeTemporaryAccess.scope_type==='radius';
  $('extendRadiusFields').classList.toggle('hidden',!isRadius);

  if(isRadius){
    const lat=Number(activeTemporaryAccess.center_latitude);
    const lon=Number(activeTemporaryAccess.center_longitude);
    const radius=Number(activeTemporaryAccess.radius_km);

    extendAccessLocation=
      Number.isFinite(lat)&&Number.isFinite(lon)
        ?{lat,lon}
        :null;

    $('extendAccessCoordinates').value=
      extendAccessLocation
        ?formatCoordinates(extendAccessLocation)
        :'';
    $('extendAccessRadiusKm').value=
      Number.isFinite(radius)&&radius>0
        ?String(radius)
        :'10';

    if(extendAccessLocation){
      extendAccessMap.centerLat=extendAccessLocation.lat;
      extendAccessMap.centerLon=extendAccessLocation.lon;
    }
    extendAccessMap.zoom=13;
  }else{
    extendAccessLocation=null;
  }

  $('extendAccessModal').classList.remove('hidden');

  if(isRadius){
    requestAnimationFrame(()=>{
      renderExtendAccessMap();
    });
  }
}

function closeExtendAccessModal(){
  extendAccessMap.dragging=false;
  $('extendAccessModal').classList.add('hidden');
}

async function extendCurrentTemporaryAccess(){
  if(!activeTemporaryAccess){
    closeExtendAccessModal();
    return;
  }

  const minutes=Number($('extendAccessMinutes').value);
  const isRadius=activeTemporaryAccess.scope_type==='radius';
  let latitude=null;
  let longitude=null;
  let radius=null;

  if(isRadius){
    const typed=parseCoordinates($('extendAccessCoordinates').value);
    if(typed){
      extendAccessLocation=typed;
    }

    radius=Number($('extendAccessRadiusKm').value);

    if(
      !extendAccessLocation||
      !Number.isFinite(radius)||
      radius<=0||
      radius>500
    ){
      $('extendAccessError').textContent=
        'Select a valid access centre and enter a radius between 0.1 km and 500 km.';
      $('extendAccessError').classList.remove('hidden');
      return;
    }

    latitude=extendAccessLocation.lat;
    longitude=extendAccessLocation.lon;
  }

  const button=$('confirmExtendAccess');

  button.disabled=true;
  button.textContent='Extending…';
  $('extendAccessError').textContent='';
  $('extendAccessError').classList.add('hidden');

  try{
    const result=await rpcCall(
      'extend_temporary_access',
      {
        p_access_code_id:activeTemporaryAccess.access_code_id,
        p_extend_minutes:minutes,
        p_center_latitude:latitude,
        p_center_longitude:longitude,
        p_radius_km:radius
      }
    );

    const updated=Array.isArray(result)
      ?result[0]
      :result;

    if(updated?.expires_at){
      activeTemporaryAccess={
        ...activeTemporaryAccess,
        expires_at:updated.expires_at,
        center_latitude:updated.center_latitude,
        center_longitude:updated.center_longitude,
        radius_km:updated.radius_km
      };
      renderActiveTemporaryAccess();
    }

    closeExtendAccessModal();
    await refreshActiveTemporaryAccess();

    if(isMapDataWorkspaceOpen()){
      await refreshMapData({quiet:true});
    }
  }catch(error){
    $('extendAccessError').textContent=
      error.message||'Could not extend Temporary Access.';
    $('extendAccessError').classList.remove('hidden');
  }finally{
    button.disabled=false;
    button.textContent='Extend Access';
  }
}

function initialiseIncidentControls(){
  initialiseExtendAccessMap();

  $('shareActiveAccess').addEventListener(
    'click',
    shareCurrentTemporaryAccess
  );

  $('extendActiveAccess').addEventListener(
    'click',
    openExtendAccessModal
  );

  $('closeExtendAccess').addEventListener(
    'click',
    closeExtendAccessModal
  );

  $('cancelExtendAccess').addEventListener(
    'click',
    closeExtendAccessModal
  );

  $('confirmExtendAccess').addEventListener(
    'click',
    extendCurrentTemporaryAccess
  );

  $('extendAccessModal').addEventListener(
    'click',
    event=>{
      if(event.target===$('extendAccessModal')){
        closeExtendAccessModal();
      }
    }
  );
}

// ============================================================
// V016 - MAP DATA WORKSPACE
// ============================================================

const mapDataMap={
  centerLat:-28.95,
  centerLon:25.70,
  zoom:11,
  dragging:false,
  moved:false,
  startX:0,
  startY:0,
  startCenterWorld:null
};

function isMapDataWorkspaceOpen(){
  return Boolean(
    $('mapDataWorkspace') &&
    !$('mapDataWorkspace').classList.contains('hidden')
  );
}

function setMapDataView(open){
  if(!open){
    setTempAccessView(false);
    return;
  }

  $('dashboardHome').classList.add('hidden');
  $('tempAccessWorkspace').classList.add('hidden');
  $('mapDataWorkspace').classList.remove('hidden');

  document
    .querySelectorAll('nav .nav')
    .forEach(item=>item.classList.remove('active'));

  $('mapDataNav').classList.add('active');
}

function closeMapDataWorkspace(){
  if(!$('mapDataWorkspace')){
    return;
  }

  $('mapDataWorkspace').classList.add('hidden');
  closeMapDataEditor();

  if(
    $('dashboardHome').classList.contains('hidden') &&
    $('tempAccessWorkspace').classList.contains('hidden')
  ){
    $('dashboardHome').classList.remove('hidden');
    document
      .querySelectorAll('nav .nav')
      .forEach(item=>item.classList.remove('active'));
    $('dashboardNav').classList.add('active');
  }
}

function mapDataTypeLabel(type){
  switch(type){
    case 'water': return 'Water Point';
    case 'gate': return 'Gate';
    case 'landmark': return 'Landmark';
    case 'fire': return 'Fire Point';
    default: return 'Map Item';
  }
}

const WATER_POINT_TYPES=[
  'Tank',
  'Cement Dam / Reservoir',
  'Earth Dam',
  'Borehole',
  'Windpump',
  'Water Trough',
  'River / Stream',
  'Other'
];

const WATER_QUALITY_OPTIONS=[
  'Clean',
  'Untreated / Dirty',
  'Unknown'
];

const WATER_AVAILABILITY_OPTIONS=[
  'Always Available',
  'Usually Available',
  'Sometimes Available',
  'Rarely Available',
  'Seasonal',
  'Currently Unavailable',
  'Unknown'
];

const GATE_TYPE_OPTIONS=[
  'Main Entrance',
  'Farm Gate',
  'Cattle Gate',
  'Security Gate',
  'Boom Gate',
  'Electric Gate',
  'Other'
];

const GATE_ACCESS_OPTIONS=[
  'Open / No Restriction',
  'Usually Unlocked',
  'Locked – Key Required',
  'Locked – Code Required',
  'Electric / Remote Access',
  'Blocked / Not Usable',
  'Unknown'
];

const LANDMARK_VISIBILITY_OPTIONS=[
  'Clearly Visible',
  'Usually Visible',
  'Difficult to See',
  'Not Visible at Night',
  'Seasonal / May Change',
  'Unknown'
];

function normaliseMapDataItem(item,kind){
  return {
    id:String(item?.id||''),
    marker_type:String(item?.marker_type||'').toLowerCase(),
    name:item?.name||'',
    latitude:Number(item?.latitude),
    longitude:Number(item?.longitude),
    status:item?.status||'',
    subtype:item?.subtype||'',
    availability:item?.availability||'',
    notes:item?.notes||'',
    farm_id:item?.farm_id?String(item.farm_id):'',
    farm_name:item?.farm_name||'',
    updated_at:item?.updated_at||null,
    kind
  };
}

function mapDataAllItems(){
  return [
    ...mapDataFirePoints,
    ...mapDataPermanentMarkers
  ];
}

function normaliseFarmSearchText(value){
  return String(value||'')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,'')
    .trim();
}

function levenshteinDistance(a,b){
  if(a===b)return 0;
  if(!a.length)return b.length;
  if(!b.length)return a.length;

  let previous=Array.from({length:b.length+1},(_,index)=>index);

  for(let i=1;i<=a.length;i++){
    const current=[i];
    for(let j=1;j<=b.length;j++){
      const cost=a[i-1]===b[j-1]?0:1;
      current[j]=Math.min(
        current[j-1]+1,
        previous[j]+1,
        previous[j-1]+cost
      );
    }
    previous=current;
  }

  return previous[b.length];
}

function farmNameMatchesQuery(farmName,query){
  const farm=normaliseFarmSearchText(farmName);
  const wanted=normaliseFarmSearchText(query);

  if(!wanted)return true;
  if(!farm)return false;
  if(farm.includes(wanted) || wanted.includes(farm))return true;

  const threshold=wanted.length<=4?1:Math.max(1,Math.floor(wanted.length*0.28));
  return levenshteinDistance(farm,wanted)<=threshold;
}

function mapDataVisibleItems(){
  const query=mapDataFarmSearchQuery.trim();
  if(!query){
    return mapDataAllItems();
  }

  return mapDataPermanentMarkers.filter(item=>
    farmNameMatchesQuery(item.farm_name,query)
  );
}

function fillSelectOptions(select,options,value,{blankLabel=null}={}){
  select.innerHTML='';

  if(blankLabel!==null){
    const blank=document.createElement('option');
    blank.value='';
    blank.textContent=blankLabel;
    select.appendChild(blank);
  }

  for(const optionValue of options){
    const option=document.createElement('option');
    option.value=optionValue;
    option.textContent=optionValue;
    select.appendChild(option);
  }

  if(value && !options.includes(value)){
    const existing=document.createElement('option');
    existing.value=value;
    existing.textContent=`${value} (existing)`;
    select.appendChild(existing);
  }

  if(value){
    select.value=value;
  }else if(blankLabel===null && options.length){
    select.value=options[0];
  }
}

function populateMapDataFarmSelect(selectedValue=''){
  const select=$('mapDataFarm');
  select.innerHTML='';

  const none=document.createElement('option');
  none.value='';
  none.textContent='Not linked to a farm';
  select.appendChild(none);

  for(const farm of mapDataFarms){
    const option=document.createElement('option');
    option.value=farm.id;
    option.textContent=farm.name||'Unnamed farm';
    select.appendChild(option);
  }

  if(selectedValue && !mapDataFarms.some(farm=>farm.id===selectedValue)){
    const existing=document.createElement('option');
    existing.value=selectedValue;
    existing.textContent='Linked farm';
    select.appendChild(existing);
  }

  select.value=selectedValue||'';
}

function showMapDataError(message){
  $('mapDataError').textContent=message;
  $('mapDataError').classList.remove('hidden');
}

function clearMapDataError(){
  $('mapDataError').textContent='';
  $('mapDataError').classList.add('hidden');
}

async function openMapDataWorkspace(){
  const area=selectedArea();

  if(!area.id){
    window.alert('Select an area first.');
    return;
  }

  $('mapDataAreaLabel').textContent=area.name;
  mapDataInitialCenterSet=false;
  mapDataFarmSearchQuery='';
  if($('mapDataFarmSearch')){
    $('mapDataFarmSearch').value='';
  }
  setMapDataView(true);
  closeMapDataEditor();

  await refreshMapData();

  requestAnimationFrame(renderMapDataMap);
}

async function refreshMapData({quiet=false}={}){
  if(mapDataLoadRunning || !accessToken){
    return;
  }

  const area=selectedArea();
  if(!area.id){
    return;
  }

  mapDataLoadRunning=true;
  const button=$('refreshMapData');

  if(!quiet){
    button.disabled=true;
    button.textContent='Refreshing…';
  }

  try{
    const result=await rpcCall(
      'get_firesector_admin_map_data',
      {p_district_id:area.id}
    );

    const payload=
      Array.isArray(result)
        ?result[0]
        :result;

    if(!payload || typeof payload!=='object'){
      throw new Error('Invalid Map Data response.');
    }

    mapDataPayload=payload;
    mapDataFarms=Array.isArray(payload.farms)
      ?payload.farms
        .map(farm=>({
          id:String(farm?.id||''),
          name:String(farm?.name||'').trim()
        }))
        .filter(farm=>farm.id && farm.name)
      :[];

    mapDataPermanentMarkers=
      Array.isArray(payload.markers)
        ?payload.markers
          .map(item=>normaliseMapDataItem(item,'permanent'))
          .filter(item=>item.id && Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
        :[];

    mapDataActiveAccess=payload.active_access||null;

    mapDataFirePoints=
      Array.isArray(mapDataActiveAccess?.fire_points)
        ?mapDataActiveAccess.fire_points
          .map(item=>normaliseMapDataItem(item,'fire'))
          .filter(item=>item.id && Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
        :[];

    clearMapDataError();
    updateMapDataIncidentState();
    renderMapDataItems();

    if(!mapDataInitialCenterSet){
      if(mapDataActiveAccess?.scope_type==='radius'){
        const lat=Number(mapDataActiveAccess.center_latitude);
        const lon=Number(mapDataActiveAccess.center_longitude);
        if(Number.isFinite(lat) && Number.isFinite(lon)){
          mapDataMap.centerLat=lat;
          mapDataMap.centerLon=lon;
          if(mapDataMap.zoom<11){
            mapDataMap.zoom=11;
          }
        }
      }else if(mapDataAllItems().length){
        const first=mapDataAllItems()[0];
        mapDataMap.centerLat=first.latitude;
        mapDataMap.centerLon=first.longitude;
      }

      mapDataInitialCenterSet=true;
    }

    renderMapDataMap();
  }catch(error){
    if(!quiet){
      showMapDataError(
        error.message||'Could not load Map Data.'
      );
    }
  }finally{
    mapDataLoadRunning=false;
    if(!quiet){
      button.disabled=false;
      button.textContent='Refresh';
    }
  }
}

function updateMapDataIncidentState(){
  const note=$('mapDataIncidentNote');
  const fireButtons=[
    $('addFirePoint'),
    $('mobileAddFirePoint')
  ].filter(Boolean);

  if(!mapDataActiveAccess){
    note.textContent=
      'No active Temporary Access. Fire Points can only be created during an active incident.';
    fireButtons.forEach(button=>button.disabled=true);
    return;
  }

  fireButtons.forEach(button=>button.disabled=false);

  if(mapDataActiveAccess.scope_type==='radius'){
    const radius=Number(mapDataActiveAccess.radius_km);
    note.textContent=
      `Active incident • ${Number.isFinite(radius)?radius:'—'} km radius • Fire Points disappear when access ends.`;
  }else{
    note.textContent=
      'Active incident • Entire current area • Fire Points disappear when access ends.';
  }
}

function renderMapDataItems(){
  const container=$('mapDataItems');
  const items=mapDataVisibleItems();
  const status=$('mapDataSearchStatus');
  const query=mapDataFarmSearchQuery.trim();

  if(status){
    if(query){
      const matchingFarms=mapDataFarms
        .filter(farm=>farmNameMatchesQuery(farm.name,query))
        .map(farm=>farm.name);

      if(matchingFarms.length){
        status.textContent=`${items.length} marker${items.length===1?'':'s'} • ${matchingFarms.slice(0,3).join(', ')}`;
      }else{
        status.textContent='No close farm-name match.';
      }
    }else{
      status.textContent='Filters live while you type. Small spelling mistakes are allowed.';
    }
  }

  if(!items.length){
    const empty=document.createElement('div');
    empty.className='mapdata-empty';
    empty.textContent=query
      ?'No markers match that farm name.'
      :'No Map Data has been added for this Area yet.';
    container.replaceChildren(empty);
    return;
  }

  const fragment=document.createDocumentFragment();

  for(const item of items){
    const button=document.createElement('button');
    button.type='button';
    button.className='mapdata-item';

    const dot=document.createElement('span');
    dot.className=`mapdata-item-dot ${item.marker_type}`;

    const copy=document.createElement('span');
    copy.className='mapdata-item-copy';

    const name=document.createElement('strong');
    name.textContent=item.name||mapDataTypeLabel(item.marker_type);

    const detail=document.createElement('span');
    const farmPrefix=item.farm_name?`${item.farm_name} • `:'';
    detail.textContent=
      `${farmPrefix}${mapDataTypeLabel(item.marker_type)} • ${item.latitude.toFixed(5)}, ${item.longitude.toFixed(5)}`;

    const edit=document.createElement('span');
    edit.className='mapdata-item-edit';
    edit.textContent='Edit';

    copy.append(name,detail);
    button.append(dot,copy,edit);

    button.addEventListener('click',()=>{
      openMapDataEditor(item.marker_type,item);
    });

    fragment.appendChild(button);
  }

  container.replaceChildren(fragment);
}

function renderMapDataMap(){
  const map=$('mapDataMap');
  const tiles=$('mapDataTiles');
  const markerLayer=$('mapDataMarkers');

  if(!map || !tiles || !markerLayer){
    return;
  }

  const width=map.clientWidth;
  const height=map.clientHeight;

  if(width<10 || height<10){
    return;
  }

  const z=mapDataMap.zoom;
  const center=latLonToWorld(
    mapDataMap.centerLat,
    mapDataMap.centerLon,
    z
  );

  const left=center.x-width/2;
  const top=center.y-height/2;
  const minTileX=Math.floor(left/256);
  const maxTileX=Math.floor((left+width)/256);
  const minTileY=Math.floor(top/256);
  const maxTileY=Math.floor((top+height)/256);
  const tileCount=Math.pow(2,z);
  const tileFragment=document.createDocumentFragment();

  for(let ty=minTileY;ty<=maxTileY;ty++){
    if(ty<0 || ty>=tileCount){
      continue;
    }

    for(let tx=minTileX;tx<=maxTileX;tx++){
      const wrappedX=((tx%tileCount)+tileCount)%tileCount;
      const img=document.createElement('img');
      img.className='map-tile';
      img.alt='';
      img.draggable=false;
      img.src=`https://tile.openstreetmap.org/${z}/${wrappedX}/${ty}.png`;
      img.style.left=`${tx*256-left}px`;
      img.style.top=`${ty*256-top}px`;
      tileFragment.appendChild(img);
    }
  }

  tiles.replaceChildren(tileFragment);

  const radiusOverlay=$('mapDataRadiusOverlay');
  const radiusAccess=mapDataActiveAccess?.scope_type==='radius';
  const radiusLat=Number(mapDataActiveAccess?.center_latitude);
  const radiusLon=Number(mapDataActiveAccess?.center_longitude);
  const radiusKm=Number(mapDataActiveAccess?.radius_km);

  if(
    radiusAccess &&
    Number.isFinite(radiusLat) &&
    Number.isFinite(radiusLon) &&
    Number.isFinite(radiusKm) &&
    radiusKm>0
  ){
    const rp=latLonToWorld(radiusLat,radiusLon,z);
    const radiusPx=mapRadiusPixels(radiusLat,radiusKm,z);
    radiusOverlay.style.left=`${rp.x-left-radiusPx}px`;
    radiusOverlay.style.top=`${rp.y-top-radiusPx}px`;
    radiusOverlay.style.width=`${radiusPx*2}px`;
    radiusOverlay.style.height=`${radiusPx*2}px`;
    radiusOverlay.classList.remove('hidden');
  }else{
    radiusOverlay.classList.add('hidden');
  }

  const markerFragment=document.createDocumentFragment();

  for(const item of mapDataVisibleItems()){
    const p=latLonToWorld(item.latitude,item.longitude,z);
    const marker=document.createElement('button');
    marker.type='button';
    marker.className=`map-data-marker ${item.marker_type}`;
    if(mapDataEditing?.id===item.id){
      marker.classList.add('selected');
    }
    marker.style.left=`${p.x-left}px`;
    marker.style.top=`${p.y-top}px`;
    marker.title=`${mapDataTypeLabel(item.marker_type)}: ${item.name||'Unnamed'}`;
    marker.setAttribute('aria-label',marker.title);

    marker.addEventListener('pointerdown',event=>event.stopPropagation());
    marker.addEventListener('click',event=>{
      event.stopPropagation();
      openMapDataEditor(item.marker_type,item);
    });

    markerFragment.appendChild(marker);
  }

  if(mapDataEditing && mapDataSelectedLocation){
    const previewPoint=latLonToWorld(
      mapDataSelectedLocation.lat,
      mapDataSelectedLocation.lon,
      z
    );
    const preview=document.createElement('span');
    preview.className=`map-data-marker ${mapDataEditing.markerType} preview`;
    preview.style.left=`${previewPoint.x-left}px`;
    preview.style.top=`${previewPoint.y-top}px`;
    preview.setAttribute('aria-hidden','true');
    markerFragment.appendChild(preview);
  }

  markerLayer.replaceChildren(markerFragment);
}

function mapDataPointFromEvent(event){
  const map=$('mapDataMap');
  const rect=map.getBoundingClientRect();
  const center=latLonToWorld(
    mapDataMap.centerLat,
    mapDataMap.centerLon,
    mapDataMap.zoom
  );

  return worldToLatLon(
    center.x+(event.clientX-rect.left-rect.width/2),
    center.y+(event.clientY-rect.top-rect.height/2),
    mapDataMap.zoom
  );
}

function setMapDataSelectedLocation(point,{recenter=false}={}){
  mapDataSelectedLocation={
    lat:Number(point.lat),
    lon:Number(point.lon)
  };

  $('mapDataCoordinates').value=
    formatCoordinates(mapDataSelectedLocation);

  if(recenter){
    mapDataMap.centerLat=mapDataSelectedLocation.lat;
    mapDataMap.centerLon=mapDataSelectedLocation.lon;
  }

  $('mapDataLocationStatus').textContent='Location selected.';
  renderMapDataMap();
}

function updateMapDataEditorFields(item=null){
  const type=$('mapDataType').value;
  const isFire=type==='fire';
  const isWater=type==='water';
  const isGate=type==='gate';
  const isLandmark=type==='landmark';

  $('mapDataFarmField').classList.toggle('hidden',isFire);
  $('mapDataStatusField').classList.toggle('hidden',isFire);
  $('mapDataSubtypeSelectField').classList.toggle('hidden',isFire||isLandmark);
  $('mapDataSubtypeTextField').classList.toggle('hidden',!isLandmark);
  $('mapDataAvailabilityField').classList.toggle('hidden',!isWater);

  populateMapDataFarmSelect(item?.farm_id||'');

  if(isWater){
    $('mapDataStatusLabel').textContent='Water quality';
    $('mapDataSubtypeSelectLabel').textContent='Water point type';
    fillSelectOptions(
      $('mapDataStatus'),
      WATER_QUALITY_OPTIONS,
      item?.status||'Unknown'
    );
    fillSelectOptions(
      $('mapDataSubtype'),
      WATER_POINT_TYPES,
      item?.subtype||'Tank'
    );
    fillSelectOptions(
      $('mapDataAvailability'),
      WATER_AVAILABILITY_OPTIONS,
      item?.availability||'Unknown'
    );
  }else if(isGate){
    $('mapDataStatusLabel').textContent='Access';
    $('mapDataSubtypeSelectLabel').textContent='Gate type';
    fillSelectOptions(
      $('mapDataStatus'),
      GATE_ACCESS_OPTIONS,
      item?.status||'Unknown'
    );
    fillSelectOptions(
      $('mapDataSubtype'),
      GATE_TYPE_OPTIONS,
      item?.subtype||'Farm Gate'
    );
  }else if(isLandmark){
    $('mapDataStatusLabel').textContent='Visibility';
    $('mapDataSubtypeTextLabel').textContent='Landmark type';
    fillSelectOptions(
      $('mapDataStatus'),
      LANDMARK_VISIBILITY_OPTIONS,
      item?.status||'Unknown'
    );
    $('mapDataSubtypeText').value=item?.subtype||'';
  }
}

function openMapDataEditor(type,item=null){
  if(type==='fire' && !mapDataActiveAccess){
    window.alert('Create Temporary Access before adding Fire Points.');
    return;
  }

  const kind=type==='fire'?'fire':'permanent';
  mapDataEditing={
    kind,
    id:item?.id||null,
    markerType:type,
    original:item||null
  };

  mapDataSelectedLocation=null;
  $('mapDataListView').classList.add('hidden');
  $('mapDataEditor').classList.remove('hidden');
  $('mapDataEditorKicker').textContent=type==='fire'?'INCIDENT FIRE POINT':'AREA MAP DATA';
  $('mapDataEditorTitle').textContent=
    `${item?'Edit':'Add'} ${mapDataTypeLabel(type)}`;

  $('mapDataType').value=type;
  $('mapDataType').disabled=true;
  $('mapDataName').value=item?.name||'';
  $('mapDataNotes').value=item?.notes||'';
  $('mapDataEditorError').textContent='';
  $('mapDataEditorError').classList.add('hidden');
  $('mapDataLocationStatus').textContent='';
  $('deleteMapDataItem').classList.toggle('hidden',!item);

  if(item){
    setMapDataSelectedLocation(
      {lat:item.latitude,lon:item.longitude},
      {recenter:true}
    );
    mapDataMap.zoom=Math.max(mapDataMap.zoom,14);
    renderMapDataMap();
  }else{
    $('mapDataCoordinates').value='';
  }

  updateMapDataEditorFields(item);
}

function closeMapDataEditor(){
  if(!$('mapDataEditor')){
    return;
  }

  mapDataEditing=null;
  mapDataSelectedLocation=null;
  $('mapDataEditor').classList.add('hidden');
  $('mapDataListView').classList.remove('hidden');
  $('mapDataEditorError').textContent='';
  $('mapDataEditorError').classList.add('hidden');
  $('mapDataType').disabled=false;
  renderMapDataMap();
}

function showMapDataEditorError(message){
  $('mapDataEditorError').textContent=message;
  $('mapDataEditorError').classList.remove('hidden');
}

async function saveCurrentMapDataItem(){
  if(!mapDataEditing){
    return;
  }

  const typed=parseCoordinates($('mapDataCoordinates').value);
  if(typed){
    mapDataSelectedLocation=typed;
  }

  if(!mapDataSelectedLocation){
    showMapDataEditorError('Select a location on the map or enter coordinates.');
    return;
  }

  const area=selectedArea();
  const type=mapDataEditing.markerType;
  const button=$('saveMapDataItem');

  button.disabled=true;
  button.textContent='Saving…';
  $('mapDataEditorError').textContent='';
  $('mapDataEditorError').classList.add('hidden');

  try{
    if(mapDataEditing.kind==='fire'){
      if(!mapDataActiveAccess?.access_code_id){
        throw new Error('Temporary Access is no longer active.');
      }

      await rpcCall(
        'save_firesector_fire_point',
        {
          p_access_code_id:mapDataActiveAccess.access_code_id,
          p_name:$('mapDataName').value.trim(),
          p_latitude:mapDataSelectedLocation.lat,
          p_longitude:mapDataSelectedLocation.lon,
          p_notes:$('mapDataNotes').value.trim(),
          p_fire_point_id:mapDataEditing.id
        }
      );
    }else{
      await rpcCall(
        'save_firesector_map_marker',
        {
          p_district_id:area.id,
          p_marker_type:type,
          p_name:$('mapDataName').value.trim(),
          p_latitude:mapDataSelectedLocation.lat,
          p_longitude:mapDataSelectedLocation.lon,
          p_status:$('mapDataStatus').value.trim(),
          p_subtype:type==='landmark'
            ?$('mapDataSubtypeText').value.trim()
            :$('mapDataSubtype').value.trim(),
          p_availability:type==='water'
            ?$('mapDataAvailability').value.trim()
            :null,
          p_farm_id:$('mapDataFarm').value||null,
          p_notes:$('mapDataNotes').value.trim(),
          p_marker_id:mapDataEditing.id
        }
      );
    }

    closeMapDataEditor();
    await refreshMapData();
  }catch(error){
    showMapDataEditorError(
      error.message||'Could not save Map Data.'
    );
  }finally{
    button.disabled=false;
    button.textContent='Save';
  }
}

async function deleteCurrentMapDataItem(){
  if(!mapDataEditing?.id){
    return;
  }

  const label=mapDataTypeLabel(mapDataEditing.markerType);
  if(!window.confirm(`Delete this ${label}?`)){
    return;
  }

  const button=$('deleteMapDataItem');
  button.disabled=true;
  button.textContent='Deleting…';

  try{
    if(mapDataEditing.kind==='fire'){
      await rpcCall(
        'delete_firesector_fire_point',
        {p_fire_point_id:mapDataEditing.id}
      );
    }else{
      await rpcCall(
        'delete_firesector_map_marker',
        {p_marker_id:mapDataEditing.id}
      );
    }

    closeMapDataEditor();
    await refreshMapData();
  }catch(error){
    showMapDataEditorError(
      error.message||'Could not delete Map Data.'
    );
  }finally{
    button.disabled=false;
    button.textContent='Delete';
  }
}

function initialiseMapDataMap(){
  const map=$('mapDataMap');

  map.addEventListener('pointerdown',event=>{
    if(event.target.closest('.map-zoom-controls,.map-data-marker')){
      return;
    }

    mapDataMap.dragging=true;
    mapDataMap.moved=false;
    mapDataMap.startX=event.clientX;
    mapDataMap.startY=event.clientY;
    mapDataMap.startCenterWorld=latLonToWorld(
      mapDataMap.centerLat,
      mapDataMap.centerLon,
      mapDataMap.zoom
    );
    map.setPointerCapture(event.pointerId);
  });

  map.addEventListener('pointermove',event=>{
    if(!mapDataMap.dragging){
      return;
    }

    const dx=event.clientX-mapDataMap.startX;
    const dy=event.clientY-mapDataMap.startY;

    if(Math.abs(dx)+Math.abs(dy)>5){
      mapDataMap.moved=true;
    }

    const next=worldToLatLon(
      mapDataMap.startCenterWorld.x-dx,
      mapDataMap.startCenterWorld.y-dy,
      mapDataMap.zoom
    );

    mapDataMap.centerLat=next.lat;
    mapDataMap.centerLon=next.lon;
    renderMapDataMap();
  });

  map.addEventListener('pointerup',event=>{
    if(!mapDataMap.dragging){
      return;
    }

    mapDataMap.dragging=false;

    if(!mapDataMap.moved && mapDataEditing){
      setMapDataSelectedLocation(
        mapDataPointFromEvent(event)
      );
    }
  });

  map.addEventListener(
    'wheel',
    event=>{
      event.preventDefault();
      mapDataMap.zoom=Math.max(
        4,
        Math.min(
          18,
          mapDataMap.zoom+(event.deltaY<0?1:-1)
        )
      );
      renderMapDataMap();
    },
    {passive:false}
  );

  $('mapDataZoomIn').addEventListener('click',()=>{
    mapDataMap.zoom=Math.min(18,mapDataMap.zoom+1);
    renderMapDataMap();
  });

  $('mapDataZoomOut').addEventListener('click',()=>{
    mapDataMap.zoom=Math.max(4,mapDataMap.zoom-1);
    renderMapDataMap();
  });
}

function initialiseMapData(){
  initialiseMapDataMap();

  $('mapDataNav').addEventListener('click',openMapDataWorkspace);
  $('manageMapDataBtn').addEventListener('click',openMapDataWorkspace);
  $('closeMapData').addEventListener('click',closeMapDataWorkspace);
  $('refreshMapData').addEventListener('click',()=>refreshMapData());
  $('dashboardNav').addEventListener('click',closeMapDataWorkspace);

  $('addWaterPoint').addEventListener('click',()=>openMapDataEditor('water'));
  $('addGate').addEventListener('click',()=>openMapDataEditor('gate'));
  $('addLandmark').addEventListener('click',()=>openMapDataEditor('landmark'));
  $('addFirePoint').addEventListener('click',()=>openMapDataEditor('fire'));
  $('mobileAddWaterPoint').addEventListener('click',()=>openMapDataEditor('water'));
  $('mobileAddGate').addEventListener('click',()=>openMapDataEditor('gate'));
  $('mobileAddLandmark').addEventListener('click',()=>openMapDataEditor('landmark'));
  $('mobileAddFirePoint').addEventListener('click',()=>openMapDataEditor('fire'));

  $('mapDataFarmSearch').addEventListener('input',event=>{
    mapDataFarmSearchQuery=event.target.value||'';
    renderMapDataItems();
    renderMapDataMap();
  });

  $('cancelMapDataEdit').addEventListener('click',closeMapDataEditor);
  $('cancelMapDataEditBottom').addEventListener('click',closeMapDataEditor);
  $('saveMapDataItem').addEventListener('click',saveCurrentMapDataItem);
  $('deleteMapDataItem').addEventListener('click',deleteCurrentMapDataItem);

  $('setMapDataCoordinates').addEventListener('click',()=>{
    const point=parseCoordinates($('mapDataCoordinates').value);

    if(!point){
      $('mapDataLocationStatus').textContent=
        'Enter coordinates like -28.9624455, 25.7132135';
      return;
    }

    setMapDataSelectedLocation(point,{recenter:true});
  });

  $('mapDataCoordinates').addEventListener('keydown',event=>{
    if(event.key==='Enter'){
      event.preventDefault();
      $('setMapDataCoordinates').click();
    }
  });

  $('useMapDataCurrentLocation').addEventListener('click',()=>{
    if(!navigator.geolocation){
      $('mapDataLocationStatus').textContent=
        'Location is not available in this browser.';
      return;
    }

    const button=$('useMapDataCurrentLocation');
    button.disabled=true;
    $('mapDataLocationStatus').textContent='Getting location…';

    navigator.geolocation.getCurrentPosition(
      position=>{
        mapDataMap.zoom=15;
        setMapDataSelectedLocation(
          {
            lat:position.coords.latitude,
            lon:position.coords.longitude
          },
          {recenter:true}
        );
        $('mapDataLocationStatus').textContent='Current location selected.';
        button.disabled=false;
      },
      error=>{
        $('mapDataLocationStatus').textContent=
          error.code===1
            ?'Location permission was not allowed.'
            :'Could not get current location.';
        button.disabled=false;
      },
      {
        enableHighAccuracy:true,
        timeout:12000,
        maximumAge:0
      }
    );
  });

  window.addEventListener('resize',()=>{
    if(isMapDataWorkspaceOpen()){
      renderMapDataMap();
    }
  });
}

let fireSectorOpenAutoTimer=null;

function showFireSectorOpenBridge(accessCode){
  const code=normaliseSharedAccessCode(accessCode);

  if(!code){
    return false;
  }

  clearSession();
  show('openFireSector');
  $('openFireSectorCode').textContent=code;
  $('openFireSectorStatus').textContent='Opening the FireSector Emergency app…';

  const schemeLink=buildFireSectorSchemeLink(code);

  if(fireSectorOpenAutoTimer){
    clearTimeout(fireSectorOpenAutoTimer);
  }

  fireSectorOpenAutoTimer=setTimeout(()=>{
    fireSectorOpenAutoTimer=null;
    $('openFireSectorStatus').textContent=
      'If FireSector did not open automatically, tap Open FireSector below.';

    try{
      window.location.href=schemeLink;
    }catch(_){
      // The visible Open FireSector button remains available as fallback.
    }
  },300);

  return true;
}

function initialiseFireSectorOpenBridge(){
  $('openFireSectorApp').addEventListener('click',()=>{
    const code=normaliseSharedAccessCode($('openFireSectorCode').textContent);
    if(!code)return;

    $('openFireSectorStatus').textContent='Opening FireSector…';
    window.location.href=buildFireSectorSchemeLink(code);
  });

  $('copyOpenFireSectorCode').addEventListener('click',async()=>{
    const code=normaliseSharedAccessCode($('openFireSectorCode').textContent);
    if(!code)return;

    try{
      await navigator.clipboard.writeText(code);
      $('openFireSectorStatus').textContent='Access code copied.';
    }catch(_){
      $('openFireSectorStatus').textContent=
        `Access code: ${code}`;
    }
  });

  $('openAdminInstead').addEventListener('click',()=>{
    if(fireSectorOpenAutoTimer){
      clearTimeout(fireSectorOpenAutoTimer);
      fireSectorOpenAutoTimer=null;
    }

    const clean=new URL(window.location.href);
    clean.search='';
    clean.hash='';
    window.history.replaceState({},'',clean.toString());
    startup();
  });
}

async function startup(){
  const sharedCode=sharedAccessCodeFromLocation();
  if(sharedCode){
    showFireSectorOpenBridge(sharedCode);
    return;
  }
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

initialiseFireSectorOpenBridge();
initialiseTemporaryAccess();
initialiseIncidentControls();
initialiseMapData();
startup();
