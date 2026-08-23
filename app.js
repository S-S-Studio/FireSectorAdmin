/* FireSector Admin app.js V010 */
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
  }
}

async function refreshActiveTemporaryAccess(){
  if(
    activeAccessRefreshRunning ||
    !accessToken
  ){
    return;
  }

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
    'mapZoomIn',
    'mapZoomOut',
    'tempCoordinates',
    'applyCoordinates',
    'tempRadiusKm',
    'tempValidity',
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
    'copyStatus',
    'returnToDashboard',
    'copyAccessCode',
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

        if(radius){
          requestAnimationFrame(
            renderTempMap
          );
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

        const message=[
          'FireSector Temporary Access',
          '',
          `Access Code: ${access.access_code}`,
          `Area: ${scope}`,
          `Valid until: ${new Date(access.expires_at).toLocaleString()}`,
          '',
          'Open FireSector and enter the access code.'
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

initialiseTemporaryAccess();
startup();
