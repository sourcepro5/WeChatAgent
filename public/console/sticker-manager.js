// 未命名、无描述的收集表情由服务器命名为"聊天收集的表情 + 编号前 6 位"，各张看起来都一样
export const isGeneratedStickerName = item => item.name === '聊天收集的表情 ' + String(item.id).slice(0, 6);
// 展示用名称：自动生成的名字改为前几个标签，没有标签时显示收集日期（addedAt 为秒或毫秒）
export function stickerTitle(item) {
  if (!isGeneratedStickerName(item)) return item.name;
  if (item.tags?.length) return item.tags.slice(0, 3).join(' · ');
  const at = Number(item.addedAt);
  if (!Number.isFinite(at) || at <= 0) return '未命名表情';
  const date = new Date(at < 1e12 ? at * 1000 : at);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日收集的表情`;
}
export function parseStickerTags(value) {
  const tags = [
    ...new Set(
      value
        .split(/[,，]/)
        .map(tag => tag.trim())
        .filter(Boolean),
    ),
  ];
  if (tags.length > 6 || tags.some(tag => tag.length > 16)) throw Error('标签最多 6 个，每个最多 16 字，用逗号分隔。');
  return tags;
}
export function validateStickerFile(file) {
  if (!file.size || file.size > 8 * 1024 * 1024) throw Error('每张图片需大于 0 字节且不超过 8 MB。');
  if (!/\.(gif|png|jpe?g|webp)$/i.test(file.name)) throw Error('请选择 GIF、PNG、JPG 或 WebP 图片。');
}
async function fileBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 16384)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(text);
}
export function createStickerManagerUI({ api, modal, closeModal, escapeHtml: esc, icon, state, renderPage, toast }) {
  let pool,
    query = '',
    generation = 0;
  const thumbnails = new Map();
  const size = bytes =>
    bytes < 1024 * 1024 ? Math.ceil(bytes / 1024) + ' KB' : (bytes / 1024 / 1024).toFixed(1) + ' MB';
  const itemById = id => pool?.items.find(item => item.id === id);
  const requestBody = () => ({ scope: pool.scope, revision: pool.revision });
  function cards() {
    const items = pool.items.filter(item =>
      [item.name, item.description, ...item.tags].join(' ').toLowerCase().includes(query.toLowerCase()),
    );
    return items.length
      ? items
          .map(
            item =>
              `<article class="sticker-card"><button class="sticker-picture" data-sticker-preview="${item.id}" aria-label="预览：${esc(stickerTitle(item))}"><img data-sticker-image="${item.id}" alt="${esc(item.description || item.name)}" width="160" height="160" loading="lazy"><span>${item.animated ? 'GIF 动图' : '静态表情'}</span></button><div class="sticker-card-body"><h3 title="${esc(stickerTitle(item))}">${esc(stickerTitle(item))}</h3><p>${item.manual ? '手动添加' : '聊天收集'}${isGeneratedStickerName(item) ? ' · #' + esc(String(item.id).slice(0, 6)) : ''} · ${item.width} × ${item.height} · ${size(item.bytes)}</p><div class="sticker-tags">${item.tags.map(tag => `<span>${esc(tag)}</span>`).join('') || '<span>可添加标签帮助选图</span>'}</div><div class="sticker-actions"><button class="button small" data-sticker-edit="${item.id}">编辑</button><button class="button small danger" data-sticker-delete="${item.id}" aria-label="删除：${esc(stickerTitle(item))}">删除</button></div></div></article>`,
          )
          .join('')
      : `<div class="sticker-empty">${icon('image')}<strong>${query ? '没有匹配的表情包' : '表情池还是空的'}</strong><p>${query ? '换个名称或标签试试。' : '从本地添加图片，或在允许的聊天中收集表情。'}</p>${query ? '' : '<button class="button primary" data-sticker-import>添加表情包</button>'}</div>`;
  }
  async function page() {
    const loaded = await api('/api/sticker-manager');
    if (pool?.scope !== loaded.scope) thumbnails.clear();
    pool = loaded;
    return `<section class="card sticker-library"><div class="sticker-toolbar"><div><h2>账号共享表情池 <span class="status-tag">${pool.count} / ${pool.limit}</span></h2><p class="card-description">管理当前微信账号的表情，供已允许的好友与群聊选用。</p></div><button class="button primary" data-sticker-import>${icon('plus')}添加表情包</button></div><div class="sticker-help"><p>支持 GIF、PNG、JPG、WebP，每张最多 8 MB。动图保留动画；图片会转换为微信发送所需的 GIF。</p><p>手动添加的表情对所有已允许聊天可用；聊天收集的表情沿用共享开关。满 50 张需先删除；后续自动收集的满池评选仍由 DS 选择保留。${pool.waiting ? ' 当前另有 ' + pool.waiting + ' 张等待评选。' : ''}</p></div><div class="field sticker-search"><label for="sticker-search">查找表情</label><input id="sticker-search" type="search" placeholder="搜索名称、描述或标签" value="${esc(query)}"></div><p id="sticker-feedback" class="card-description" role="status"></p><div class="sticker-grid" id="sticker-grid">${cards()}</div></section>`;
  }
  function mount() {
    const thisGeneration = ++generation;
    let next = 0;
    const images = [...document.querySelectorAll('[data-sticker-image]')];
    const scope = pool?.scope;
    async function run() {
      while (next < images.length && thisGeneration === generation && state.page === 'stickers') {
        const image = images[next++];
        try {
          const id = image.dataset.stickerImage,
            key = scope + ':' + id;
          if (!thumbnails.has(key)) {
            const pending = api('/api/sticker-manager/image?id=' + id + '&scope=' + scope).catch(error => {
              thumbnails.delete(key);
              throw error;
            });
            thumbnails.set(key, pending);
            while (thumbnails.size > 64) thumbnails.delete(thumbnails.keys().next().value);
          }
          const value = await thumbnails.get(key);
          if (thisGeneration === generation && image.isConnected)
            image.src = 'data:' + value.mime + ';base64,' + value.base64;
        } catch {
          if (image.isConnected) {
            image.alt = '预览暂不可用，点击重试';
            const feedback = document.querySelector('#sticker-feedback');
            if (feedback) feedback.textContent = '部分预览暂不可用，可点击图片重试或刷新列表。';
          }
        }
      }
    }
    for (let index = 0; index < 3; index++) void run();
    document.querySelector('#sticker-search')?.addEventListener(
      'input',
      event => {
        query = event.target.value;
        document.querySelector('#sticker-grid').innerHTML = cards();
        mount();
      },
      { once: true },
    );
  }
  function importDialog() {
    if (!pool) return;
    const scope = pool.scope;
    let files = [],
      busy = false;
    modal(
      '添加表情包',
      `<form id="sticker-import-form"><p class="modal-description">添加到当前账号的共享池。当前 ${pool.count}/${pool.limit} 张，手动添加不调用模型。</p><div class="field"><label for="sticker-files">选择本地图片（一次最多 20 张）</label><input id="sticker-files" type="file" accept=".gif,.png,.jpg,.jpeg,.webp" multiple required><small>单张最多 8 MB、最多 64 帧、边长不超过 4096 像素。文件名作为默认描述，添加后可以编辑。</small></div><ul id="sticker-import-results" class="sticker-import-results" aria-live="polite"></ul><p id="sticker-form-error" class="extension-error" role="alert" hidden></p><div class="modal-actions"><button type="button" class="button" data-close>关闭</button><button class="button primary" type="submit">开始添加</button></div></form>`,
      {
        beforeClose: () => {
          if (busy) {
            toast('正在添加图片，请等本次完成。');
            return false;
          }
          return true;
        },
      },
    );
    const form = document.querySelector('#sticker-import-form'),
      input = form.querySelector('#sticker-files'),
      results = form.querySelector('#sticker-import-results'),
      error = form.querySelector('#sticker-form-error');
    input.addEventListener('change', () => {
      files = [...input.files];
      error.hidden = true;
      results.innerHTML = files
        .map(
          (file, index) =>
            `<li data-import-row="${index}"><span>${esc(file.name)}</span><small>待添加 · ${size(file.size)}</small></li>`,
        )
        .join('');
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      error.hidden = true;
      try {
        if (!files.length || files.length > 20) throw Error('请选择 1–20 张图片。');
        for (const file of files) validateStickerFile(file);
      } catch (cause) {
        error.textContent = cause.message;
        error.hidden = false;
        return;
      }
      busy = true;
      input.disabled = true;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      let added = 0;
      for (let index = 0; index < files.length; index++) {
        const file = files[index],
          row = results.querySelector(`[data-import-row="${index}"] small`);
        row.textContent = '正在校验并添加…';
        try {
          if (pool.scope !== scope) throw Error('微信账号已切换，请重新打开添加窗口。');
          const name = file.name.replace(/[\x00-\x1f/\\]/g, '').slice(0, 120) || '本地表情';
          pool = await api('/api/sticker-manager/import', {
            ...requestBody(),
            name,
            description: name.replace(/\.[^.]+$/, ''),
            tags: [],
            base64: await fileBase64(file),
          });
          row.textContent = '已添加（重复图片自动合并）';
          added++;
        } catch (cause) {
          row.textContent = '未添加：' + cause.message;
          if (cause.status === 409 || !cause.status) {
            error.textContent = '本次已暂停；已添加的图片已保存，未处理的图片可稍后重新选择。';
            error.hidden = false;
            break;
          }
        }
      }
      busy = false;
      input.disabled = false;
      submit.disabled = false;
      submit.textContent = '重新选择后添加';
      files = [];
      input.value = '';
      if (added) toast('已处理 ' + added + ' 张表情，重复图片合并。');
      if (state.page === 'stickers') await renderPage();
    });
  }
  function editDialog(id) {
    const item = itemById(id);
    if (!item) return;
    const binding = requestBody();
    let busy = false;
    modal(
      '编辑表情信息',
      `<form id="sticker-edit-form"><div class="field"><label for="sticker-name">名称</label><input id="sticker-name" maxlength="120" required value="${esc(item.name)}"></div><div class="field"><label for="sticker-description">内容描述</label><input id="sticker-description" maxlength="120" required value="${esc(item.description || item.name)}"><small>简短描述画面和含义，帮助机器人选择合适的表情。</small></div><div class="field"><label for="sticker-tags">标签</label><input id="sticker-tags" value="${esc(item.tags.join('，'))}" placeholder="开心，赞同，打招呼"><small>最多 6 个，每个最多 16 字，用逗号分隔。</small></div><p id="sticker-form-error" class="extension-error" role="alert" hidden></p><div class="modal-actions"><button class="button" type="button" data-close>取消</button><button class="button primary" type="submit">保存信息</button></div></form>`,
      { beforeClose: () => !busy },
    );
    const form = document.querySelector('#sticker-edit-form');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      busy = true;
      try {
        pool = await api('/api/sticker-manager/edit', {
          ...binding,
          id,
          name: form.querySelector('#sticker-name').value,
          description: form.querySelector('#sticker-description').value,
          tags: parseStickerTags(form.querySelector('#sticker-tags').value),
        });
        busy = false;
        closeModal();
        await renderPage();
        toast('表情信息已保存。');
      } catch (cause) {
        const error = form.querySelector('#sticker-form-error');
        error.textContent = cause.message;
        error.hidden = false;
      } finally {
        busy = false;
        button.disabled = false;
      }
    });
  }
  function deleteDialog(id) {
    const item = itemById(id);
    if (!item) return;
    const binding = requestBody();
    let busy = false;
    modal(
      '删除这张表情？',
      `<p class="modal-description">将从当前账号的共享池移除“${esc(item.name)}”，其他会话也将无法从池中选用。原始图片和微信聊天记录保留；已经开始发送的消息可能继续完成。</p><p class="card-description">删除后不会因同一图片的自动收集立即回到池子。需要时可手动重新导入。</p><p id="sticker-form-error" class="extension-error" role="alert" hidden></p><div class="modal-actions"><button class="button" data-close>取消</button><button class="button danger" id="sticker-confirm-delete">确认删除</button></div>`,
      { beforeClose: () => !busy },
    );
    document.querySelector('#sticker-confirm-delete').addEventListener('click', async event => {
      if (busy) return;
      busy = true;
      event.currentTarget.disabled = true;
      try {
        pool = await api('/api/sticker-manager/delete', { ...binding, id });
        busy = false;
        closeModal();
        await renderPage();
        toast('表情已从共享池移除。');
      } catch (cause) {
        busy = false;
        const error = document.querySelector('#sticker-form-error');
        if (error) {
          error.textContent = cause.message;
          error.hidden = false;
        }
        event.target.disabled = false;
      }
    });
  }
  async function preview(id) {
    const item = itemById(id);
    if (!item) return;
    const scope = pool.scope;
    let open = true;
    modal(
      '预览表情',
      `<div class="sticker-full-preview" role="status">正在读取原图…</div><p class="card-description">${esc(item.name)} · ${item.animated ? 'GIF 动图' : '静态表情'}</p>`,
      {
        onClose: () => {
          open = false;
        },
      },
    );
    try {
      const result = await api('/api/sticker-manager/image?id=' + id + '&scope=' + scope + '&animated=1');
      if (open) {
        const target = document.querySelector('.sticker-full-preview');
        target.innerHTML = `<img alt="${esc(item.description || item.name)}" src="data:${result.mime};base64,${result.base64}">`;
      }
    } catch (cause) {
      if (open) document.querySelector('.sticker-full-preview').textContent = cause.message;
    }
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-sticker-import')) importDialog();
    if (button.dataset.stickerEdit) editDialog(button.dataset.stickerEdit);
    if (button.dataset.stickerDelete) deleteDialog(button.dataset.stickerDelete);
    if (button.dataset.stickerPreview) void preview(button.dataset.stickerPreview);
  });
  return { page, mount };
}
