const normalize = value => ({
  imageDataUrl: /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value?.imageDataUrl ?? '') ? value.imageDataUrl : '',
  name: typeof value?.name === 'string' ? value.name : '',
  strength: Number.isFinite(value?.strength) ? Math.max(0,Math.min(100,Math.round(value.strength))) : 40,
});

export function initAppearance({ modal, closeModal, toast, escapeHtml, icon }) {
  const desktop = window.desktop, button = document.getElementById('appearance-button');
  if (!desktop?.chooseBackground) { button.hidden = true; return; }
  let appearance = normalize(desktop.initialAppearance), saving;
  const layer = document.getElementById('app-background');
  function apply() {
    layer.style.backgroundImage = appearance.imageDataUrl ? `url("${appearance.imageDataUrl}")` : '';
    layer.style.opacity = String(appearance.strength / 100);
    document.body.classList.toggle('has-wallpaper', !!appearance.imageDataUrl);
  }
  function render() {
    modal('外观与背景', `<p class="modal-description">选择自己的图片作为应用背景。效果立即生效，重启后也会保留。</p>
      <div class="appearance-preview${appearance.imageDataUrl ? ' has-image' : ''}" id="appearance-preview" role="img" aria-label="背景图片预览"><span>${icon('image')}<strong>默认背景</strong></span></div>
      <div class="appearance-file"><span id="appearance-name">${escapeHtml(appearance.name || '还没有选择图片')}</span><div class="button-row"><button class="button primary" id="appearance-choose">${icon('image')}选择图片</button><button class="button" id="appearance-reset" ${appearance.imageDataUrl ? '' : 'disabled'}>恢复默认</button></div></div>
      <div class="appearance-slider"><label for="appearance-strength">背景显示强度</label><output id="appearance-strength-value" for="appearance-strength">${appearance.strength}%</output><input id="appearance-strength" type="range" min="0" max="100" step="1" value="${appearance.strength}" ${appearance.imageDataUrl ? '' : 'disabled'} aria-describedby="appearance-help"></div>
      <p class="subtle" id="appearance-help">强度越低，背景越淡。界面保留柔和遮罩，便于阅读。支持 PNG、JPG，最大 20 MB。</p>
      <p class="appearance-note">图片仅保存在本机，不会发送给模型。</p><p id="appearance-error" class="inline-error" role="alert" hidden></p>
      <div class="modal-actions"><button class="button" id="appearance-done">完成</button></div>`);
    const preview = document.getElementById('appearance-preview');
    preview.style.backgroundImage = appearance.imageDataUrl ? `url("${appearance.imageDataUrl}")` : '';
    const choose = document.getElementById('appearance-choose'), reset = document.getElementById('appearance-reset');
    const error = message => { const el = document.getElementById('appearance-error'); if(el){el.hidden=false;el.textContent=message;} };
    document.getElementById('appearance-done').addEventListener('click',closeModal);
    choose.addEventListener('click',async()=>{
      clearTimeout(saving); choose.disabled=true; reset.disabled=true; choose.textContent='正在选择…';
      try {
        await desktop.setBackgroundStrength(appearance.strength);
        const result=await desktop.chooseBackground();
        if(!result?.canceled){appearance=normalize(result);apply();toast('背景已更新。');}
        if(document.getElementById('modal').open)render();
      }catch(e){choose.disabled=false;reset.disabled=!appearance.imageDataUrl;choose.innerHTML=icon('image')+'选择图片';error(e.message || '图片选择失败，请重试。');}
    });
    reset.addEventListener('click',async()=>{
      clearTimeout(saving);reset.disabled=true;
      try{appearance=normalize(await desktop.resetBackground());apply();render();toast('已恢复默认背景。');}catch(e){reset.disabled=false;error(e.message||'恢复默认失败，请重试。');}
    });
    document.getElementById('appearance-strength').addEventListener('input',event=>{
      appearance.strength=Number(event.target.value);document.getElementById('appearance-strength-value').textContent=appearance.strength+'%';apply();
      clearTimeout(saving);const value=appearance.strength;
      saving=setTimeout(()=>desktop.setBackgroundStrength(value).catch(e=>error(e.message||'外观设置保存失败，请重试。')),150);
    });
  }
  apply();button.addEventListener('click',render);
}
